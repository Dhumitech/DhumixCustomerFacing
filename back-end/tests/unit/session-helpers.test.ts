import { createHash } from "node:crypto";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import type { AccessTokenConfig } from "../../src/config/environment.js";
import {
  ACCESS_TOKEN_PURPOSE,
  createAccessTokenService,
} from "../../src/helpers/accessToken.js";
import { createCsrfService } from "../../src/helpers/csrf.js";
import { createRefreshTokenService } from "../../src/helpers/refreshToken.js";

const SECRET = "unit-test-access-token-secret-at-least-32-chars";
const CONFIG: AccessTokenConfig = {
  secret: SECRET,
  issuer: "https://dhumi.test",
  audience: "dhumi-browser",
  ttlSeconds: 900,
};

const CLAIMS = {
  userId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  tenantId: "33333333-3333-4333-8333-333333333333",
} as const;

function key(secret = SECRET): Uint8Array {
  return new TextEncoder().encode(secret);
}

describe("access tokens", () => {
  const tokens = createAccessTokenService(CONFIG);

  it("round-trips every claim the downstream operations need", async () => {
    const issued = await tokens.issue(CLAIMS);

    expect(issued.expiresInSeconds).toBe(900);
    expect(await tokens.verify(issued.token)).toEqual(CLAIMS);
  });

  it("rejects a token signed with a different secret", async () => {
    const foreign = createAccessTokenService({ ...CONFIG, secret: `${SECRET}-other` });
    const issued = await foreign.issue(CLAIMS);

    expect(await tokens.verify(issued.token)).toBeUndefined();
  });

  it("rejects a wrong issuer", async () => {
    const other = createAccessTokenService({ ...CONFIG, issuer: "https://evil.test" });
    expect(await tokens.verify((await other.issue(CLAIMS)).token)).toBeUndefined();
  });

  it("rejects a wrong audience", async () => {
    const other = createAccessTokenService({ ...CONFIG, audience: "someone-else" });
    expect(await tokens.verify((await other.issue(CLAIMS)).token)).toBeUndefined();
  });

  it("rejects an expired token", async () => {
    const expired = await new SignJWT({
      sid: CLAIMS.sessionId,
      tid: CLAIMS.tenantId,
      pur: ACCESS_TOKEN_PURPOSE,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(CLAIMS.userId)
      .setIssuer(CONFIG.issuer)
      .setAudience(CONFIG.audience)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(key());

    expect(await tokens.verify(expired)).toBeUndefined();
  });

  it("rejects a token minted for a different purpose", async () => {
    const wrongPurpose = await new SignJWT({
      sid: CLAIMS.sessionId,
      tid: CLAIMS.tenantId,
      pur: "password_reset",
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(CLAIMS.userId)
      .setIssuer(CONFIG.issuer)
      .setAudience(CONFIG.audience)
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(key());

    expect(await tokens.verify(wrongPurpose)).toBeUndefined();
  });

  it("rejects an unsigned token claiming alg none", async () => {
    // The classic algorithm-confusion attack. Pinning algorithms is what stops
    // a caller choosing the algorithm their token is verified with.
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sub: CLAIMS.userId,
        sid: CLAIMS.sessionId,
        tid: CLAIMS.tenantId,
        pur: ACCESS_TOKEN_PURPOSE,
        iss: CONFIG.issuer,
        aud: CONFIG.audience,
        exp: Math.floor(Date.now() / 1000) + 900,
      }),
    ).toString("base64url");

    expect(await tokens.verify(`${header}.${payload}.`)).toBeUndefined();
  });

  it("rejects a token missing the tenant claim", async () => {
    const noTenant = await new SignJWT({ sid: CLAIMS.sessionId, pur: ACCESS_TOKEN_PURPOSE })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(CLAIMS.userId)
      .setIssuer(CONFIG.issuer)
      .setAudience(CONFIG.audience)
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(key());

    expect(await tokens.verify(noTenant)).toBeUndefined();
  });

  it("returns undefined rather than throwing on rubbish input", async () => {
    expect(await tokens.verify("")).toBeUndefined();
    expect(await tokens.verify("not.a.token")).toBeUndefined();
  });
});

describe("refresh tokens", () => {
  const refresh = createRefreshTokenService();

  it("generates a distinct high-entropy value each time", () => {
    const values = new Set(Array.from({ length: 50 }, () => refresh.generate()));

    expect(values.size).toBe(50);
    // 32 random bytes in base64url.
    for (const value of values) {
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it("stores only a hash, and the plaintext is not recoverable from it", () => {
    const token = refresh.generate();
    const hash = refresh.hash(token);

    expect(hash).toHaveLength(32);
    expect(hash.toString("utf8")).not.toContain(token);
    expect(hash).toEqual(createHash("sha256").update(token, "utf8").digest());
  });

  it("matches the correct token and rejects any other", () => {
    const token = refresh.generate();
    const stored = refresh.hash(token);

    expect(refresh.matches(token, stored)).toBe(true);
    expect(refresh.matches(refresh.generate(), stored)).toBe(false);
    expect(refresh.matches("", stored)).toBe(false);
  });
});

describe("CSRF tokens", () => {
  const csrf = createCsrfService(SECRET);

  it("is stable for one session", () => {
    expect(csrf.issue(CLAIMS.sessionId)).toBe(csrf.issue(CLAIMS.sessionId));
  });

  it("differs between sessions and verifies only its own", () => {
    const other = "44444444-4444-4444-8444-444444444444";

    expect(csrf.issue(CLAIMS.sessionId)).not.toBe(csrf.issue(other));
    expect(csrf.verify(CLAIMS.sessionId, csrf.issue(CLAIMS.sessionId))).toBe(true);
    expect(csrf.verify(other, csrf.issue(CLAIMS.sessionId))).toBe(false);
  });

  it("cannot be forged without the signing secret", () => {
    const attacker = createCsrfService(`${SECRET}-guessed`);

    expect(csrf.verify(CLAIMS.sessionId, attacker.issue(CLAIMS.sessionId))).toBe(false);
  });

  it("rejects empty and malformed values without throwing", () => {
    expect(csrf.verify(CLAIMS.sessionId, "")).toBe(false);
    expect(csrf.verify(CLAIMS.sessionId, "short")).toBe(false);
  });
});
