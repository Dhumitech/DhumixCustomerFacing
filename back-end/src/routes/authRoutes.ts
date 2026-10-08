import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { logout, refreshSession, signIn, signUp } from "../controllers/authController.js";
import type { SignInBody, SignUpBody } from "../controllers/authController.js";
import type { RuntimeConfig } from "../config/environment.js";
import { normalizeEmail } from "../helpers/signupCanonicalization.js";
import { requireBrowserSession } from "../middleware/browserAuthentication.js";
import { ApplicationError } from "../utils/applicationError.js";

/**
 * Mirrors `SignUpInput` and `LegalAcceptanceInput` from the accepted OpenAPI
 * contract. Written in dialect-agnostic JSON Schema so it compiles under the
 * Ajv build Fastify ships, rather than requiring the 2020-12 dialect.
 *
 * `additionalProperties: false` is what enforces the contract's rejection of
 * unknown request properties.
 */
const signUpBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["email", "password", "legal_acceptances"],
  properties: {
    email: { type: "string", format: "email", maxLength: 320 },
    password: { type: "string", minLength: 12, maxLength: 256 },
    workspace_name: { type: "string", maxLength: 120 },
    legal_acceptances: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["document_type", "document_version", "content_hash", "accepted"],
        properties: {
          document_type: { type: "string", minLength: 1, maxLength: 64 },
          document_version: { type: "string", minLength: 1, maxLength: 64 },
          content_hash: { type: "string", pattern: "^[A-Fa-f0-9]{64}$" },
          accepted: { const: true },
        },
      },
    },
  },
} as const;

const signUpHeadersSchema = {
  type: "object",
  required: ["idempotency-key"],
  properties: {
    "idempotency-key": {
      type: "string",
      minLength: 16,
      maxLength: 128,
      pattern: "^[A-Za-z0-9._:-]+$",
    },
  },
} as const;

const acceptedResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["accepted", "message"],
  properties: {
    accepted: { type: "boolean", const: true },
    message: { type: "string" },
  },
} as const;

const signInBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["email", "password"],
  properties: {
    email: { type: "string", format: "email", maxLength: 320 },
    password: { type: "string", minLength: 1, maxLength: 256 },
  },
} as const;

const authSessionResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["access_token", "token_type", "expires_in", "csrf_token"],
  properties: {
    access_token: { type: "string" },
    token_type: { type: "string", const: "Bearer" },
    expires_in: { type: "integer", minimum: 1 },
    csrf_token: { type: "string" },
  },
} as const;

