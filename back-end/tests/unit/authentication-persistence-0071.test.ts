import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  createSignupRepository,
  type SignupRepositoryInput,
} from "../../src/services/identity/signupRepository.js";
import { createSignInRepository } from "../../src/services/identity/signInRepository.js";
import { createRefreshRepository } from "../../src/services/identity/refreshRepository.js";
import { createLogoutRepository } from "../../src/services/identity/logoutRepository.js";
import { withIdentityUserTransaction } from "../../src/services/database/transactions.js";

const userId = randomUUID();
const sessionId = randomUUID();
const tokenId = randomUUID();
const trace = randomUUID();
const requestHash = Buffer.alloc(32, 1);
const legacyHash = Buffer.alloc(32, 2);
type Call = { sql: string; values: readonly unknown[] };
type Answer = (call: Call) => readonly Record<string, unknown>[];
function database(answer: Answer = () => []) {
  const calls: Call[] = [];
  const release = vi.fn();
  const pool = {
    connect: async () => ({
      release,
      query: async (sql: string, values: readonly unknown[] = []) => {
        const call = { sql, values };
        calls.push(call);
        const rows = answer(call);
        return { rows, rowCount: rows.length };
      },
    }),
  } as unknown as Pool;
  return { pool, calls, release };
}
function claim(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    request_hash: requestHash,
    state: "completed",
    resource_type: "signup_request",
    related_resource_id: userId,
    response_status: 202,
    response_body_reference: "auth-accepted:v2",
    ...overrides,
  };
}
function signupInput(): SignupRepositoryInput {
  return {
    emailNormalized: "auth-refactor@example.test",
    passwordHash: "encoded-password-not-plaintext",
    legalAcceptances: [
      {
        document_type: "terms",
        document_version: "v1",
        document_hash_hex: "a".repeat(64),
        disclosure_version: null,
      },
    ],
    idempotencyKey: "auth-refactor-unit",
    requestHash,
    actorFingerprint: Buffer.alloc(32, 3),
    requestId: trace,
  };
}
function mutations(calls: Call[]) {
  return calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(c.sql));
}
function noOrganizationOrSignupOutbox(calls: Call[]) {
  expect(calls.map((c) => c.sql).join("\n")).not.toMatch(
    /app\.(organizations|organization_members|outbox_events)|app\.create_signup/,
  );
}

