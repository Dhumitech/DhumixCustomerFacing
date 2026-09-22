import { SignJWT, jwtVerify } from "jose";
import type { AccessTokenConfig } from "../config/environment.js";

/**
 * Short-lived browser access token.
 *
 * `05_Security\01_Authentication_and_Keys.md` requires that a token validate
 * issuer, audience, algorithm, signature, expiry **and purpose** — five checks.
 * `purpose` exists so a token minted for one job cannot be replayed as another
 * when refresh or API-key tokens are added.
 *
 * The tenant claim is carried here because `dhumi_customer_api` cannot discover
 * a user's Tenant: its RLS policy is `tenant_id = app.current_tenant_id()`, so
 * it can only confirm access to a Tenant already named. The value is
 * backend-resolved and signed, never customer-supplied, and every consumer must
 * still re-verify it against an active `tenant_user_access` row.
 */
export const ACCESS_TOKEN_PURPOSE = "browser_access" as const;

const ALGORITHM = "HS256" as const;

export interface AccessTokenClaims {
  readonly userId: string;
  readonly sessionId: string;
  readonly tenantId: string;
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
  readonly tid?: unknown;
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
        tid: claims.tenantId,
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
        });

        const claims = payload as TokenPayload;
        if (claims.pur !== ACCESS_TOKEN_PURPOSE) {
          return undefined;
        }

        const userId = readString(payload.sub);
        const sessionId = readString(claims.sid);
        const tenantId = readString(claims.tid);
        if (userId === undefined || sessionId === undefined || tenantId === undefined) {
          return undefined;
        }

        return { userId, sessionId, tenantId };
      } catch {
        // A malformed, expired, wrongly signed or foreign token is simply not a
        // valid token. It must never be distinguishable from any other failure.
        return undefined;
      }
    },
  };
}
