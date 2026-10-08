import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { SessionCookieConfig } from "../config/environment.js";
import type { SubmittedLegalAcceptance } from "../helpers/legalAcceptance.js";
import { authenticationRequired } from "../services/identity/sessionErrors.js";
import { authenticationFailed } from "../services/identity/signInService.js";

/** Exactly `SignUpInput` from the accepted OpenAPI contract. */
export interface SignUpBody {
  readonly email: string;
  readonly password: string;
  readonly workspace_name?: string;
  readonly legal_acceptances: readonly SubmittedLegalAcceptance[];
}

const ACCEPTED_BODY = Object.freeze({
  accepted: true,
  message: "Account request accepted. Sign in to continue.",
});

export async function signUp(
  request: FastifyRequest<{ Body: SignUpBody }>,
  reply: FastifyReply,
): Promise<void> {
  const idempotencyKey = request.headers["idempotency-key"];
  const body = request.body;

  await request.server.signupService.submit({
    email: body.email,
    password: body.password,
    ...(body.workspace_name === undefined ? {} : { workspaceName: body.workspace_name }),
    legalAcceptances: body.legal_acceptances,
    idempotencyKey: idempotencyKey as string,
    requestId: request.traceId,
  });

  // New identities and accepted replays use 202. The service maps a recorded
  // duplicate-account rejection to the owner's explicit 409 response.
  await reply.status(202).send(ACCEPTED_BODY);
}

/** Exactly `SignInInput` from the accepted OpenAPI contract. */
export interface SignInBody {
  readonly email: string;
  readonly password: string;
}

/**
 * `audit_events.ip_fingerprint` is `bytea`, matching
 * `legal_acceptances.ip_fingerprint`. A fingerprint is stored, never the
 * address itself.
 */
function ipFingerprint(ip: string | undefined): Buffer | null {
  return ip === undefined || ip === "" ? null : createHash("sha256").update(ip, "utf8").digest();
}

function setRefreshCookie(
  reply: FastifyReply,
  cookie: SessionCookieConfig,
  refreshToken: string,
  refreshExpiresAt: Date,
): void {
  reply.setCookie(cookie.name, refreshToken, {
    httpOnly: true,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
    path: cookie.path,
    ...(cookie.domain === undefined ? {} : { domain: cookie.domain }),
    expires: refreshExpiresAt,
  });
}

function clearRefreshCookie(reply: FastifyReply, cookie: SessionCookieConfig): void {
  reply.clearCookie(cookie.name, {
    httpOnly: true,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
    path: cookie.path,
    maxAge: 0,
    ...(cookie.domain === undefined ? {} : { domain: cookie.domain }),
  });
}

export async function signIn(
  request: FastifyRequest<{ Body: SignInBody }>,
  reply: FastifyReply,
): Promise<void> {
  // The operation declares 400 for parser/framing failures, but a syntactically
  // valid sign-in body with the wrong shape still answers with the same generic
  // authentication failure as a wrong password. A caller learns no account
  // state from field-level sign-in validation.
  //
  // The route sets attachValidation so the failure arrives here rather than
  // reaching the shared handler, which owns only parser/framing failures here.
  if (request.validationError !== undefined) {
    throw authenticationFailed();
  }

  const result = await request.server.signInService.authenticate({
    email: request.body.email,
    password: request.body.password,
    requestId: request.traceId,
    ipFingerprint: ipFingerprint(request.ip),
  });

  setRefreshCookie(
    reply,
    request.server.sessionCookie,
    result.refreshToken,
    result.refreshExpiresAt,
  );

  // The refresh token is never a JSON field. AuthSession carries exactly four.
  await reply.status(200).send({
    access_token: result.accessToken,
    token_type: "Bearer",
    expires_in: result.expiresInSeconds,
    csrf_token: result.csrfToken,
  });
}

export async function refreshSession(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const cookie = request.server.sessionCookie;
  const csrfHeader = request.headers["x-csrf-token"];
  const result = await request.server.refreshService.refresh({
    refreshToken: request.cookies[cookie.name],
    csrfToken: typeof csrfHeader === "string" ? csrfHeader : undefined,
    requestId: request.traceId,
    ipFingerprint: ipFingerprint(request.ip),
  });

  setRefreshCookie(reply, cookie, result.refreshToken, result.refreshExpiresAt);
  await reply.status(200).send({
    access_token: result.accessToken,
    token_type: "Bearer",
    expires_in: result.expiresInSeconds,
    csrf_token: result.csrfToken,
  });
}

export async function logout(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const identity = request.trustedSessionIdentity;
  if (identity === null) {
    // The route preHandler establishes this value. Keep the controller
    // defensive so a future wiring mistake still fails closed.
    throw authenticationRequired();
  }

  const csrfHeader = request.headers["x-csrf-token"];
  await request.server.logoutService.logout({
    identity,
    csrfToken: typeof csrfHeader === "string" ? csrfHeader : undefined,
    requestId: request.traceId,
    ipFingerprint: ipFingerprint(request.ip),
  });

  clearRefreshCookie(reply, request.server.sessionCookie);
  await reply.status(204).send();
}
