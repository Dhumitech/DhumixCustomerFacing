import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * CSRF token bound to one session.
 *
 * `app.auth_sessions` has no CSRF column, so the value is derived rather than
 * stored. Deriving it from the session id under a keyed HMAC means it cannot be
 * forged without the signing secret, and it is worthless against any session
 * other than the one it was issued for.
 *
 * Sign-in and refresh issue it. Only refresh and logout verify it, because they
 * are the state-changing browser operations the contract marks with a required
 * `X-CSRF-Token` header.
 */
export interface CsrfService {
  issue(sessionId: string): string;
  verify(sessionId: string, presented: string): boolean;
}

export function createCsrfService(secret: string): CsrfService {
  function derive(sessionId: string): string {
    return createHmac("sha256", secret).update(`csrf:${sessionId}`, "utf8").digest("base64url");
  }

  return {
    issue: derive,

    verify(sessionId: string, presented: string): boolean {
      const expected = Buffer.from(derive(sessionId), "utf8");
      const actual = Buffer.from(presented, "utf8");
      if (expected.length !== actual.length) {
        return false;
      }
      return timingSafeEqual(expected, actual);
    },
  };
}
