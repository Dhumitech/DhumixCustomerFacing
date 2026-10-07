import type { FastifyInstance, FastifyRequest, RouteHandlerMethod } from "fastify";
import type { RuntimeConfig } from "../config/environment.js";
import { requireBrowserSession } from "../middleware/browserAuthentication.js";
import { requireTenantPrincipal } from "../middleware/tenantPrincipal.js";
import { ApplicationError } from "../utils/applicationError.js";
import type { OrganizationAction } from "../services/organizations/organizationWorkflowRepository.js";

const string = { type: "string", minLength: 1 } as const;
const uuid = { type: "string", format: "uuid" } as const;
const email = { type: "string", format: "email", maxLength: 320 } as const;
const role = { type: "string", enum: ["member", "admin"] } as const;
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", additionalProperties: false, properties, required });
const headers = { type: "object", required: ["idempotency-key"], properties: { "idempotency-key": { type: "string", minLength: 16, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" } } };
const confirm = { ...object({ code: { type: "string", pattern: "^[0-9]{6}$" }, email_link_token: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" }, new_password: { type: "string", minLength: 12, maxLength: 256 } }), oneOf: [{ required: ["code"] }, { required: ["email_link_token"] }] };
const join = { ...object({ join_code: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" }, invite_token: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" } }), oneOf: [{ required: ["join_code"] }, { required: ["invite_token"] }] };
async function optionalSession(request: FastifyRequest): Promise<void> {
  if (request.headers.authorization) await requireBrowserSession(request);
}
export async function registerOrganizationRoutes(app: FastifyInstance, config: RuntimeConfig): Promise<void> {
  const time = { type: "string", format: "date-time" };
  const accepted = object({ accepted: { const: true }, verification_id: uuid, message: string }, ["accepted", "verification_id"]);
  const confirmed = object({ confirmed: { const: true }, organization_id: uuid, sign_in_required: { type: "boolean" } }, ["confirmed"]);
  const completed = object({ completed: { const: true } }, ["completed"]);
  const organization = object({ id: uuid, name: string, state: { const: "active" }, role }, ["id", "name", "state", "role"]);
  const member = object({ user_id: uuid, email, role, state: { type: "string", enum: ["active", "removed"] }, created_at: time, is_creator: { type: "boolean" } }, ["user_id", "email", "role", "state", "created_at", "is_creator"]);
  const invite = object({ id: uuid, email: { type: ["string", "null"] }, role, max_uses: { type: ["integer", "null"] }, use_count: { type: "integer" }, expires_at: time, revoked_at: { type: ["string", "null"], format: "date-time" }, created_at: time }, ["id", "email", "role", "max_uses", "use_count", "expires_at", "revoked_at", "created_at"]);
  const minted = object({ invite, invite_token: string, invite_url: string, join_code: string, message: string }, ["invite"]);
  const responses: Record<string, { status: number; schema: unknown }> = {
    "GET /v1/organizations": { status: 200, schema: object({ organizations: { type: "array", items: organization } }, ["organizations"]) },
    "POST /v1/organizations": { status: 202, schema: accepted },
    "POST /v1/invites/accept": { status: 202, schema: accepted },
    "POST /v1/auth/password-reset": { status: 202, schema: accepted },
    "POST /v1/verifications/:verification_id/confirm": { status: 200, schema: confirmed },
    "POST /v1/verifications/:verification_id/resend": { status: 202, schema: accepted },
    "GET /v1/organization/members": { status: 200, schema: object({ members: { type: "array", items: member } }, ["members"]) },
    "PATCH /v1/organization/members/:user_id": { status: 200, schema: completed },
    "GET /v1/organization/invites": { status: 200, schema: object({ invites: { type: "array", items: invite } }, ["invites"]) },
    "POST /v1/organization/invites": { status: 201, schema: minted },
    "POST /v1/organization/invites/:invite_id/resend": { status: 202, schema: minted },
  };
  app.addHook("onRoute", route => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      const response = responses[`${method === "HEAD" ? "GET" : method} ${route.url}`];
      if (response) route.schema = { ...route.schema, response: { [response.status]: response.schema } };
    }
  });
  function handler(action: OrganizationAction, status = 200): RouteHandlerMethod {
    return async (request, reply) => {
      // Public reset/proof mutations must originate from the configured browser.
      // CLI calls without Origin remain possible; browser cross-site origins fail.
      if (request.headers.origin && request.headers.origin !== config.frontendOrigin)
        throw new ApplicationError({ status: 403, code: "ACCESS_DENIED", title: "Origin denied" });
      const params = request.params as Record<string, string>;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const key = request.headers["idempotency-key"];
      const csrf = request.headers["x-csrf-token"];
      const result = await app.organizationWorkflowService.run(action, {
        ...(request.trustedTenantPrincipal ? { organizationId: request.trustedTenantPrincipal.tenantId } : {}),
        ...(params?.verification_id ? { verificationId: params.verification_id } : {}),
        ...(params?.user_id || params?.invite_id ? { targetId: (params.user_id ?? params.invite_id)! } : {}),
        body, key: typeof key === "string" ? key : "", traceId: request.traceId,
      }, request.trustedSessionIdentity, typeof csrf === "string" ? csrf : undefined);
      await reply.status(status).send(status === 204 ? undefined : result);
    };
  }
  const rateLimit = { max: config.signupRateLimit.max, timeWindow: config.signupRateLimit.windowMs };
  const mutation = (body?: unknown, params?: Record<string, unknown>) => ({
    schema: { headers, ...(body ? { body } : {}), ...(params ? { params: object(params, Object.keys(params)) } : {}) }, config: { rateLimit },
  });
  app.get("/v1/organizations", { preHandler: requireBrowserSession, handler: handler("listOrganizations") });
  app.post("/v1/organizations", { ...mutation(object({ name: { ...string, maxLength: 120, pattern: "\\S" } }, ["name"])), preHandler: requireBrowserSession, handler: handler("createOrganization", 202) });
  app.post("/v1/invites/accept", { ...mutation(join), preHandler: requireBrowserSession, handler: handler("acceptInvite", 202) });
  app.post("/v1/auth/password-reset", { ...mutation(object({ email }, ["email"])), preHandler: optionalSession, handler: handler("passwordReset", 202) });
  app.post("/v1/verifications/:verification_id/confirm", { ...mutation(confirm, { verification_id: uuid }), preHandler: optionalSession, handler: handler("confirmVerification") });
  app.post("/v1/verifications/:verification_id/resend", { ...mutation(object({}), { verification_id: uuid }), preHandler: optionalSession, handler: handler("resendVerification", 202) });
  app.get("/v1/organization/members", { preHandler: [requireTenantPrincipal()], handler: handler("listMembers") });
  app.patch("/v1/organization/members/:user_id", { ...mutation(object({ role }, ["role"]), { user_id: uuid }), preHandler: [requireTenantPrincipal()], handler: handler("changeMember") });
  app.delete("/v1/organization/members/:user_id", { ...mutation(undefined, { user_id: uuid }), preHandler: [requireTenantPrincipal()], handler: handler("removeMember", 204) });
  app.get("/v1/organization/invites", { preHandler: [requireTenantPrincipal()], handler: handler("listInvites") });
  app.post("/v1/organization/invites", { ...mutation(object({ email, role, max_uses: { type: ["integer", "null"], minimum: 1 }, expires_at: { type: "string", format: "date-time" } }, ["expires_at"])), preHandler: [requireTenantPrincipal()], handler: handler("createInvite", 201) });
  app.delete("/v1/organization/invites/:invite_id", { ...mutation(undefined, { invite_id: uuid }), preHandler: [requireTenantPrincipal()], handler: handler("revokeInvite", 204) });
  app.post("/v1/organization/invites/:invite_id/resend", { ...mutation(object({}), { invite_id: uuid }), preHandler: [requireTenantPrincipal()], handler: handler("resendInvite", 202) });
}
