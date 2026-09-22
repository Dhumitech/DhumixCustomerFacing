import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Browser refresh token.
 *
 * `app.auth_sessions` stores the current hash reference and
 * `app.auth_refresh_tokens` stores the hashed generation history needed for
 * reuse detection. The plaintext exists only in the secure cookie, so a
 * database disclosure cannot be replayed as a session.
 *
 * SHA-256 rather than a password hash is correct here: the token is 256 bits of
 * cryptographic randomness, not a low-entropy human secret, so there is nothing
 * for a slow hash to defend against and the lookup stays a single indexed read.
 */
const TOKEN_BYTES = 32;

export interface RefreshTokenService {
  generate(): string;
  hash(token: string): Buffer;
  matches(token: string, storedHash: Buffer): boolean;
}

export function createRefreshTokenService(): RefreshTokenService {
  return {
    generate(): string {
      return randomBytes(TOKEN_BYTES).toString("base64url");
    },

    hash(token: string): Buffer {
      return createHash("sha256").update(token, "utf8").digest();
    },

    matches(token: string, storedHash: Buffer): boolean {
      const candidate = createHash("sha256").update(token, "utf8").digest();
      if (candidate.length !== storedHash.length) {
        return false;
      }
      return timingSafeEqual(candidate, storedHash);
    },
  };
}