export async function registerAuthRoutes(
  app: FastifyInstance,
  config: RuntimeConfig,
): Promise<void> {
  // Two independent dimensions, as the security specification requires "IP and
  // identity rate and abuse controls".
  //
  // The route-level limit below is keyed by IP and runs in onRequest. It caps
  // the Argon2 amplification but cannot see the email, because the body is not
  // parsed yet. This second limit runs as a preHandler, where the body exists,
  // and is keyed by the normalised address so one identity cannot be probed
  // from many source addresses.
  //
  // A combined IP+email key would not work: varying the email from one source
  // would mint a fresh bucket every request and defeat the IP limit.
  const emailRateLimit = app.createRateLimit({
    max: config.signupRateLimit.max,
    timeWindow: config.signupRateLimit.windowMs,
    keyGenerator: (request) => {
      const body = request.body as Partial<SignUpBody> | undefined;
      const email = typeof body?.email === "string" ? body.email : "";
      return `signup-identity:${normalizeEmail(email)}`;
    },
  });

  app.post<{ Body: SignUpBody }>("/v1/auth/signup", {
    schema: {
      body: signUpBodySchema,
      headers: signUpHeadersSchema,
      response: { 202: acceptedResponseSchema },
    },
    config: {
      // Signup is unauthenticated and hashes a password on every request, which
      // costs roughly 22.5 ms on a libuv threadpool thread. Without a limit the
      // endpoint is an amplification vector against the whole API, because
      // sign-in shares that threadpool. Values are demo environment
      // configuration, not an approved platform limit.
      rateLimit: {
        max: config.signupRateLimit.max,
        timeWindow: config.signupRateLimit.windowMs,
      },
    },
    preHandler: async (request, reply) => {
      const result = await emailRateLimit(request);

      // `isAllowed` is typed as a discriminant but is always false in
      // @fastify/rate-limit 11.2.0, even for a request well inside the limit.
      // `isExceeded` is the field that actually reports the decision. Checking
      // `!isAllowed` first narrows the union so `isExceeded` is reachable, and
      // keeps this correct if a later version makes `isAllowed` meaningful.
      if (!result.isAllowed && result.isExceeded) {
        // Not awaited. FastifyReply is thenable, so awaiting it here waits for
        // a response that this hook is about to abandon by throwing.
        reply.header("retry-after", String(result.ttlInSeconds));
        throw new ApplicationError({
          status: 429,
          code: "PLATFORM_CAPACITY_LIMIT",
          title: "Platform capacity limit",
        });
      }
    },
    handler: signUp,
  });

  const signInEmailRateLimit = app.createRateLimit({
    max: config.signInRateLimit.max,
    timeWindow: config.signInRateLimit.windowMs,
    keyGenerator: (request) => {
      const body = request.body as Partial<SignInBody> | undefined;
      const email = typeof body?.email === "string" ? body.email : "";
      return `signin-identity:${normalizeEmail(email)}`;
    },
  });

  app.post<{ Body: SignInBody }>("/v1/auth/sign-in", {
    schema: {
      body: signInBodySchema,
      response: { 200: authSessionResponseSchema },
    },
    // Sign-in declares 400 for parser/framing failures but deliberately maps a
    // syntactically valid body with the wrong shape to the generic 401. Keeping
    // the validation error attached lets the controller preserve that rule.
    attachValidation: true,
    config: {
      // Sign-in verifies a password on every request and shares the libuv
      // threadpool with signup, so this limit comes out of the same hashing
      // budget rather than in addition to it. Demo configuration, unapproved.
      rateLimit: {
        max: config.signInRateLimit.max,
        timeWindow: config.signInRateLimit.windowMs,
      },
    },
    preHandler: async (request, reply) => {
      const result = await signInEmailRateLimit(request);
      if (!result.isAllowed && result.isExceeded) {
        reply.header("retry-after", String(result.ttlInSeconds));
        throw new ApplicationError({
          status: 429,
          code: "PLATFORM_CAPACITY_LIMIT",
          title: "Platform capacity limit",
        });
      }
    },
    handler: signIn,
  });

  const refreshFamilyRateLimit = app.createRateLimit({
    max: config.refreshRateLimit.max,
    timeWindow: config.refreshRateLimit.windowMs,
    keyGenerator: (request) => {
      // Never place a bearer secret in the rate-limit store. The digest is a
      // stable bucket key and cannot be used to replay the cookie.
      const refreshToken = request.cookies[config.session.cookie.name] ?? "missing";
      const fingerprint = createHash("sha256").update(refreshToken, "utf8").digest("hex");
      return `refresh-family:${fingerprint}`;
    },
  });

  app.get("/v1/auth/session", {
    onRequest: async (_request, reply) => {
      reply.header("Cache-Control", "no-store").header("Pragma", "no-cache");
    },
    schema: { response: { 200: { ...authSessionResponseSchema, required: [...authSessionResponseSchema.required, "identity_email"], properties: { ...authSessionResponseSchema.properties, identity_email: { type: "string", format: "email" } } } } },
    config: { rateLimit: { max: config.refreshRateLimit.max, timeWindow: config.refreshRateLimit.windowMs } },
    preHandler: async request => {
      const origin = request.headers.origin;
      if (origin ? origin !== config.frontendOrigin : request.headers["sec-fetch-site"] !== "same-origin")
        throw new ApplicationError({ status: 403, code: "ACCESS_DENIED", title: "Session restoration origin denied" });
      const result = await refreshFamilyRateLimit(request);
      if (!result.isAllowed && result.isExceeded) throw new ApplicationError({ status: 429, code: "PLATFORM_CAPACITY_LIMIT", title: "Too many session requests" });
    },
    handler: async (request, reply) => {
      const result = await app.restoreSessionService.restore(request.cookies[config.session.cookie.name]);
      await reply.send({ access_token: result.accessToken, token_type: "Bearer", expires_in: result.expiresInSeconds, csrf_token: result.csrfToken, identity_email: result.identityEmail });
    },
  });

  app.post("/v1/auth/refresh", {
    schema: {
      response: { 200: authSessionResponseSchema },
    },
    config: {
      // The route-level bucket is by IP. The preHandler bucket below is by a
      // non-secret token fingerprint, so a distributed caller cannot hammer
      // one session while varying source addresses.
      rateLimit: {
        max: config.refreshRateLimit.max,
        timeWindow: config.refreshRateLimit.windowMs,
      },
    },
    preHandler: async (request, reply) => {
      const result = await refreshFamilyRateLimit(request);
      if (!result.isAllowed && result.isExceeded) {
        reply.header("retry-after", String(result.ttlInSeconds));
        throw new ApplicationError({
          status: 429,
          code: "PLATFORM_CAPACITY_LIMIT",
          title: "Platform capacity limit",
        });
      }
    },
    handler: refreshSession,
  });

  app.post("/v1/auth/logout", {
    // No JSON header schema is attached here. Missing/invalid CSRF is a
    // declared 403 business-security outcome, while the shared Fastify schema
    // handler would turn a required-header failure into an undeclared 400.
    preHandler: requireBrowserSession,
    handler: logout,
  });
}
