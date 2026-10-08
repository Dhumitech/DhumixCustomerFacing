import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { loadOrganizationWorkflowConfig } from "../../src/config/organizationEnvironment.js";
import { createOrganizationWorkflowRepository } from "../../src/services/organizations/organizationWorkflowRepository.js";
import { createOrganizationWorkflowService } from "../../src/services/organizations/organizationWorkflowService.js";
import { digest } from "../../src/services/organizations/organizationSecurity.js";

const userId = randomUUID(), orgId = randomUUID(), inviteId = randomUUID();
const user = { id: userId, email_normalized: "demo@example.test", state: "active" };
const token = "t".repeat(43);
type Call = { sql: string; values: readonly unknown[] };
function fixture(inviteOverrides: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    calls.push({ sql, values });
    const rows = sql.startsWith("SELECT id, email_normalized") ? [user]
      : sql.includes("INSERT INTO app.idempotency_records") ? [{ id: randomUUID() }]
      : sql.startsWith("SELECT id FROM app.organizations") ? [{ id: orgId }]
      : sql.includes("FROM app.organization_invites") ? [{ id: inviteId, organization_id: orgId, email: user.email_normalized, token_hash: digest(token), role: "member", max_uses: 1, use_count: 0, usable: true, ...inviteOverrides }]
      : sql.includes(" AS fresh") ? [{ fresh: true }] : [];
    return { rows, rowCount: rows.length };
  });
  const pool = { connect: async () => ({ query, release: vi.fn() }) } as unknown as Pool;
  const repository = createOrganizationWorkflowRepository({ identityPool: pool, customerPool: pool, otpSecret: "", publicUrl: "https://demo.example", inviteResendLifetimeDays: 7, demoDisableOtp: true });
  return { calls, repository };
}
const request = (body: Record<string, unknown>) => ({ userId, body, key: "demo.workflow.unit-key", traceId: randomUUID() });

describe("explicit no-OTP demo", () => {
  it("requires the explicit switch and keeps normal OTP configuration required", () => {
    expect(() => loadOrganizationWorkflowConfig({ NODE_ENV: "test" })).toThrow("OTP_SECRET");
    expect(loadOrganizationWorkflowConfig({ NODE_ENV: "test", DEMO_DISABLE_OTP: "true", FRONTEND_ORIGIN: "http://localhost:5173" }))
      .toEqual({ demoDisableOtp: true, publicUrl: "http://localhost:5173" });
  });
  it.each([{ NODE_ENV: "production" }, { APP_ENVIRONMENT: "production" }])("rejects production bypass %j", mode => {
    expect(() => loadOrganizationWorkflowConfig({ ...mode, DEMO_DISABLE_OTP: "true" })).toThrow("non-production");
  });
  it("rejects malformed switches and unsafe share-link origins", () => {
    expect(() => loadOrganizationWorkflowConfig({ DEMO_DISABLE_OTP: "yes" })).toThrow("true or false");
    expect(() => loadOrganizationWorkflowConfig({ DEMO_DISABLE_OTP: "true", APP_PUBLIC_URL: "http://demo.example" })).toThrow("trusted");
  });
  it("creates the organization immediately, consumes its RLS receipt, and never claims mailbox ownership", async () => {
    const db = fixture(); const result = await db.repository.run("createOrganization", request({ name: "Demo team" }));
    expect(result.response).toMatchObject({ confirmed: true, verification_skipped: true, organization_id: expect.any(String) });
    expect(result.mail).toBeUndefined();
    expect(db.calls.some(c => c.sql.includes("INSERT INTO app.organizations"))).toBe(true);
    expect(db.calls.some(c => c.sql.includes("UPDATE app.users SET email_verified_at"))).toBe(false);
    const receipt = db.calls.find(c => c.sql.includes("INSERT INTO app.email_verifications"))!;
    expect(JSON.parse(String(receipt.values[4]))).toMatchObject({ demo_without_otp: true });
    expect(db.calls.some(c => c.sql.includes("SET consumed_at") && c.values[0] === receipt.values[0])).toBe(true);
    expect(db.calls.find(c => c.sql.includes("INSERT INTO app.audit_events"))?.values[2]).toBe("organization.created.demo_without_otp");
    expect(db.calls.at(-1)?.sql).toBe("COMMIT");
  });
  it("joins with a valid invitation and keeps organization/member/invite lock order and use counting", async () => {
    const db = fixture(); const result = await db.repository.run("acceptInvite", request({ invite_token: token }));
    expect(result.response).toMatchObject({ organization_id: orgId, verification_skipped: true });
    const lockedOrg = db.calls.findIndex(c => c.sql.includes("FROM app.organizations") && c.sql.includes("FOR UPDATE"));
    const members = db.calls.findIndex(c => c.sql.includes("FROM app.organization_members") && c.sql.includes("FOR UPDATE"));
    const invite = db.calls.findIndex(c => c.sql.includes("FROM app.organization_invites") && c.sql.includes("FOR UPDATE"));
    expect(lockedOrg).toBeLessThan(members); expect(members).toBeLessThan(invite);
    expect(db.calls.filter(c => c.sql.includes("use_count = use_count + 1"))).toHaveLength(1);
    expect(result.mail).toBeUndefined();
  });
  it.each([{ email: "another@example.test" }, { usable: false }])("still refuses an unauthorized/unusable invite %j", async invalid => {
    const db = fixture(invalid);
    await expect(db.repository.run("acceptInvite", request({ invite_token: token }))).rejects.toThrow("Invitation unavailable");
    expect(db.calls.some(c => c.sql.includes("INSERT INTO app.organization_members"))).toBe(false);
    expect(db.calls.at(-1)?.sql).toBe("ROLLBACK");
  });
  it.each(["passwordReset", "confirmVerification", "resendVerification"] as const)("never bypasses account recovery through %s", async action => {
    const db = fixture(); await expect(db.repository.run(action, request({ email: user.email_normalized }))).rejects.toThrow("unavailable");
    expect(db.calls).toHaveLength(0);
  });
  it("retains authentication and CSRF checks before demo work", async () => {
    const repository = { run: vi.fn() };
    const service = createOrganizationWorkflowService({ repository, demoDisableOtp: true,
      passwordHasher: { hash: async () => "hash", verify: async () => true, needsRehash: () => false },
      csrf: { issue: () => "csrf", verify: () => false }, email: { send: vi.fn(), close() {} }, recordDelivery: vi.fn() });
    await expect(service.run("createOrganization", request({ name: "Demo" }), null)).rejects.toMatchObject({ status: 401 });
    await expect(service.run("createOrganization", request({ name: "Demo" }), { userId, sessionId: randomUUID() }, "bad"))
      .rejects.toMatchObject({ status: 403 });
    expect(repository.run).not.toHaveBeenCalled();
  });
});