describe("0071 user-only signup persistence", () => {
  it("commits user, legal evidence, audit and idempotency together, with no organization or notification", async () => {
    const db = database(({ sql, values }) => {
      if (sql.includes("INSERT INTO app.idempotency_records"))
        return [claim({ state: "in_progress" })];
      if (sql.includes("INSERT INTO app.users")) return [{ id: values[0] }];
      return [];
    });
    const result = await createSignupRepository(db.pool).createSignup(signupInput());
    expect(result).toMatchObject({ kind: "completed", replayed: false });
    expect(result.kind === "completed" && result.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(db.calls.at(-1)?.sql).toBe("COMMIT");
    expect(
      db.calls.find((c) => c.sql.includes("INSERT INTO app.legal_acceptances"))?.values.slice(-1),
    ).toEqual([trace]);
    expect(db.calls.find((c) => c.sql.includes("INSERT INTO app.audit_events"))?.values[0]).toBe(
      "identity.signup",
    );
    noOrganizationOrSignupOutbox(db.calls);
  });
  it("reports an existing email without replacing its password or legal evidence", async () => {
    const db = database(({ sql }) => {
      if (sql.includes("INSERT INTO app.idempotency_records"))
        return [claim({ state: "in_progress" })];
      if (sql.includes("SELECT id FROM app.users")) return [{ id: userId }];
      return [];
    });
    expect(await createSignupRepository(db.pool).createSignup(signupInput())).toEqual({
      kind: "existing",
      replayed: false,
    });
    expect(
      db.calls.find((c) => c.sql.includes("INSERT INTO app.legal_acceptances")),
    ).toBeUndefined();
    expect(db.calls.find((c) => /UPDATE app.users/.test(c.sql))).toBeUndefined();
    expect(db.calls.find((c) => c.sql.includes("INSERT INTO app.audit_events"))?.values).toEqual([
      "identity.signup_existing",
      userId,
      trace,
      "rejected_existing",
    ]);
    expect(db.calls.find((c) => c.sql.includes("SET state = 'completed'"))?.values.slice(2)).toEqual([
      409, "auth-account-exists:v1",
    ]);
    noOrganizationOrSignupOutbox(db.calls);
  });
  it("replays a recorded duplicate-account rejection without identity or audit writes", async () => {
    const db = database(({ sql }) =>
      sql.includes("FROM app.idempotency_records")
        ? [claim({ response_status: 409, response_body_reference: "auth-account-exists:v1", related_resource_id: null })]
        : [],
    );
    expect(await createSignupRepository(db.pool).createSignup(signupInput())).toEqual({
      kind: "existing", replayed: true,
    });
    expect(mutations(db.calls)).toHaveLength(1);
    expect(db.calls.at(-1)?.sql).toBe("COMMIT");
  });
  it("replays a completed claim without user, legal or audit writes", async () => {
    const db = database(({ sql }) =>
      sql.includes("FROM app.idempotency_records") ? [claim()] : [],
    );
    expect(await createSignupRepository(db.pool).createSignup(signupInput())).toEqual({
      kind: "completed",
      userId,
      replayed: true,
    });
    expect(mutations(db.calls)).toHaveLength(1); // Only the concurrency-safe claim attempt.
    expect(db.calls.at(-1)?.sql).toBe("COMMIT");
  });
  it("keeps a historical generic accepted duplicate receipt as 202", async () => {
    const db = database(({ sql }) =>
      sql.includes("FROM app.idempotency_records") ? [claim({ related_resource_id: null })] : [],
    );
    expect(await createSignupRepository(db.pool).createSignup(signupInput())).toEqual({
      kind: "completed", userId: null, replayed: true,
    });
    expect(mutations(db.calls)).toHaveLength(1);
  });
  it("accepts an in-progress duplicate without inventing a success record", async () => {
    const db = database(({ sql }) =>
      sql.includes("FROM app.idempotency_records") ? [claim({ state: "in_progress" })] : [],
    );
    expect(await createSignupRepository(db.pool).createSignup(signupInput())).toEqual({
      kind: "in_progress",
    });
    expect(mutations(db.calls)).toHaveLength(1);
  });
  it("rolls back a canonical-hash conflict with the existing 409", async () => {
    const db = database(({ sql }) =>
      sql.includes("FROM app.idempotency_records") ? [claim({ request_hash: legacyHash })] : [],
    );
    await expect(createSignupRepository(db.pool).createSignup(signupInput())).rejects.toMatchObject(
      { status: 409, code: "IDEMPOTENCY_CONFLICT" },
    );
    expect(db.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(mutations(db.calls)).toHaveLength(1);
  });
  it.each(["tenant", "signup_request"])(
    "replays a completed historical %s claim only with its exact v1 hash",
    async (resourceType) => {
      const db = database(({ sql }) =>
        sql.includes("FROM app.idempotency_records")
          ? [
              claim({
                resource_type: resourceType,
                request_hash: legacyHash,
                response_body_reference: "auth-accepted:v1",
              }),
            ]
          : [],
      );
      await expect(
        createSignupRepository(db.pool).createSignup({
          ...signupInput(),
          legacyRequestHash: legacyHash,
        }),
      ).resolves.toMatchObject({ kind: "completed", replayed: true });
      expect(mutations(db.calls)).toHaveLength(1);
    },
  );
  it("does not use the legacy hash to accept a mismatched pending claim", async () => {
    const db = database(({ sql }) =>
      sql.includes("FROM app.idempotency_records")
        ? [
            claim({
              state: "in_progress",
              resource_type: "tenant",
              request_hash: legacyHash,
              response_body_reference: "auth-accepted:v1",
            }),
          ]
        : [],
    );
    await expect(
      createSignupRepository(db.pool).createSignup({
        ...signupInput(),
        legacyRequestHash: legacyHash,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("rolls back the whole transaction when legal evidence fails", async () => {
    const db = database(({ sql, values }) => {
      if (sql.includes("INSERT INTO app.idempotency_records"))
        return [claim({ state: "in_progress" })];
      if (sql.includes("INSERT INTO app.users")) return [{ id: values[0] }];
      if (sql.includes("INSERT INTO app.legal_acceptances")) throw new Error("legal write failed");
      return [];
    });
    await expect(createSignupRepository(db.pool).createSignup(signupInput())).rejects.toMatchObject(
      { status: 500, code: "INTERNAL_ERROR" },
    );
    expect(db.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(db.calls.some((c) => c.sql.includes("SET state = 'completed'"))).toBe(false);
    expect(db.release).toHaveBeenCalledWith(undefined);
  });
  it.each(["IDEMPOTENCY_CLAIM_NOT_FOUND", "EXISTING_IDENTITY_NOT_FOUND_AFTER_CONFLICT"])(
    "does not report %s as accepted",
    async (message) => {
      const db = database(({ sql }) => {
        if (sql.includes("INSERT INTO app.idempotency_records"))
          throw Object.assign(new Error(message), { code: "55000" });
        return [];
      });
      await expect(
        createSignupRepository(db.pool).createSignup(signupInput()),
      ).rejects.toMatchObject({ status: 500 });
      expect(db.calls.at(-1)?.sql).toBe("ROLLBACK");
    },
  );
  it("maps statement timeout to capacity failure after rollback", async () => {
    const db = database(({ sql }) => {
      if (sql.includes("INSERT INTO app.idempotency_records"))
        throw Object.assign(new Error("timeout"), { code: "57014" });
      return [];
    });
    await expect(createSignupRepository(db.pool).createSignup(signupInput())).rejects.toMatchObject(
      { status: 429, code: "PLATFORM_CAPACITY_LIMIT" },
    );
    expect(db.calls.at(-1)?.sql).toBe("ROLLBACK");
  });
});

const audit = {
  tenantId: null,
  actorUserId: userId,
  action: "identity.sign_in",
  outcome: "accepted",
  requestId: trace,
  ipFingerprint: null,
};
const session = { userId, tokenFamilyHash: requestHash, expiresAt: new Date(Date.now() + 60_000) };
const authorization = { verifiedPasswordHash: "unit-password-hash", allowExpiredLock: false, lockoutWindowMs: 60_000 };
describe("0071 user-only session issuance", () => {
  it("commits a session and first generation without organization reads or removed metadata", async () => {
    const db = database(({ sql }) => {
      if (sql.includes("FROM app.users")) return [{ state: "active", password_hash: "unit-password-hash", lock_expired: false }];
      if (sql.includes("INSERT INTO app.auth_sessions")) return [{ id: sessionId }];
      return [];
    });
    expect(
      await createSignInRepository(db.pool).createSession(session, audit, authorization),
    ).toEqual({ kind: "created", sessionId });
    expect(db.calls.at(-1)?.sql).toBe("COMMIT");
    expect(db.calls.map((c) => c.sql).join("\n")).not.toMatch(
      /app\.(organizations|organization_members)|device_metadata|security_metadata/,
    );
    expect(
      db.calls.find((c) => c.sql.includes("INSERT INTO app.auth_refresh_tokens"))?.sql,
    ).not.toMatch(/generation, state/);
  });
  it.each([
    ["locked", false, false],
    ["locked", true, true],
    ["suspended", false, false],
    ["closed", false, false],
  ] as const)(
    "rechecks %s and PostgreSQL lock expiry before issuing credentials",
    async (state, lockExpired, expected) => {
      const db = database(({ sql }) => {
        if (sql.includes("FROM app.users")) return [{ state, password_hash: "unit-password-hash", lock_expired: lockExpired }];
        if (sql.includes("INSERT INTO app.auth_sessions")) return [{ id: sessionId }];
        return [];
      });
      const outcome = await createSignInRepository(db.pool).createSession(session, audit, {
        ...authorization,
        allowExpiredLock: true,
      });
      expect(outcome.kind).toBe(expected ? "created" : "identity_unavailable");
      expect(db.calls.some((c) => c.sql.includes("INSERT INTO app.auth_sessions"))).toBe(expected);
    },
  );
  it("rolls back session issuance when the generation write fails", async () => {
    const db = database(({ sql }) => {
      if (sql.includes("FROM app.users")) return [{ state: "active", password_hash: "unit-password-hash", lock_expired: false }];
      if (sql.includes("INSERT INTO app.auth_sessions")) return [{ id: sessionId }];
      if (sql.includes("INSERT INTO app.auth_refresh_tokens"))
        throw Error("generation write failed");
      return [];
    });
    await expect(
      createSignInRepository(db.pool).createSession(session, audit, authorization),
    ).rejects.toMatchObject({ status: 500 });
    expect(db.calls.at(-1)?.sql).toBe("ROLLBACK");
  });
});

const rotateInput = {
  expectedSessionId: sessionId,
  presentedTokenHash: requestHash,
  replacementTokenHash: legacyHash,
  requestId: trace,
  ipFingerprint: null,
};
function familyDatabase(tokenState = "active", identityState = "active", expired = false) {
  return database(({ sql }) => {
    if (sql.includes("FROM app.auth_sessions"))
      return [
        {
          session_id: sessionId,
          user_id: userId,
          session_state: "active",
          state: "active",
          expires_at: session.expiresAt,
          is_expired: expired,
        },
      ];
    if (sql.includes("FROM app.auth_refresh_tokens"))
      return [{ token_id: tokenId, session_id: sessionId, generation: 1, token_state: tokenState }];
    if (sql.includes("FROM app.users")) return [{ state: identityState }];
    return [];
  });
}
describe("0071 rotation, reuse, expiry and logout", () => {
  it("rotates and updates the current-family hash without organization access or sliding expiry", async () => {
    const db = familyDatabase();
    expect(await createRefreshRepository(db.pool).rotate(rotateInput)).toEqual({
      kind: "rotated",
      sessionId,
      userId,
      refreshExpiresAt: session.expiresAt,
    });
    expect(db.calls.at(-1)?.sql).toBe("COMMIT");
    const statements = db.calls.map((c) => c.sql).join("\n");
    expect(statements).not.toMatch(
      /app\.(organizations|organization_members)|rotated_at|last_used_at|SET expires_at/,
    );
    expect(statements).toMatch(/state = 'rotated', ended_at/);
    expect(db.calls.find((c) => c.sql.includes("SET token_family_hash"))?.values).toEqual([
      sessionId,
      legacyHash,
    ]);
    expect(db.calls.findIndex((c) => c.sql.includes("FROM app.auth_sessions"))).toBeLessThan(
      db.calls.findIndex((c) => c.sql.includes("FROM app.auth_refresh_tokens")),
    );
  });
  it("commits reuse revocation and audit/outbox evidence before returning denial", async () => {
    const db = familyDatabase("rotated");
    expect(await createRefreshRepository(db.pool).rotate(rotateInput)).toEqual({
      kind: "reuse_detected",
    });
    expect(db.calls.at(-1)?.sql).toBe("COMMIT");
    expect(db.calls.map((c) => c.sql).join("\n")).toMatch(/state = 'reused', ended_at/);
    expect(db.calls.find((c) => c.sql.includes("revoked_reason"))?.values).toEqual([
      sessionId,
      "refresh_reuse",
    ]);
    expect(db.calls.some((c) => c.sql.includes("security.refresh_token_reuse"))).toBe(true);
    expect(db.calls.some((c) => c.sql.includes("INSERT INTO app.auth_refresh_tokens"))).toBe(false);
  });
  it("commits revocation when the User becomes unavailable", async () => {
    const db = familyDatabase("active", "suspended");
    expect(await createRefreshRepository(db.pool).rotate(rotateInput)).toEqual({
      kind: "session_unavailable",
    });
    expect(db.calls.at(-1)?.sql).toBe("COMMIT");
    expect(db.calls.find((c) => c.sql.includes("revoked_reason"))?.values).toEqual([
      sessionId,
      "identity_unavailable",
    ]);
  });
  it("commits state-based expiry instead of minting another token", async () => {
    const db = familyDatabase("active", "active", true);
    expect(await createRefreshRepository(db.pool).rotate(rotateInput)).toEqual({
      kind: "session_unavailable",
    });
    expect(db.calls.at(-1)?.sql).toBe("COMMIT");
    expect(db.calls.map((c) => c.sql).join("\n")).toMatch(/state = 'expired',\s+ended_at/);
    expect(db.calls.some((c) => c.sql.includes("INSERT INTO app.auth_refresh_tokens"))).toBe(false);
  });
  it("logout uses the same family lock order and revokes without organization claims", async () => {
    const db = familyDatabase();
    expect(
      await createLogoutRepository(db.pool).revoke({
        userId,
        sessionId,
        requestId: trace,
        ipFingerprint: null,
      }),
    ).toBe("revoked");
    expect(db.calls.at(-1)?.sql).toBe("COMMIT");
    expect(db.calls.find((c) => c.sql.includes("revoked_reason"))?.values).toEqual([
      sessionId,
      "logout",
    ]);
    expect(db.calls.map((c) => c.sql).join("\n")).not.toMatch(
      /app\.(organizations|organization_members)|security_metadata/,
    );
    expect(db.calls.findIndex((c) => c.sql.includes("FROM app.auth_sessions"))).toBeLessThan(
      db.calls.findIndex((c) => c.sql.includes("FROM app.auth_refresh_tokens")),
    );
  });
  it("does not revoke another user's session", async () => {
    const db = familyDatabase();
    expect(
      await createLogoutRepository(db.pool).revoke({
        userId: randomUUID(),
        sessionId,
        requestId: trace,
        ipFingerprint: null,
      }),
    ).toBe("session_unavailable");
    expect(mutations(db.calls)).toEqual([]);
  });
});

describe("identity RLS context", () => {
  it("clears prior context and binds only the backend-authenticated user", async () => {
    const db = database(({ sql, values }) =>
      sql.includes("AS user_id") ? [{ user_id: values[0] }] : [],
    );
    await withIdentityUserTransaction(db.pool, userId, async (db) =>
      db.query("SELECT 'scoped work'"),
    );
    expect(db.calls[2]?.sql).toContain("set_config('app.user_id', '', true)");
    expect(db.calls[3]?.values).toEqual([userId]);
    expect(db.calls.at(-1)?.sql).toBe("COMMIT");
  });
  it("rolls back if the bound user context cannot be confirmed", async () => {
    const db = database();
    await expect(
      withIdentityUserTransaction(db.pool, userId, async () => {
        throw Error("must not run");
      }),
    ).rejects.toThrow("User context");
    expect(db.calls.at(-1)?.sql).toBe("ROLLBACK");
  });
});
