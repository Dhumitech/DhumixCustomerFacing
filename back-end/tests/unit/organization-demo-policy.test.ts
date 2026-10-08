import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createOrganizationWorkflowRepository } from "../../src/services/organizations/organizationWorkflowRepository.js";
import { createOrganizationWorkflowService } from "../../src/services/organizations/organizationWorkflowService.js";

describe("organization demo policy", () => {
  it("rejects a second organization under the user lock before any new workflow or organization is written", async () => {
    const userId = randomUUID();
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      statements.push(sql);
      const rows = sql.includes("has_created") ? [{ has_created: true }]
        : sql.startsWith("SELECT id, email_normalized") ? [{ id: userId, email_normalized: "unit@example.test", state: "active" }]
        : sql.includes("INSERT INTO app.idempotency_records") ? [{ id: randomUUID() }] : [];
      return { rows, rowCount: rows.length };
    });
    const pool = { connect: async () => ({ query, release() {} }) } as unknown as Pool;
    const repository = createOrganizationWorkflowRepository({ identityPool: pool, customerPool: pool, otpSecret: "", publicUrl: "https://demo.example", inviteResendLifetimeDays: 7, demoDisableOtp: true });
    await expect(repository.run("createOrganization", { userId, body: { name: "Second" }, key: "unit.second.organization", traceId: randomUUID() }))
      .rejects.toMatchObject({ status: 409, message: "You can create only one organization" });
    expect(statements.findIndex(sql => sql.includes("FOR NO KEY UPDATE"))).toBeLessThan(statements.findIndex(sql => sql.includes("has_created")));
    expect(statements.some(sql => sql.includes("INSERT INTO app.organizations") || sql.includes("INSERT INTO app.email_verifications"))).toBe(false);
    expect(statements.at(-1)).toBe("ROLLBACK");
  });

  it.each(["acceptInvite", "listInvites", "createInvite", "resendInvite", "revokeInvite", "changeMember", "removeMember"] as const)("blocks deferred collaboration without calling persistence: %s", async action => {
    const run = vi.fn(async () => ({ response: {} }));
    const service = createOrganizationWorkflowService({ repository: { run }, collaborationEnabled: false,
      passwordHasher: { hash: async () => "hash", verify: async () => true, needsRehash: () => false },
      csrf: { issue: () => "csrf", verify: () => true }, email: { close() {}, send: async () => "accepted" }, recordDelivery() {} });
    await expect(service.run(action, { body: {}, key: "unit.collaboration.key", traceId: randomUUID() }, { userId: randomUUID(), sessionId: randomUUID() }, "csrf"))
      .rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });
    expect(run).not.toHaveBeenCalled();
  });
});
