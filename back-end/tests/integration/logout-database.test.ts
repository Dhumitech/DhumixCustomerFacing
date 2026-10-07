import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import { createAccessTokenService } from "../../src/helpers/accessToken.js";
import { createCsrfService } from "../../src/helpers/csrf.js";
import { createPasswordHasher } from "../../src/helpers/password.js";
import { createRefreshTokenService } from "../../src/helpers/refreshToken.js";
import { createDatabasePools } from "../../src/services/database/pools.js";
import { withIdentityTransaction } from "../../src/services/database/transactions.js";
import { createBrowserAuthenticationRepository } from "../../src/services/identity/browserAuthenticationRepository.js";
import { createBrowserAuthenticationService } from "../../src/services/identity/browserAuthenticationService.js";
import type { TrustedSessionIdentity } from "../../src/services/identity/browserAuthenticationService.js";
import { createLogoutRepository } from "../../src/services/identity/logoutRepository.js";
import { createLogoutService } from "../../src/services/identity/logoutService.js";
import type { LogoutService } from "../../src/services/identity/logoutService.js";
import { createRefreshRepository } from "../../src/services/identity/refreshRepository.js";
import { createRefreshService } from "../../src/services/identity/refreshService.js";
import type { RefreshService } from "../../src/services/identity/refreshService.js";
import { createSignInRepository } from "../../src/services/identity/signInRepository.js";
import { createSignInService } from "../../src/services/identity/signInService.js";
import type { SignInResult } from "../../src/services/identity/signInService.js";
import { createSignupRepository } from "../../src/services/identity/signupRepository.js";
import { createSignupService } from "../../src/services/identity/signupService.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const config = enabled ? loadRuntimeConfig() : undefined;

if (enabled && config?.database.database !== "dhumi_test") {
  throw new Error("Logout database tests may run only against dhumi_test");
}

const pools = enabled && config ? createDatabasePools(config.database, () => {}) : undefined;
const PASSWORD = "a-sufficiently-long-password";

afterAll(async () => {
  await pools?.close();
});

function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("database integration configuration is unavailable");
  }
  return value;
}

function accessTokens() {
  return createAccessTokenService(must(config).session.accessToken);
}

function csrf() {
  return createCsrfService(must(config).session.accessToken.secret);
}

function logout(): LogoutService {
  return createLogoutService({
    repository: createLogoutRepository(must(pools).identity),
    csrf: csrf(),
  });
}

function refresh(): RefreshService {
  return createRefreshService({
    repository: createRefreshRepository(must(pools).identity),
    accessTokens: accessTokens(),
    refreshTokens: createRefreshTokenService(),
    csrf: csrf(),
  });
}

function browserAuthentication() {
  return createBrowserAuthenticationService({
    accessTokens: accessTokens(),
    repository: createBrowserAuthenticationRepository(must(pools).identity),
  });
}

interface SignedInFixture {
  readonly signIn: SignInResult;
  readonly sessionId: string;
  readonly userId: string;
  readonly tenantId: null;
}

async function createSignedInIdentity(): Promise<SignedInFixture> {
  const currentConfig = must(config);
  const email = `logout-int-${randomUUID()}@example.test`;
  await createSignupService({
    repository: createSignupRepository(must(pools).identity),
    passwordHasher: createPasswordHasher(currentConfig.passwordHash),
    legal: currentConfig.legal,
  }).submit({
    email,
    password: PASSWORD,
    workspaceName: "Logout Integration",
    legalAcceptances: [
      {
        document_type: "terms",
        document_version: "logout-int-v1",
        content_hash: "b".repeat(64),
        accepted: true,
      },
    ],
    idempotencyKey: `logout-int-${randomUUID()}`,
    requestId: randomUUID(),
  });

  const signIn = await createSignInService({
    repository: createSignInRepository(must(pools).identity),
    passwordHasher: createPasswordHasher(currentConfig.passwordHash),
    accessTokens: accessTokens(),
    refreshTokens: createRefreshTokenService(),
    csrf: csrf(),
    session: currentConfig.session,
    lockout: currentConfig.lockout,
  }).authenticate({
    email,
    password: PASSWORD,
    requestId: randomUUID(),
    ipFingerprint: null,
  });

  const claims = await accessTokens().verify(signIn.accessToken);
  if (claims === undefined) {
    throw new Error("sign-in fixture did not issue a verifiable access token");
  }
  return {
    signIn,
    sessionId: claims.sessionId,
    userId: claims.userId,
    tenantId: null,
  };
}

async function authenticate(fixture: SignedInFixture): Promise<TrustedSessionIdentity> {
  return browserAuthentication().authenticate(`Bearer ${fixture.signIn.accessToken}`);
}

function logoutRequest(fixture: SignedInFixture, identity: TrustedSessionIdentity) {
  return {
    identity,
    csrfToken: fixture.signIn.csrfToken,
    requestId: randomUUID(),
    ipFingerprint: null,
  };
}

