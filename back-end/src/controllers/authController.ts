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
  readonly workspace_name: string;
  readonly legal_acceptances: readonly SubmittedLegalAcceptance[];
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * `app.create_signup` takes `p_request_id uuid`, but a caller-supplied
 * `X-Request-ID` only has to match `^[A-Za-z0-9._:-]{8,128}$`. Passing a
 * non-UUID correlation ID to a `uuid` parameter raises `22P02`, so anything
 * that is not a UUID is recorded as NULL in the audit row while still being
 * echoed to the caller and used in logs.
 */
function databaseRequestId(requestId: string): string | null {
  return UUID_PATTERN.test(requestId) ? requestId : null;
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
    workspaceName: body.workspace_name,
    legalAcceptances: body.legal_acceptances,
    idempotencyKey: idempotencyKey as string,
    requestId: databaseRequestId(request.id),
  });

  // One response for every accepted outcome: a new identity, an existing
  // email, a replay and an in-progress duplicate. Any difference in status,
  // headers or body would disclose whether the address is registered.
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

/**
 * Coarse, non-identifying device facts only. `DiagramsDatavase.md` describes
 * auth_sessions as holding safe device metadata.
 *
 * A truncated user-agent string is **not** a family: the first 32 characters of
 * a real user agent still carry build and platform detail, which is exactly the
 * identifying material this column must not accumulate. Only the leading
 * product token is kept, restricted to a conservative character set, and the
 * full value survives solely as a hash for correlating sessions.
 */
function deviceMetadata(userAgent: string | undefined): Record<string, unknown> {
  if (userAgent === undefined || userAgent === "") {
    return {};
  }

  const leadingProduct = /^([A-Za-z][A-Za-z0-9.-]{0,23})/.exec(userAgent);

  return {
    user_agent_family: leadingProduct?.[1] ?? "unknown",
    user_agent_fingerprint: createHash("sha256")
      .update(userAgent, "utf8")
      .digest("hex")
      .slice(0, 32),
  };
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
    requestId: databaseRequestId(request.id),
    ipFingerprint: ipFingerprint(request.ip),
    deviceMetadata: deviceMetadata(request.headers["user-agent"]),
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
    requestId: databaseRequestId(request.id),
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
    requestId: databaseRequestId(request.id),
    ipFingerprint: ipFingerprint(request.ip),
  });

  clearRefreshCookie(reply, request.server.sessionCookie);
  await reply.status(204).send();
}
