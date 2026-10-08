import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createRestoreSessionService } from "../../src/services/identity/restoreSessionService.js";

function fixture(active = true) {
  const id = randomUUID(), userId = randomUUID();
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes("FROM app.auth_refresh_tokens") && active ? [{ id, user_id: userId, email_normalized: "unit@example.test" }] : [], rowCount: 0 }));
  const issue = vi.fn(async () => ({ token: "access", expiresInSeconds: 300 }));
  const service = createRestoreSessionService({ pool: { connect: async () => ({ query, release() {} }) } as unknown as Pool,
    accessTokens: { issue, verify: vi.fn() }, csrf: { issue: () => "csrf", verify: () => true }, refreshTokens: { hash: () => Buffer.alloc(32), generate: () => "unused", matches: () => true } });
  return { service, query, issue, id, userId };
}
describe("read-only browser session bootstrap", () => {
  it.each([undefined, "bad", "x".repeat(44)])("rejects malformed cookie before querying: %s", async token => {
    const test = fixture(); await expect(test.service.restore(token)).rejects.toMatchObject({ status: 401 }); expect(test.query).not.toHaveBeenCalled();
  });
  it("requires an active token, unexpired active session and active user without writing or rotating", async () => {
    const test = fixture(); const result = await test.service.restore("t".repeat(43));
    expect(result).toEqual({ accessToken: "access", expiresInSeconds: 300, csrfToken: "csrf", identityEmail: "unit@example.test" });
    expect(test.issue).toHaveBeenCalledWith({ userId: test.userId, sessionId: test.id });
    const sql = test.query.mock.calls.map(call => call[0]).join("\n");
    expect(sql).toContain("t.state = 'active'"); expect(sql).toContain("s.expires_at > clock_timestamp()"); expect(sql).toContain("u.state = 'active'");
    expect(sql).not.toMatch(/INSERT|UPDATE|DELETE|FOR UPDATE/);
    expect(result).not.toHaveProperty("refreshToken");
  });
  it("rejects absent, expired, rotated or revoked families without minting access", async () => {
    const test = fixture(false); await expect(test.service.restore("t".repeat(43))).rejects.toMatchObject({ status: 401 }); expect(test.issue).not.toHaveBeenCalled();
  });
});
