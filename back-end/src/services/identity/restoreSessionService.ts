import type { Pool } from "pg";
import type { AccessTokenService } from "../../helpers/accessToken.js";
import type { CsrfService } from "../../helpers/csrf.js";
import type { RefreshTokenService } from "../../helpers/refreshToken.js";
import { withIdentityTransaction } from "../database/transactions.js";
import { authenticationRequired } from "./sessionErrors.js";

export interface RestoredSession {
  accessToken: string; expiresInSeconds: number; csrfToken: string; identityEmail: string;
}
export interface RestoreSessionService { restore(refreshToken: string | undefined): Promise<RestoredSession> }

/** Read-only bootstrap: possession of a live HttpOnly cookie, never a selector. */
export function createRestoreSessionService(input: { pool: Pool; accessTokens: AccessTokenService; csrf: CsrfService; refreshTokens: RefreshTokenService }): RestoreSessionService {
  return { async restore(token) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw authenticationRequired();
    const session = await withIdentityTransaction(input.pool, async db => {
      const result = await db.query<{ id: string; user_id: string; email_normalized: string }>(`
        SELECT s.id, s.user_id, u.email_normalized FROM app.auth_refresh_tokens t
        JOIN app.auth_sessions s ON s.id = t.session_id JOIN app.users u ON u.id = s.user_id
        WHERE t.token_hash = $1 AND t.state = 'active' AND s.state = 'active'
          AND s.expires_at > clock_timestamp() AND u.state = 'active'`, [input.refreshTokens.hash(token)]);
      return result.rows[0];
    });
    if (!session) throw authenticationRequired();
    const issued = await input.accessTokens.issue({ userId: session.user_id, sessionId: session.id });
    return { accessToken: issued.token, expiresInSeconds: issued.expiresInSeconds, csrfToken: input.csrf.issue(session.id), identityEmail: session.email_normalized };
  } };
}
