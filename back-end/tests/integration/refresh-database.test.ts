import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import { createAccessTokenService } from "../../src/helpers/accessToken.js";
import { createCsrfService } from "../../src/helpers/csrf.js";
import { createPasswordHasher } from "../../src/helpers/password.js";
import { createRefreshTokenService } from "../../src/helpers/refreshToken.js";
import { createDatabasePools } from "../../src/services/database/pools.js";
import { withIdentityTransaction } from "../../src/services/database/transactions.js";
import { createRefreshRepository } from "../../src/services/identity/refreshRepository.js";
import { createRefreshService } from "../../src/services/identity/refreshService.js";
import type { RefreshService } from "../../src/services/identity/refreshService.js";
import { createSignInRepository } from "../../src/services/identity/signInRepository.js";
import { createSignInService } from "../../src/services/identity/signInService.js";
import type { SignInResult, SignInService } from "../../src/services/identity/signInService.js";
import { createSignupRepository } from "../../src/services/identity/signupRepository.js";
import { createSignupService } from "../../src/services/identity/signupService.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const config = enabled ? loadRuntimeConfig() : undefined;

if (enabled && config?.database.database !== "dhumi_test") {
  throw new Error("Refresh database tests may run only against dhumi_test");
}

const pools = enabled && config ? createDatabasePools(config.database, () => {}) : undefined;
const PASSWORD = "a-sufficiently-long-password";

afterAll(async () => {
  await pools?.close();
});

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("database integration configuration is unavailable");
  return value;
}

function signIn(): SignInService {
  const c = must(config);
  return createSignInService({
    repository: createSignInRepository(must(pools).identity),
    passwordHasher: createPasswordHasher(c.passwordHash),
    accessTokens: createAccessTokenService(c.session.accessToken),
    refreshTokens: createRefreshTokenService(),
    csrf: createCsrfService(c.session.accessToken.secret),
    session: c.session,
    lockout: c.lockout,
  });
}

function refresh(): RefreshService {
  const c = must(config);
  return createRefreshService({
    repository: createRefreshRepository(must(pools).identity),
    accessTokens: createAccessTokenService(c.session.accessToken),
    refreshTokens: createRefreshTokenService(),
    csrf: createCsrfService(c.session.accessToken.secret),
  });
}

async function createSignedInIdentity(): Promise<{ email: string; signIn: SignInResult }> {
  const c = must(config);
  const email = `refresh-int-${randomUUID()}@example.test`;
  await createSignupService({
    repository: createSignupRepository(must(pools).identity),
    passwordHasher: createPasswordHasher(c.passwordHash),
    legal: c.legal,
  }).submit({
    email,
    password: PASSWORD,
    workspaceName: "Refresh Integration",
    legalAcceptances: [
      {
        document_type: "terms",
        document_version: "refresh-int-v1",
        content_hash: "a".repeat(64),
        accepted: true,
      },
    ],
    idempotencyKey: `refresh-int-${randomUUID()}`,
    requestId: randomUUID(),
  });

  return {
    email,
    signIn: await signIn().authenticate({
      email,
      password: PASSWORD,
      requestId: randomUUID(),
      ipFingerprint: null,
    }),
  };
}

