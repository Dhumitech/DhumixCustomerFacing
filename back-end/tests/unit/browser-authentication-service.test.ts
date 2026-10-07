import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAccessTokenService } from "../../src/helpers/accessToken.js";
import type { BrowserAuthenticationRepository } from "../../src/services/identity/browserAuthenticationRepository.js";
import { createBrowserAuthenticationService } from "../../src/services/identity/browserAuthenticationService.js";

const accessTokens = createAccessTokenService({
  secret: "browser-auth-unit-secret-at-least-32-characters",
  issuer: "https://dhumi.test",
  audience: "dhumi-browser",
  ttlSeconds: 900,
});

const identity = {
  userId: randomUUID(),
  sessionId: randomUUID(),
  tenantId: randomUUID(),
};

function repository(active = true): BrowserAuthenticationRepository & {
  calls: Array<{ userId: string; sessionId: string }>;
} {
  const calls: Array<{ userId: string; sessionId: string }> = [];
  return {
    calls,
    async hasActiveSession(input) {
      calls.push(input);
      return active;
    },
  };
}

describe("browser authentication service", () => {
  it("returns session identity only after JWT and PostgreSQL binding checks", async () => {
    const store = repository();
    const service = createBrowserAuthenticationService({ accessTokens, repository: store });
    const token = (await accessTokens.issue(identity)).token;

    await expect(service.authenticate(`Bearer ${token}`)).resolves.toEqual({
      userId: identity.userId,
      sessionId: identity.sessionId,
    });
    expect(store.calls).toEqual([{ userId: identity.userId, sessionId: identity.sessionId }]);
  });

  it("accepts a case-insensitive Bearer scheme", async () => {
    const service = createBrowserAuthenticationService({
      accessTokens,
      repository: repository(),
    });
    const token = (await accessTokens.issue(identity)).token;

    await expect(service.authenticate(`bearer ${token}`)).resolves.toMatchObject({
      sessionId: identity.sessionId,
    });
  });

  it("maps missing, malformed, and invalid JWT credentials to one generic 401", async () => {
    const store = repository();
    const service = createBrowserAuthenticationService({ accessTokens, repository: store });

    for (const authorization of [undefined, "Basic abc", "Bearer", "Bearer a b", "Bearer bad.jwt"]) {
      await expect(service.authenticate(authorization)).rejects.toMatchObject({
        status: 401,
        code: "AUTHENTICATION_REQUIRED",
      });
    }
    expect(store.calls).toHaveLength(0);
  });

  it("rejects signed claims that are not database-safe UUIDs", async () => {
    const store = repository();
    const service = createBrowserAuthenticationService({ accessTokens, repository: store });
    const token = (
      await accessTokens.issue({ ...identity, sessionId: "not-a-database-uuid" })
    ).token;

    await expect(service.authenticate(`Bearer ${token}`)).rejects.toMatchObject({
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
    });
    expect(store.calls).toHaveLength(0);
  });

  it("rejects a cryptographically valid token when its session is unavailable", async () => {
    const service = createBrowserAuthenticationService({
      accessTokens,
      repository: repository(false),
    });
    const token = (await accessTokens.issue(identity)).token;

    await expect(service.authenticate(`Bearer ${token}`)).rejects.toMatchObject({
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
    });
  });
});
