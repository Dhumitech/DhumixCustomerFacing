import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import { createAccessTokenService } from "../../src/helpers/accessToken.js";
import { createCsrfService } from "../../src/helpers/csrf.js";
import { createPasswordHasher } from "../../src/helpers/password.js";
import { createRefreshTokenService } from "../../src/helpers/refreshToken.js";
import { createDatabasePools } from "../../src/services/database/pools.js";
import { withIdentityTransaction } from "../../src/services/database/transactions.js";
import { createSignInRepository } from "../../src/services/identity/signInRepository.js";
import type { SignInRepository } from "../../src/services/identity/signInRepository.js";
import { createSignInService } from "../../src/services/identity/signInService.js";
import type { SignInService } from "../../src/services/identity/signInService.js";
import { createSignupRepository } from "../../src/services/identity/signupRepository.js";
import { createSignupService } from "../../src/services/identity/signupService.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const config = enabled ? loadRuntimeConfig() : undefined;

if (enabled && config?.database.database !== "dhumi_test") {
  throw new Error("Sign-in database tests may run only against dhumi_test");
}

const pools = enabled && config ? createDatabasePools(config.database, () => {}) : undefined;

afterAll(async () => {
  await pools?.close();
});

const PASSWORD = "a-sufficiently-long-password";

function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("database pools are not configured");
  }
  return value;
}

function signIn(
  overrides: Partial<{ lockoutThreshold: number }> = {},
  decorateRepository: (repository: SignInRepository) => SignInRepository =
    (repository) => repository,
): SignInService {
  const c = must(config);
  const repository = decorateRepository(createSignInRepository(must(pools).identity));
  return createSignInService({
    repository,
    passwordHasher: createPasswordHasher(c.passwordHash),
    accessTokens: createAccessTokenService(c.session.accessToken),
    refreshTokens: createRefreshTokenService(),
    csrf: createCsrfService(c.session.accessToken.secret),
    session: c.session,
    lockout: { ...c.lockout, threshold: overrides.lockoutThreshold ?? c.lockout.threshold },
  });
}

async function createIdentity(): Promise<string> {
  const c = must(config);
  const email = `signin-int-${randomUUID()}@example.test`;
  await createSignupService({
    repository: createSignupRepository(must(pools).identity),
    passwordHasher: createPasswordHasher(c.passwordHash),
    legal: c.legal,
  }).submit({
    email,
    password: PASSWORD,
    workspaceName: "Sign-in Integration",
    legalAcceptances: [
      {
        document_type: "terms",
        document_version: "signin-int-v1",
        content_hash: "a".repeat(64),
        accepted: true,
      },
    ],
    idempotencyKey: `signin-int-${randomUUID()}`,
    requestId: randomUUID(),
  });
  return email;
}

function request(email: string, password = PASSWORD) {
  return {
    email,
    password,
    requestId: randomUUID(),
    ipFingerprint: null,
    deviceMetadata: { user_agent_family: "vitest" },
  };
}

async function readUser(email: string): Promise<{
  id: string;
  state: string;
  failed_auth_count: number;
  password_hash: string;
}> {
  const result = await withIdentityTransaction(must(pools).identity, async (db) =>
    db.query<{ id: string; state: string; failed_auth_count: number; password_hash: string }>(
      `SELECT id, state, failed_auth_count, password_hash
         FROM app.users WHERE email_normalized = $1`,
      [email],
    ),
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`no user for ${email}`);
  return row;
}

async function readSessions(userId: string): Promise<
  Array<{
    id: string;
    state: string;
    token_family_hash: Buffer;
    expires_at: Date;
    issued_at: Date;
    device_metadata: Record<string, unknown>;
    security_metadata: Record<string, unknown>;
  }>
> {
  const result = await withIdentityTransaction(must(pools).identity, async (db) =>
    db.query(`SELECT * FROM app.auth_sessions WHERE user_id = $1 ORDER BY issued_at`, [userId]),
  );
  return result.rows as never;
}

async function setUserState(userId: string, state: string): Promise<void> {
  await withIdentityTransaction(must(pools).identity, async (db) =>
    db.query(
      `
        UPDATE app.users
        SET
          state = $2,
          last_failed_auth_at = CASE
            WHEN $2 = 'locked' THEN coalesce(last_failed_auth_at, clock_timestamp())
            ELSE last_failed_auth_at
          END
        WHERE id = $1
      `,
      [userId, state],
    ),
  );
}

