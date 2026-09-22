import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAccessTokenService } from "../../src/helpers/accessToken.js";
import { createCsrfService } from "../../src/helpers/csrf.js";
import { createRefreshTokenService } from "../../src/helpers/refreshToken.js";
import type {
  RefreshRepository,
  RefreshRotationOutcome,
} from "../../src/services/identity/refreshRepository.js";
import { createRefreshService } from "../../src/services/identity/refreshService.js";

const accessTokens = createAccessTokenService({
  secret: "refresh-unit-access-token-secret-at-least-32-characters",
  issuer: "https://dhumi.test",
  audience: "dhumi-browser",
  ttlSeconds: 900,
});
const refreshTokens = createRefreshTokenService();
const csrf = createCsrfService("refresh-unit-access-token-secret-at-least-32-characters");

const sessionId = randomUUID();
const userId = randomUUID();
const tenantId = randomUUID();
const sessionExpiresAt = new Date(Date.now() + 60_000);

function repository(outcome: RefreshRotationOutcome): RefreshRepository & {
  findCalls: Buffer[];
  rotateCalls: Array<{ presentedTokenHash: Buffer; replacementTokenHash: Buffer }>;
} {
  const findCalls: Buffer[] = [];
  const rotateCalls: Array<{ presentedTokenHash: Buffer; replacementTokenHash: Buffer }> = [];

  return {
    findCalls,
    rotateCalls,
    async findSessionIdByTokenHash(tokenHash) {
      findCalls.push(tokenHash);
      return sessionId;
    },
    async rotate(input) {
      rotateCalls.push({
        presentedTokenHash: input.presentedTokenHash,
        replacementTokenHash: input.replacementTokenHash,
      });
      return outcome;
    },
  };
}

function rotated(): RefreshRotationOutcome {
  return {
    kind: "rotated",
    sessionId,
    userId,
    tenantId,
    refreshExpiresAt: sessionExpiresAt,
  };
}

describe("refresh service", () => {
  it("rotates the refresh secret and issues a new browser access token", async () => {
    const store = repository(rotated());
    const service = createRefreshService({ repository: store, accessTokens, refreshTokens, csrf });
    const currentRefreshToken = refreshTokens.generate();

    const result = await service.refresh({
      refreshToken: currentRefreshToken,
      csrfToken: csrf.issue(sessionId),
      requestId: randomUUID(),
      ipFingerprint: null,
    });

    expect(result.refreshToken).not.toBe(currentRefreshToken);
    expect(result.refreshExpiresAt).toEqual(sessionExpiresAt);
    expect(store.findCalls).toEqual([refreshTokens.hash(currentRefreshToken)]);
    expect(store.rotateCalls).toHaveLength(1);
    expect(store.rotateCalls[0]?.presentedTokenHash).toEqual(
      refreshTokens.hash(currentRefreshToken),
    );
    expect(store.rotateCalls[0]?.replacementTokenHash).toEqual(
      refreshTokens.hash(result.refreshToken),
    );
    await expect(accessTokens.verify(result.accessToken)).resolves.toEqual({
      sessionId,
      userId,
      tenantId,
    });
    expect(result.csrfToken).toBe(csrf.issue(sessionId));
  });

  it("rejects a malformed refresh token before querying PostgreSQL", async () => {
    const store = repository(rotated());
    const service = createRefreshService({ repository: store, accessTokens, refreshTokens, csrf });

    await expect(
      service.refresh({
        refreshToken: "not-a-refresh-token",
        csrfToken: csrf.issue(sessionId),
        requestId: null,
        ipFingerprint: null,
      }),
    ).rejects.toMatchObject({ status: 401, code: "AUTHENTICATION_REQUIRED" });
    expect(store.findCalls).toHaveLength(0);
    expect(store.rotateCalls).toHaveLength(0);
  });

  it("returns the generic 401 for a well-formed token that is not stored", async () => {
    const store = repository(rotated());
    store.findSessionIdByTokenHash = async (tokenHash) => {
      store.findCalls.push(tokenHash);
      return undefined;
    };
    const service = createRefreshService({ repository: store, accessTokens, refreshTokens, csrf });

    await expect(
      service.refresh({
        refreshToken: refreshTokens.generate(),
        csrfToken: csrf.issue(sessionId),
        requestId: null,
        ipFingerprint: null,
      }),
    ).rejects.toMatchObject({ status: 401, code: "AUTHENTICATION_REQUIRED" });
    expect(store.findCalls).toHaveLength(1);
    expect(store.rotateCalls).toHaveLength(0);
  });

  it("rejects a missing or incorrect CSRF token without rotating", async () => {
    for (const csrfToken of [undefined, "wrong-csrf-token"]) {
      const store = repository(rotated());
      const service = createRefreshService({ repository: store, accessTokens, refreshTokens, csrf });

      await expect(
        service.refresh({
          refreshToken: refreshTokens.generate(),
          csrfToken,
          requestId: null,
          ipFingerprint: null,
        }),
      ).rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });
      expect(store.rotateCalls).toHaveLength(0);
    }
  });

  it("maps reuse or an unavailable session to the same non-enumerating 401", async () => {
    for (const outcome of [
      { kind: "reuse_detected" } as const,
      { kind: "session_unavailable" } as const,
    ]) {
      const store = repository(outcome);
      const service = createRefreshService({ repository: store, accessTokens, refreshTokens, csrf });

      await expect(
        service.refresh({
          refreshToken: refreshTokens.generate(),
          csrfToken: csrf.issue(sessionId),
          requestId: null,
          ipFingerprint: null,
        }),
      ).rejects.toMatchObject({ status: 401, code: "AUTHENTICATION_REQUIRED" });
    }
  });

  it("returns the declared 403 when Tenant authorization is unavailable", async () => {
    const store = repository({ kind: "workspace_unavailable" });
    const service = createRefreshService({ repository: store, accessTokens, refreshTokens, csrf });

    await expect(
      service.refresh({
        refreshToken: refreshTokens.generate(),
        csrfToken: csrf.issue(sessionId),
        requestId: null,
        ipFingerprint: null,
      }),
    ).rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });
  });
});
