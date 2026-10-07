import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createOrganizationWorkflowRepository, type WorkflowRequest } from "../../src/services/organizations/organizationWorkflowRepository.js";
import { createOrganizationWorkflowService } from "../../src/services/organizations/organizationWorkflowService.js";
import { codeHash, digest, assertMemberChange } from "../../src/services/organizations/organizationSecurity.js";
import { withOrganizationAdministrationTransaction } from "../../src/services/database/transactions.js";
import { createSignInRepository } from "../../src/services/identity/signInRepository.js";
import { loadOrganizationInviteResendLifetimeDays } from "../../src/config/organizationEnvironment.js";

const userId = randomUUID(), orgId = randomUUID(), verificationId = randomUUID(), inviteId = randomUUID();
const secret = "unit-only-otp-secret-32-bytes-minimum";
const user = { id: userId, email_normalized: "user@example.test", state: "active" };
const request = (body: Record<string, unknown> = {}): WorkflowRequest => ({ userId, verificationId, body, key: "workflow-unit-key-1", traceId: randomUUID() });
type Call = { sql: string; values: readonly unknown[] };
function database(answer: (call: Call) => Record<string, unknown>[] = () => [], proofFresh = true) {
  const calls: Call[] = [];
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    const call = { sql, values }; calls.push(call);
    const rows = sql.includes("AS user_id, set_config") ? [{ user_id: values[0], organization_id: values[1] }]
      : sql.includes(" AS fresh") ? [{ fresh: proofFresh }]
      : sql.startsWith("SELECT id FROM app.users") ? [{ id: userId }]
      : sql.startsWith("SELECT id FROM app.organizations") ? [{ id: orgId }]
      : sql.startsWith("SELECT id, email_normalized, state FROM app.users") ? [user]
      : sql.includes("INSERT INTO app.idempotency_records") ? [{ id: randomUUID() }]
      : answer(call);
    return { rows, rowCount: rows.length };
  });
  const pool = { connect: async () => ({ query, release: vi.fn() }) } as unknown as Pool;
  const repository = createOrganizationWorkflowRepository({ identityPool: pool, customerPool: pool, otpSecret: secret, publicUrl: "https://dhumi.example", inviteResendLifetimeDays: loadOrganizationInviteResendLifetimeDays({}) });
  return { calls, pool, repository };
}
function challenge(overrides: Record<string, unknown> = {}) {
  return { id: verificationId, user_id: userId, purpose: "create_organization", code_hash: codeHash(secret, verificationId, userId, "create_organization", "123456"),
    payload: { organization_name: "Unit organization", email: user.email_normalized, email_link_hash: digest("link-token").toString("hex") }, consumed_at: null, attempt_count: 0, usable: true, ...overrides };
}
describe("0071 organization workflows offline", () => {
  it("creates no organization before proof, stores only hashes and commits before email", async () => {
    const db = database(({ sql }) => sql.includes("count(*)::int AS count") ? [{ count: 0, cooling: false }] : []);
    const order: string[] = [];
    const service = createOrganizationWorkflowService({ repository: { async run(action, input) { const result = await db.repository.run(action, input); order.push(db.calls.at(-1)!.sql); return result; } },
      passwordHasher: { hash: async () => "encoded", verify: async () => true, needsRehash: () => false }, csrf: { issue: () => "csrf", verify: () => true },
      email: { close() {}, async send() { order.push("email"); return "accepted"; } }, recordDelivery: () => {} });
    const result = await service.run("createOrganization", request({ name: "Unit organization" }), { userId, sessionId: randomUUID() }, "csrf");
    expect(result).toMatchObject({ accepted: true }); expect(order).toEqual(["COMMIT", "email"]);
    expect(db.calls.some(c => c.sql.includes("INSERT INTO app.organizations"))).toBe(false);
    const inserted = db.calls.find(c => c.sql.includes("INSERT INTO app.email_verifications"))!;
    expect(inserted.values[3]).toBeInstanceOf(Buffer); expect((inserted.values[3] as Buffer).length).toBe(32);
    expect(JSON.parse(String(inserted.values[4]))).toMatchObject({ email: user.email_normalized });
    expect(inserted.sql).toContain("clock_timestamp() + interval '10 minutes'");
    expect(db.calls.findIndex(c => c.sql.includes("FROM app.users") && c.sql.includes("FOR NO KEY UPDATE"))).toBeLessThan(db.calls.findIndex(c => c.sql.includes("INSERT INTO app.idempotency_records")));
  });
  it.each([{ count: 5, cooling: false }, { count: 1, cooling: true }])("caps issuance across purposes before persistence: %j", async usage => {
    const db = database(({sql}) => sql.includes("count(*)::int AS count") ? [usage] : []);
    await expect(db.repository.run("createOrganization", request({ name: "Unit" }))).rejects.toMatchObject({ status: 429 });
    expect(db.calls.at(-1)?.sql).toBe("ROLLBACK"); expect(db.calls.some(c => c.sql.includes("INSERT INTO app.email_verifications"))).toBe(false);
  });
  it("commits a wrong-code counter before the service rejects it, ending the fifth attempt", async () => {
    const db = database(({ sql }) => sql.includes("FROM app.email_verifications") ? [challenge({ attempt_count: 4 })] : []);
    const result = await db.repository.run("confirmVerification", request({ code: "000000" }));
    expect(result.failure?.status).toBe(409); expect(db.calls.at(-1)?.sql).toBe("COMMIT");
    const update = db.calls.find(c => c.sql.includes("attempt_count = attempt_count + 1"))!;
    expect(update.sql).toContain("attempt_count + 1 >= 5 THEN NULL");
    expect(db.calls.some(c => c.sql.includes("INSERT INTO app.organizations"))).toBe(false);
  });
  it.each([challenge({ usable: false }), challenge({ payload: null, consumed_at: new Date() }), challenge({ payload: { email: "other@example.test", name: "Unit" } })])("rejects expired/consumed/email-mismatched proof", async pending => {
    const db = database(({sql}) => sql.includes("FROM app.email_verifications") ? [pending] : []);
    await expect(db.repository.run("confirmVerification", request({ code: "123456" }))).rejects.toMatchObject({ status: 409 });
    expect(db.calls.at(-1)?.sql).toBe("ROLLBACK");
  });
  it("refuses another session user before locking/mutating the pending account", async () => {
    const db = database(({sql}) => sql.includes("FROM app.email_verifications") ? [challenge({ user_id: randomUUID() })] : []);
    await expect(db.repository.run("confirmVerification", request({ code: "123456" }))).rejects.toMatchObject({ status: 403 });
    expect(db.calls.some(c => c.sql.includes("FROM app.users") && c.sql.includes("FOR UPDATE"))).toBe(false);
  });
  it("confirms create atomically with creator/admin, consumed payload and shared idempotency", async () => {
    const db = database(({sql}) => sql.includes("FROM app.email_verifications") ? [challenge()] : []);
    const result = await db.repository.run("confirmVerification", request({ code: "123456" }));
    expect(result.response).toMatchObject({ confirmed: true });
    const organization = db.calls.find(c => c.sql.includes("INSERT INTO app.organizations"))!;
    expect(organization.values).toEqual([result.response.organization_id, "Unit organization", userId]);
    expect(db.calls.find(c => c.sql.includes("INSERT INTO app.organization_members"))?.sql).toContain("'admin'");
    expect(db.calls.findIndex(c => c.sql.includes("INSERT INTO app.organization_members"))).toBeLessThan(db.calls.findIndex(c => c.sql.includes("SET consumed_at = clock_timestamp(), payload = NULL WHERE id")));
    expect(db.calls.at(-1)?.sql).toBe("COMMIT");
  });
  it("takes an exclusive organization lock before member locks and administration work", async () => {
    const db = database(({sql}) => sql.includes("FROM app.organization_members") ? [{ user_id: userId, role: "admin", state: "active" }] : []);
    await withOrganizationAdministrationTransaction(db.pool, { userId, tenantId: orgId }, async database => { await database.query("UPDATE admin_fixture SET value = 1"); });
    const org = db.calls.findIndex(c => c.sql.includes("FROM app.organizations")), members = db.calls.findIndex(c => c.sql.includes("FROM app.organization_members"));
    expect(db.calls[org]?.sql).toContain("FOR UPDATE"); expect(db.calls[members]?.sql).toContain("ORDER BY user_id FOR UPDATE"); expect(org).toBeLessThan(members);
    expect(db.calls.map(c => c.sql).join("\n")).not.toContain("FOR SHARE");
  });
  it.each(["join_organization", "password_reset"] as const)("keeps purpose-specific fresh proofs: %s", async purpose => {
    const pending = challenge({ purpose, code_hash: codeHash(secret, verificationId, userId, purpose, "123456"),
      payload: { email: user.email_normalized, invite_id: inviteId, organization_id: orgId, invite_token_hash: digest("unit-invite").toString("hex") } });
    const db = database(({sql}) => {
      if(sql.includes("FROM app.email_verifications")) return [pending];
      if(sql.includes("FROM app.organization_members")) return [{ user_id: userId, state: "active", role: "admin" }];
      if(sql.includes("FROM app.organization_invites")) return [{ id: inviteId, organization_id: orgId, email: null, token_hash: digest("unit-invite"), role: "member", max_uses: null, use_count: 2, usable: true }];
      if(sql.includes("FROM app.auth_sessions")) return [{ id: randomUUID() }];
      return [];
    });
    await db.repository.run("confirmVerification", { ...request({ code: "123456" }), passwordHash: "encoded-new-password" });
    if(purpose === "join_organization") {
      expect(db.calls.some(c => c.sql.includes("SET state = 'active', role"))).toBe(false);
      expect(db.calls.some(c => c.sql.includes("use_count = use_count + 1"))).toBe(false);
    } else {
      expect(db.calls.some(c => c.sql.includes("revoked_reason") && c.values.includes("password_reset"))).toBe(true);
      expect(db.calls.some(c => c.sql.includes("WHERE user_id = $1 AND consumed_at IS NULL"))).toBe(true);
    }
    expect(db.calls.at(-1)?.sql).toBe("COMMIT");
  });
  it("rejects an invite rotated after the proof was issued", async () => {
    const db = database(({sql}) => sql.includes("FROM app.email_verifications") ? [challenge({ purpose: "join_organization", code_hash: codeHash(secret, verificationId, userId, "join_organization", "123456"), payload: { email: user.email_normalized, invite_id: inviteId, organization_id: orgId, invite_token_hash: digest("old-token").toString("hex") } })] : sql.includes("FROM app.organization_invites") ? [{ id: inviteId, organization_id: orgId, email: null, token_hash: digest("rotated-token"), usable: true, role: "admin" }] : []);
    await expect(db.repository.run("confirmVerification", request({ code: "123456" }))).rejects.toMatchObject({ status: 409 });
    expect(db.calls.at(-1)?.sql).toBe("ROLLBACK");
  });
  it("refuses proof expiry after waiting for organization/member/invite locks", async () => {
    const db = database(({sql}) => sql.includes("FROM app.email_verifications") ? [challenge({ purpose: "join_organization", code_hash: codeHash(secret, verificationId, userId, "join_organization", "123456"), payload: { email: user.email_normalized, invite_id: inviteId, organization_id: orgId, invite_token_hash: digest("unit-token").toString("hex") } })] : sql.includes("FROM app.organization_invites") ? [{ id: inviteId, organization_id: orgId, email: null, token_hash: digest("unit-token"), usable: true, role: "member" }] : [], false);
    await expect(db.repository.run("confirmVerification", request({ code: "123456" }))).rejects.toMatchObject({ status: 409 });
    expect(db.calls.at(-1)?.sql).toBe("ROLLBACK"); expect(db.calls.some(c => c.sql.includes("INSERT INTO app.organization_members"))).toBe(false);
  });
  it("does not issue a session if reset replaced the verified password", async () => {
    const db = database(({sql}) => sql.includes("FROM app.users") ? [{ state: "active", password_hash: "reset-hash", lock_expired: false }] : []);
    const result = await createSignInRepository(db.pool).createSession({ userId, tokenFamilyHash: Buffer.alloc(32), expiresAt: new Date() },
      { tenantId: null, actorUserId: userId, action: "identity.sign_in", outcome: "accepted", requestId: randomUUID(), ipFingerprint: null },
      { verifiedPasswordHash: "old-hash", allowExpiredLock: false, lockoutWindowMs: 60_000 });
    expect(result.kind).toBe("identity_unavailable"); expect(db.calls.some(c => c.sql.includes("INSERT INTO app.auth_sessions"))).toBe(false);
  });
});
describe("locked member change rules", () => {
  const input = { callerId: userId, creatorId: userId, targetId: userId, targetRole: "admin" as const, activeAdmins: 2, nextRole: "member" as const, remove: false };
  it("permits creator self-demotion with another admin", () => expect(() => assertMemberChange(input)).not.toThrow());
  it("protects the creator against other administrators with the Target's 403", () => {
    expect(() => assertMemberChange({ ...input, callerId: randomUUID() })).toThrow("creator");
    try { assertMemberChange({ ...input, callerId: randomUUID() }); }
    catch (error) { expect(error).toMatchObject({ status: 403, code: "ACCESS_DENIED" }); }
  });
  it.each([true,false])("keeps a last administrator for removal/demotion %s", remove => expect(() => assertMemberChange({ ...input, activeAdmins: 1, remove })).toThrow("retain an administrator"));
});