describe.skipIf(!enabled)("sign-in against PostgreSQL", () => {
  it("authenticates and writes exactly one session", async () => {
    const email = await createIdentity();
    const before = await readUser(email);

    const result = await signIn().authenticate(request(email));

    expect(result.accessToken).not.toBe("");
    expect(result.csrfToken).not.toBe("");
    expect(result.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const sessions = await readSessions(before.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.state).toBe("active");
    // CHECK (expires_at > issued_at) must hold, and the stored value must be
    // the family hash, never the token itself.
    expect(sessions[0]!.expires_at.getTime()).toBeGreaterThan(
      sessions[0]!.issued_at.getTime(),
    );
    expect(sessions[0]!.token_family_hash).toHaveLength(32);
    expect(sessions[0]!.token_family_hash.toString("utf8")).not.toContain(result.refreshToken);
    expect(sessions[0]!.device_metadata).toEqual({ user_agent_family: "vitest" });
    expect(sessions[0]!.security_metadata).toEqual({ issued_by: "sign_in" });
  });

  it("issues a token carrying the resolved Tenant, which the customer never supplied", async () => {
    const email = await createIdentity();
    const result = await signIn().authenticate(request(email));

    const claims = await createAccessTokenService(
      must(config).session.accessToken,
    ).verify(result.accessToken);

    const user = await readUser(email);
    const tenant = await withIdentityTransaction(must(pools).identity, async (db) =>
      db.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM app.tenant_user_access WHERE user_id = $1`,
        [user.id],
      ),
    );

    expect(claims?.userId).toBe(user.id);
    expect(claims?.tenantId).toBe(tenant.rows[0]?.tenant_id);
    expect(claims?.sessionId).toBe((await readSessions(user.id))[0]?.id);
  });

  it("rejects a wrong password and counts the failure", async () => {
    const email = await createIdentity();
    const user = await readUser(email);

    await expect(signIn().authenticate(request(email, "wrong-password-entirely"))).rejects
      .toMatchObject({ status: 401, code: "AUTHENTICATION_REQUIRED" });

    expect((await readUser(email)).failed_auth_count).toBe(1);
    expect(await readSessions(user.id)).toHaveLength(0);
  });

  it("rejects an unknown email with the identical error and creates nothing", async () => {
    await expect(
      signIn().authenticate(request(`signin-int-missing-${randomUUID()}@example.test`)),
    ).rejects.toMatchObject({ status: 401, code: "AUTHENTICATION_REQUIRED" });
  });

  it("resets the failure counter on a successful sign-in", async () => {
    const email = await createIdentity();

    await expect(signIn().authenticate(request(email, "wrong-one"))).rejects.toThrow();
    await expect(signIn().authenticate(request(email, "wrong-two"))).rejects.toThrow();
    expect((await readUser(email)).failed_auth_count).toBe(2);

    await signIn().authenticate(request(email));
    expect((await readUser(email)).failed_auth_count).toBe(0);
  });

  it("locks the account at the configured threshold", async () => {
    const email = await createIdentity();

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(
        signIn({ lockoutThreshold: 3 }).authenticate(request(email, "wrong")),
      ).rejects.toThrow();
    }

    expect((await readUser(email)).state).toBe("locked");
  });

  it("gives a locked account the same error as a wrong password", async () => {
    const email = await createIdentity();
    const user = await readUser(email);
    await setUserState(user.id, "locked");

    // The correct password, against a locked account.
    await expect(signIn().authenticate(request(email))).rejects.toMatchObject({
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
    });
    expect(await readSessions(user.id)).toHaveLength(0);
  });

  it("rejects suspended and closed accounts the same way", async () => {
    for (const state of ["suspended", "closed"]) {
      const email = await createIdentity();
      const user = await readUser(email);
      await setUserState(user.id, state);

      await expect(signIn().authenticate(request(email))).rejects.toMatchObject({
        status: 401,
        code: "AUTHENTICATION_REQUIRED",
      });
    }
  });

  it("returns 403 when the Tenant access is revoked", async () => {
    const email = await createIdentity();
    const user = await readUser(email);

    await withIdentityTransaction(must(pools).identity, async (db) =>
      db.query(`UPDATE app.tenant_user_access SET state = 'revoked' WHERE user_id = $1`, [
        user.id,
      ]),
    );

    // Past the password check, so being specific leaks nothing further.
    await expect(signIn().authenticate(request(email))).rejects.toMatchObject({
      status: 403,
      code: "ACCESS_DENIED",
    });
    expect(await readSessions(user.id)).toHaveLength(0);
  });

  it("fails closed when a User has more than one active Tenant access", async () => {
    const email = await createIdentity();
    const user = await readUser(email);

    await withIdentityTransaction(must(pools).identity, async (db) => {
      const tenant = await db.query<{ id: string }>(
        `INSERT INTO app.tenants (display_name) VALUES ('Second Sign-in Tenant') RETURNING id`,
      );
      await db.query(
        `INSERT INTO app.tenant_user_access (tenant_id, user_id, access_role)
         VALUES ($1, $2, 'owner')`,
        [tenant.rows[0]?.id, user.id],
      );
    });

    await expect(signIn().authenticate(request(email))).rejects.toMatchObject({
      status: 403,
      code: "ACCESS_DENIED",
    });
    expect(await readSessions(user.id)).toHaveLength(0);
  });

  it("does not create a session when Tenant access is revoked after the access read", async () => {
    const email = await createIdentity();
    const user = await readUser(email);
    const service = signIn({}, (repository) => ({
      ...repository,
      async createSession(session, audit, authorization) {
        await withIdentityTransaction(must(pools).identity, async (db) =>
          db.query(
            `UPDATE app.tenant_user_access SET state = 'revoked' WHERE user_id = $1`,
            [session.userId],
          ),
        );
        return repository.createSession(session, audit, authorization);
      },
    }));

    await expect(service.authenticate(request(email))).rejects.toMatchObject({
      status: 403,
      code: "ACCESS_DENIED",
    });
    expect(await readSessions(user.id)).toHaveLength(0);
  });

  it("writes an audit row for both the accepted and denied paths", async () => {
    const email = await createIdentity();
    const user = await readUser(email);

    await expect(signIn().authenticate(request(email, "wrong"))).rejects.toThrow();
    await signIn().authenticate(request(email));

    const audits = await withIdentityTransaction(must(pools).identity, async (db) =>
      db.query<{ action: string; outcome: string }>(
        `SELECT action, outcome FROM app.audit_events
          WHERE actor_user_id = $1 AND action = 'identity.sign_in'
          ORDER BY occurred_at`,
        [user.id],
      ),
    );

    expect(audits.rows.map((row) => row.outcome)).toEqual(["denied", "accepted"]);
  });

  it("upgrades a password hash whose parameters differ from configuration", async () => {
    const email = await createIdentity();
    const user = await readUser(email);
    const configured = must(config).passwordHash;

    // A genuinely different cost, so needsRehash has something to detect. The
    // earlier version of this test hashed at the configured cost and asserted
    // only that the result was still Argon2id, which was true either way and
    // proved nothing.
    const otherCost = { ...configured, timeCost: configured.timeCost + 1 };
    const stale = await createPasswordHasher(otherCost).hash(PASSWORD);
    expect(stale).toContain(`t=${otherCost.timeCost}`);

    await withIdentityTransaction(must(pools).identity, async (db) =>
      db.query(`UPDATE app.users SET password_hash = $2 WHERE id = $1`, [user.id, stale]),
    );

    // The stale hash must still authenticate: Argon2 verifies against the
    // parameters recorded inside the encoded value, not the configured ones.
    await signIn().authenticate(request(email));

    const after = await readUser(email);
    expect(after.password_hash).not.toBe(stale);
    expect(after.password_hash).toContain(`m=${configured.memoryKib},t=${configured.timeCost}`);
    expect(await createPasswordHasher(configured).verify(after.password_hash, PASSWORD)).toBe(
      true,
    );
  });

  it("unlocks an account once the lockout window has elapsed", async () => {
    const email = await createIdentity();
    const user = await readUser(email);

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(
        signIn({ lockoutThreshold: 3 }).authenticate(request(email, "wrong")),
      ).rejects.toThrow();
    }
    expect((await readUser(email)).state).toBe("locked");

    // Age the last failure past the window. An earlier implementation rejected
    // any state that was not 'active' after checking the window, so the window
    // had no effect and an account locked once stayed locked forever.
    await withIdentityTransaction(must(pools).identity, async (db) =>
      db.query(
        `UPDATE app.users SET last_failed_auth_at = now() - interval '2 hours' WHERE id = $1`,
        [user.id],
      ),
    );

    await signIn().authenticate(request(email));

    const after = await readUser(email);
    expect(after.state).toBe("active");
    expect(after.failed_auth_count).toBe(0);
  });

  it("keeps a locked account locked while the window is still open", async () => {
    const email = await createIdentity();

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(
        signIn({ lockoutThreshold: 3 }).authenticate(request(email, "wrong")),
      ).rejects.toThrow();
    }

    // The correct password, inside the window.
    await expect(signIn().authenticate(request(email))).rejects.toMatchObject({
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
    });
    expect((await readUser(email)).state).toBe("locked");
  });

  it("does not clear a lock refreshed after the initial identity read", async () => {
    const email = await createIdentity();
    const user = await readUser(email);

    await withIdentityTransaction(must(pools).identity, async (db) =>
      db.query(
        `UPDATE app.users
            SET state = 'locked',
                failed_auth_count = 3,
                last_failed_auth_at = now() - interval '2 hours'
          WHERE id = $1`,
        [user.id],
      ),
    );

    const service = signIn({}, (repository) => ({
      ...repository,
      async createSession(session, audit, authorization) {
        await withIdentityTransaction(must(pools).identity, async (db) =>
          db.query(
            `UPDATE app.users SET last_failed_auth_at = clock_timestamp() WHERE id = $1`,
            [session.userId],
          ),
        );
        return repository.createSession(session, audit, authorization);
      },
    }));

    await expect(service.authenticate(request(email))).rejects.toMatchObject({
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
    });
    expect(await readSessions(user.id)).toHaveLength(0);
    expect((await readUser(email)).state).toBe("locked");
  });

  it("allows several concurrent sessions for one user", async () => {
    const email = await createIdentity();
    const user = await readUser(email);

    await Promise.all([
      signIn().authenticate(request(email)),
      signIn().authenticate(request(email)),
      signIn().authenticate(request(email)),
    ]);

    const sessions = await readSessions(user.id);
    expect(sessions).toHaveLength(3);
    // Every family hash must be distinct; auth_sessions.token_family_hash is
    // UNIQUE, so a repeated value would have raised 23505.
    expect(new Set(sessions.map((s) => s.token_family_hash.toString("hex"))).size).toBe(3);
  });
});
