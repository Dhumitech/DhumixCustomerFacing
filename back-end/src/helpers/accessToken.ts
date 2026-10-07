import { SignJWT, jwtVerify } from "jose";
import type { AccessTokenConfig } from "../config/environment.js";

/**
 * Short-lived browser access token.
 *
 * `05_Security\01_Authentication_and_Keys.md` requires that a token validate
 * issuer, audience, algorithm, signature, expiry **and purpose** — five checks.
 * `purpose` exists so a token minted for one job cannot be replayed as another
 * when other token purposes are used.
 *
 * Organization selection belongs to each request, never to the session token.
 * Signed pre-0071 tokens may carry tid; verification ignores that claim.
 */
export const ACCESS_TOKEN_PURPOSE = "browser_access" as const;

const ALGORITHM = "HS256" as const;

export interface AccessTokenClaims {
  readonly userId: string;
  readonly sessionId: string;
}

export interface IssuedAccessToken {
  readonly token: string;
  readonly expiresInSeconds: number;
}

export interface AccessTokenService {
  issue(claims: AccessTokenClaims): Promise<IssuedAccessToken>;
  verify(token: string): Promise<AccessTokenClaims | undefined>;
}

interface TokenPayload {
  readonly sid?: unknown;
  readonly pur?: unknown;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function createAccessTokenService(config: AccessTokenConfig): AccessTokenService {
  const key = new TextEncoder().encode(config.secret);

  return {
    async issue(claims: AccessTokenClaims): Promise<IssuedAccessToken> {
      const token = await new SignJWT({
        sid: claims.sessionId,
        pur: ACCESS_TOKEN_PURPOSE,
      })
        .setProtectedHeader({ alg: ALGORITHM, typ: "JWT" })
        .setSubject(claims.userId)
        .setIssuer(config.issuer)
        .setAudience(config.audience)
        .setIssuedAt()
        .setJti(crypto.randomUUID())
        .setExpirationTime(`${config.ttlSeconds}s`)
        .sign(key);

      return { token, expiresInSeconds: config.ttlSeconds };
    },

    async verify(token: string): Promise<AccessTokenClaims | undefined> {
      try {
        const { payload } = await jwtVerify(token, key, {
          // Pinning the algorithm is what prevents an attacker presenting a
          // token with a different alg header and having it accepted.
          algorithms: [ALGORITHM],
          issuer: config.issuer,
          audience: config.audience,
          requiredClaims: ["sub", "iat", "exp"],
        });

        const claims = payload as TokenPayload;
        if (claims.pur !== ACCESS_TOKEN_PURPOSE) {
          return undefined;
        }

        const userId = readString(payload.sub);
        const sessionId = readString(claims.sid);
        if (userId === undefined || sessionId === undefined) {
          return undefined;
        }

        return { userId, sessionId };
      } catch {
        // A malformed, expired, wrongly signed or foreign token is simply not a
        // valid token. It must never be distinguishable from any other failure.
        return undefined;
      }
    },
  };
}
