import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../../src/config/environment.js";
import { registerOrganizationRoutes } from "../../src/routes/organizationRoutes.js";
import { installAccessSurface } from "../../src/routes/accessSurface.js";
import { createOrganizationWorkflowService } from "../../src/services/organizations/organizationWorkflowService.js";
import { ApplicationError } from "../../src/utils/applicationError.js";

const userId = randomUUID(), sessionId = randomUUID(), verificationId = randomUUID();
async function app() {
  const instance = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  instance.decorateRequest("trustedSessionIdentity", null); instance.decorateRequest("trustedTenantPrincipal", null);
  instance.decorate("browserAuthenticationService", { async authenticate() { return { userId, sessionId }; } });
  instance.decorate("tenantAuthorizationService", { async authorizeBrowserTenant() { return { userId, sessionId, tenantId: randomUUID() }; } });
  const run = vi.fn(async () => ({ accepted: true, verification_id: verificationId }));
  instance.decorate("organizationWorkflowService", { run });
  installAccessSurface(instance);
  const surface: { method: unknown; url: string; access: unknown }[] = [];
  instance.addHook("onRoute", route => { if (route.method !== "HEAD") surface.push({ method: route.method, url: route.url, access: route.config?.access }); });
  await registerOrganizationRoutes(instance, { frontendOrigin: "https://dhumi.example", signupRateLimit: { max: 5, windowMs: 60_000 } } as RuntimeConfig);
  await instance.ready(); return { instance, run, surface };
}
describe("0071 registered organization HTTP routes", () => {
  it("declares all thirteen actual routes with purpose/member/admin access", async () => {
    const { instance, surface } = await app();
    try {
      expect(surface).toHaveLength(13);
      expect(surface.find(route => route.method === "PATCH")?.access).toBe("organization_admin");
      expect(surface.find(route => route.url.endsWith("/confirm"))?.access).toBe("purpose_bound_verification");
      expect(surface.find(route => route.url === "/v1/organizations" && route.method === "GET")?.access).toBe("browser_session");
    } finally { await instance.close(); }
  });
  it.each([
    { code: "123456", email_link_token: "t".repeat(43) },
    { new_password: "unit-sufficiently-long-password" },
    { code: "123456", user_id: userId },
  ])("rejects ambiguous/missing proof and caller-selected identity: %j", async payload => {
    const { instance, run } = await app();
    try {
      const response = await instance.inject({ method: "POST", url: `/v1/verifications/${verificationId}/confirm`, headers: { "idempotency-key": "unit-route-key-123" }, payload });
      expect(response.statusCode).toBe(400); expect(run).not.toHaveBeenCalled();
    } finally { await instance.close(); }
  });
  it("does not consume a challenge by GET, link scanner or page preview", async () => {
    const { instance, run } = await app();
    try { expect((await instance.inject({ method: "GET", url: `/v1/verifications/${verificationId}/confirm` })).statusCode).toBe(404); expect(run).not.toHaveBeenCalled(); }
    finally { await instance.close(); }
  });
  it("refuses a browser mutation from another origin before calling persistence", async () => {
    const { instance, run } = await app();
    try { const response = await instance.inject({ method: "POST", url: "/v1/auth/password-reset", headers: { "idempotency-key": "unit-route-key-123", origin: "https://other.example" }, payload: { email: "user@example.test" } }); expect(response.statusCode).toBe(403); expect(run).not.toHaveBeenCalled(); }
    finally { await instance.close(); }
  });
  it("binds authenticated session and CSRF separately from the JSON body", async () => {
    const { instance, run } = await app();
    try {
      expect((await instance.inject({ method: "POST", url: "/v1/organizations", headers: { authorization: "Bearer unit-token", "x-csrf-token": "unit-csrf", "idempotency-key": "unit-route-key-123" }, payload: { name: "Unit organization" } })).statusCode).toBe(202);
      expect(run).toHaveBeenCalledWith("createOrganization", expect.objectContaining({ body: { name: "Unit organization" } }), { userId, sessionId }, "unit-csrf");
    } finally { await instance.close(); }
  });
  it("resends with the Target's 202 and no caller-selected expiry field", async () => {
    const { instance, run } = await app();
    const inviteId = randomUUID();
    run.mockResolvedValueOnce({ invite: { id: inviteId, email: null, role: "member", max_uses: null,
      use_count: 0, expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(), revoked_at: null,
      created_at: new Date().toISOString() }, join_code: "t".repeat(43) } as unknown as Awaited<ReturnType<typeof run>>);
    try {
      const headers = { authorization: "Bearer unit-token", "x-csrf-token": "unit-csrf", "idempotency-key": "unit-resend-key-123" };
      const url = `/v1/organization/invites/${inviteId}/resend`;
      const response = await instance.inject({ method: "POST", url, headers, payload: {} });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ invite: { id: inviteId }, join_code: "t".repeat(43) });
      expect(run).toHaveBeenCalledWith("resendInvite", expect.objectContaining({ targetId: inviteId, body: {} }), { userId, sessionId }, "unit-csrf");
      run.mockClear();
      expect((await instance.inject({ method: "POST", url, headers, payload: { expires_at: new Date().toISOString() } })).statusCode).toBe(400);
      expect(run).not.toHaveBeenCalled();
    } finally { await instance.close(); }
  });
});
describe("0071 workflow service gates", () => {
  const repository = { run: vi.fn(async () => ({ response: {} })) };
  const service = () => createOrganizationWorkflowService({ repository, passwordHasher: { hash: async () => "encoded", verify: async () => true, needsRehash: () => false }, csrf: { issue: () => "expected", verify: (_session, value) => value === "expected" }, email: { send: async () => "accepted", close() {} }, recordDelivery() {} });
  it("requires CSRF on a signed-in create/join confirmation before persistence", async () => {
    repository.run.mockClear();
    await expect(service().run("confirmVerification", { body: { code: "123456" }, key: "unit-route-key-123", traceId: randomUUID(), verificationId }, { userId, sessionId }, "wrong")).rejects.toMatchObject({ status: 403 });
    expect(repository.run).not.toHaveBeenCalled();
  });
  it("throws a committed failure outcome without sending email", async () => {
    const send = vi.fn(); const recordDelivery = vi.fn();
    const failure = new ApplicationError({ status: 409, code: "STATE_CONFLICT", title: "Invalid proof" });
    const configured = createOrganizationWorkflowService({ repository: { run: async () => ({ response: {}, failure }) }, passwordHasher: { hash: async () => "encoded", verify: async () => true, needsRehash: () => false }, csrf: { issue: () => "expected", verify: () => true }, email: { send, close() {} }, recordDelivery });
    await expect(configured.run("confirmVerification", { body: { code: "123456" }, key: "unit-route-key-123", traceId: randomUUID() }, null)).rejects.toBe(failure);
    expect(send).not.toHaveBeenCalled(); expect(recordDelivery).not.toHaveBeenCalled();
  });
});