async function readFamily(sessionId: string): Promise<{
  readonly sessionState: string;
  readonly revokedBy: string | null;
  readonly tokenStates: string[];
  readonly activeTokenCount: number;
  readonly logoutAuditCount: number;
  readonly logoutAudit: Record<string, unknown> | undefined;
  readonly logoutAuditPayload: string;
  readonly outboxCount: number;
}> {
  return withIdentityTransaction(must(pools).identity, async (database) => {
    const session = await database.query<{
      state: string;
      revoked_reason: string | null;
    }>(`SELECT state, revoked_reason FROM app.auth_sessions WHERE id = $1`, [sessionId]);
    const tokens = await database.query<{ state: string }>(
      `
        SELECT state
        FROM app.auth_refresh_tokens
        WHERE session_id = $1
        ORDER BY generation
      `,
      [sessionId],
    );
    const audits = await database.query<Record<string, unknown>>(
      `
        SELECT tenant_id, actor_user_id, action, target_type, target_id, outcome, request_id
        FROM app.audit_events
        WHERE target_id = $1
          AND action = 'identity.logout'
        ORDER BY occurred_at
      `,
      [sessionId],
    );
    const outbox = await database.query<{ count: string }>(
      `SELECT count(*) FROM app.outbox_events WHERE aggregate_id = $1`,
      [sessionId],
    );
    const row = session.rows[0];
    if (row === undefined) {
      throw new Error("session fixture was not found");
    }
    return {
      sessionState: row.state,
      revokedBy: row.revoked_reason,
      tokenStates: tokens.rows.map((token) => token.state),
      activeTokenCount: tokens.rows.filter((token) => token.state === "active").length,
      logoutAuditCount: audits.rowCount ?? audits.rows.length,
      logoutAudit: audits.rows[0],
      logoutAuditPayload: JSON.stringify(audits.rows),
      outboxCount: Number(outbox.rows[0]?.count ?? -1),
    };
  });
}

describe.skipIf(!enabled)("logout against PostgreSQL", () => {
  it("revokes the current family, writes one safe audit, and rejects sequential reuse", async () => {
    const fixture = await createSignedInIdentity();
    const identity = await authenticate(fixture);
    const request = logoutRequest(fixture, identity);

    await expect(logout().logout(request)).resolves.toBeUndefined();

    const family = await readFamily(fixture.sessionId);
    expect(family.sessionState).toBe("revoked");
    expect(family.revokedBy).toBe("logout");
    expect(family.tokenStates).toEqual(["revoked"]);
    expect(family.activeTokenCount).toBe(0);
    expect(family.logoutAuditCount).toBe(1);
    expect(family.logoutAudit).toMatchObject({
      tenant_id: fixture.tenantId,
      actor_user_id: fixture.userId,
      action: "identity.logout",
      target_type: "auth_session",
      target_id: fixture.sessionId,
      outcome: "accepted",
      request_id: request.requestId,
    });
    expect(family.outboxCount).toBe(0);
    expect(family.logoutAuditPayload).not.toContain(fixture.signIn.accessToken);
    expect(family.logoutAuditPayload).not.toContain(fixture.signIn.refreshToken);
    expect(family.logoutAuditPayload).not.toContain(fixture.signIn.csrfToken);

    await expect(authenticate(fixture)).rejects.toMatchObject({
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
    });
  });

  it("does not mutate or audit when CSRF validation fails", async () => {
    const fixture = await createSignedInIdentity();
    const identity = await authenticate(fixture);

    await expect(
      logout().logout({ ...logoutRequest(fixture, identity), csrfToken: "wrong-csrf-token" }),
    ).rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });

    const family = await readFamily(fixture.sessionId);
    expect(family.sessionState).toBe("active");
    expect(family.tokenStates).toEqual(["active"]);
    expect(family.logoutAuditCount).toBe(0);
  });

  it("allows credential destruction after User suspension without organization access", async () => {
    const fixture = await createSignedInIdentity();
    await withIdentityTransaction(must(pools).identity, async (database) =>
      database.query("UPDATE app.users SET state = 'suspended' WHERE id = $1", [fixture.userId]));
    const identity = await authenticate(fixture);
    await expect(logout().logout(logoutRequest(fixture, identity))).resolves.toBeUndefined();
    expect((await readFamily(fixture.sessionId)).sessionState).toBe("revoked");
  });

  it("serializes simultaneous logout calls and writes one accepted audit", async () => {
    const fixture = await createSignedInIdentity();
    const identity = await authenticate(fixture);

    await expect(
      Promise.all([
        logout().logout(logoutRequest(fixture, identity)),
        logout().logout(logoutRequest(fixture, identity)),
      ]),
    ).resolves.toEqual([undefined, undefined]);

    const family = await readFamily(fixture.sessionId);
    expect(family.sessionState).toBe("revoked");
    expect(family.activeTokenCount).toBe(0);
    expect(family.logoutAuditCount).toBe(1);
  });

  it("serializes logout against refresh without deadlock or an active successor", async () => {
    const fixture = await createSignedInIdentity();
    const identity = await authenticate(fixture);
    const results = await Promise.allSettled([
      logout().logout(logoutRequest(fixture, identity)),
      refresh().refresh({
        refreshToken: fixture.signIn.refreshToken,
        csrfToken: fixture.signIn.csrfToken,
        requestId: randomUUID(),
        ipFingerprint: null,
      }),
    ]);

    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({
          status: 401,
          code: "AUTHENTICATION_REQUIRED",
        });
      }
    }

    const family = await readFamily(fixture.sessionId);
    expect(family.sessionState).toBe("revoked");
    expect(family.activeTokenCount).toBe(0);
    expect(family.logoutAuditCount).toBe(1);
  });
});