async function readSessionByRefreshToken(refreshToken: string): Promise<{
  session_id: string;
  user_id: string;
  session_state: string;
  token_family_hash: Buffer;
}> {
  const tokenHash = createRefreshTokenService().hash(refreshToken);
  const result = await withIdentityTransaction(must(pools).identity, async (database) =>
    database.query(
      `
        SELECT
          session.id AS session_id,
          session.user_id,
          session.state AS session_state,
          session.token_family_hash
        FROM app.auth_refresh_tokens token
        JOIN app.auth_sessions session ON session.id = token.session_id
        WHERE token.token_hash = $1
      `,
      [tokenHash],
    ),
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("refresh-token fixture was not found");
  return row as never;
}

async function readGenerations(sessionId: string): Promise<
  Array<{ generation: number; state: string; token_hash: Buffer }>
> {
  const result = await withIdentityTransaction(must(pools).identity, async (database) =>
    database.query(
      `
        SELECT generation, state, token_hash
        FROM app.auth_refresh_tokens
        WHERE session_id = $1
        ORDER BY generation
      `,
      [sessionId],
    ),
  );
  return result.rows as never;
}

function refreshRequest(signInResult: SignInResult) {
  return {
    refreshToken: signInResult.refreshToken,
    csrfToken: signInResult.csrfToken,
    requestId: randomUUID(),
    ipFingerprint: null,
  };
}

describe.skipIf(!enabled)("refresh against PostgreSQL", () => {
  it("creates generation one during sign-in and atomically rotates to generation two", async () => {
    const fixture = await createSignedInIdentity();
    const before = await readSessionByRefreshToken(fixture.signIn.refreshToken);
    const firstGeneration = await readGenerations(before.session_id);
    expect(firstGeneration).toHaveLength(1);
    expect(firstGeneration[0]).toMatchObject({ generation: 1, state: "active" });
    expect(firstGeneration[0]?.token_hash).toEqual(
      createRefreshTokenService().hash(fixture.signIn.refreshToken),
    );

    const rotated = await refresh().refresh(refreshRequest(fixture.signIn));
    const after = await readSessionByRefreshToken(rotated.refreshToken);
    expect(after.session_id).toBe(before.session_id);
    expect(after.session_state).toBe("active");
    expect(after).not.toHaveProperty("last_used_at");
    expect(after.token_family_hash).toEqual(createRefreshTokenService().hash(rotated.refreshToken));
    expect((await readGenerations(before.session_id)).map(({ generation, state }) => ({ generation, state })))
      .toEqual([
        { generation: 1, state: "rotated" },
        { generation: 2, state: "active" },
      ]);

    await expect(
      createAccessTokenService(must(config).session.accessToken).verify(rotated.accessToken),
    ).resolves.toMatchObject({ sessionId: before.session_id, userId: before.user_id });
  });

  it("detects reuse, revokes the complete family, and writes audit/outbox evidence", async () => {
    const fixture = await createSignedInIdentity();
    const session = await readSessionByRefreshToken(fixture.signIn.refreshToken);
    const rotated = await refresh().refresh(refreshRequest(fixture.signIn));

    await expect(refresh().refresh(refreshRequest(fixture.signIn))).rejects.toMatchObject({
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
    });

    expect((await readSessionByRefreshToken(rotated.refreshToken)).session_state).toBe("revoked");
    expect((await readGenerations(session.session_id)).map((row) => row.state)).toEqual([
      "reused",
      "revoked",
    ]);

    const evidence = await withIdentityTransaction(must(pools).identity, async (database) => {
      const audits = await database.query<{ outcome: string }>(
        `
          SELECT outcome FROM app.audit_events
          WHERE target_id = $1 AND action = 'identity.refresh'
          ORDER BY occurred_at
        `,
        [session.session_id],
      );
      const outbox = await database.query<{ topic: string; payload: Record<string, unknown> }>(
        `SELECT topic, payload FROM app.outbox_events WHERE aggregate_id = $1`,
        [session.session_id],
      );
      return { audits: audits.rows, outbox: outbox.rows };
    });
    expect(evidence.audits.map((row) => row.outcome)).toEqual(["accepted", "denied_reuse"]);
    expect(evidence.outbox).toHaveLength(1);
    expect(evidence.outbox[0]).toMatchObject({
      topic: "security.refresh_token_reuse",
      payload: { reason: "rotated_token_reused" },
    });
    expect(JSON.stringify(evidence)).not.toContain(fixture.signIn.refreshToken);
    expect(JSON.stringify(evidence)).not.toContain(rotated.refreshToken);
  });

  it("does not mutate the family when CSRF validation fails", async () => {
    const fixture = await createSignedInIdentity();
    const session = await readSessionByRefreshToken(fixture.signIn.refreshToken);

    await expect(
      refresh().refresh({ ...refreshRequest(fixture.signIn), csrfToken: "wrong-csrf" }),
    ).rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });

    expect((await readSessionByRefreshToken(fixture.signIn.refreshToken)).session_state).toBe(
      "active",
    );
    expect((await readGenerations(session.session_id)).map((row) => row.state)).toEqual([
      "active",
    ]);
  });

  it("revokes the session with a generic 401 if its User is suspended", async () => {
    const fixture = await createSignedInIdentity();
    const session = await readSessionByRefreshToken(fixture.signIn.refreshToken);
    await withIdentityTransaction(must(pools).identity, async (database) =>
      database.query(
        `UPDATE app.users SET state = 'suspended' WHERE id = $1`,
        [session.user_id],
      ),
    );

    await expect(refresh().refresh(refreshRequest(fixture.signIn))).rejects.toMatchObject({
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
    });
    expect((await readSessionByRefreshToken(fixture.signIn.refreshToken)).session_state).toBe(
      "revoked",
    );
    expect((await readGenerations(session.session_id))[0]?.state).toBe("revoked");
  });

  it("serializes concurrent refresh attempts and treats the loser as reuse", async () => {
    const fixture = await createSignedInIdentity();
    const session = await readSessionByRefreshToken(fixture.signIn.refreshToken);
    const requests = await Promise.allSettled([
      refresh().refresh(refreshRequest(fixture.signIn)),
      refresh().refresh(refreshRequest(fixture.signIn)),
    ]);

    expect(requests.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(requests.filter((result) => result.status === "rejected")).toHaveLength(1);
    const state = await withIdentityTransaction(must(pools).identity, async (database) =>
      database.query<{ state: string }>(`SELECT state FROM app.auth_sessions WHERE id = $1`, [
        session.session_id,
      ]),
    );
    expect(state.rows[0]?.state).toBe("revoked");
    expect((await readGenerations(session.session_id)).map((row) => row.state)).toEqual([
      "reused",
      "revoked",
    ]);
  });

  it("expires a short-lived family using the PostgreSQL clock without altering issuance time", async () => {
    const fixture = await createSignedInIdentity();
    const original = await readSessionByRefreshToken(fixture.signIn.refreshToken);
    const sessionId = randomUUID();
    const token = createRefreshTokenService().generate();
    const hash = createRefreshTokenService().hash(token);
    await withIdentityTransaction(must(pools).identity, async (database) => {
      await database.query(
        "INSERT INTO app.auth_sessions (id,user_id,token_family_hash,expires_at) VALUES ($1,$2,$3,clock_timestamp()+interval '1 second')",
        [sessionId, original.user_id, hash]);
      await database.query("INSERT INTO app.auth_refresh_tokens (session_id,token_hash,generation) VALUES ($1,$2,1)", [sessionId,hash]);
    });
    await new Promise(resolve => setTimeout(resolve, 1200));
    await expect(refresh().refresh({ refreshToken: token,
      csrfToken: createCsrfService(must(config).session.accessToken.secret).issue(sessionId),
      requestId: randomUUID(), ipFingerprint: null })).rejects.toMatchObject({ status: 401, code: "AUTHENTICATION_REQUIRED" });
    expect((await readSessionByRefreshToken(token)).session_state).toBe("expired");
    expect((await readGenerations(sessionId))[0]?.state).toBe("expired");
  });
});
