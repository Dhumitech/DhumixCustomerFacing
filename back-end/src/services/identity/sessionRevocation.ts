import type { DatabaseExecutor } from "../../types/database.js";

/** Caller must hold the session row lock before invoking this helper. */
export async function revokeSessionFamily(
  database: DatabaseExecutor,
  sessionId: string,
  reason: string,
): Promise<void> {
  await database.query(
    `
      UPDATE app.auth_sessions
      SET state = 'revoked',
          revoked_at = COALESCE(revoked_at, clock_timestamp()),
          revoked_reason = $2::text
      WHERE id = $1
        AND state = 'active'
    `,
    [sessionId, reason],
  );
  await database.query(
    `
      UPDATE app.auth_refresh_tokens
      SET state = 'revoked',
          ended_at = COALESCE(ended_at, clock_timestamp())
      WHERE session_id = $1
        AND state = 'active'
    `,
    [sessionId],
  );
}

/** Caller must hold the session row lock before invoking this helper. */
export async function expireSessionFamily(
  database: DatabaseExecutor,
  sessionId: string,
): Promise<void> {
  await database.query(
    `
      UPDATE app.auth_sessions
      SET state = 'expired'
      WHERE id = $1
        AND state = 'active'
    `,
    [sessionId],
  );
  await database.query(
    `
      UPDATE app.auth_refresh_tokens
      SET state = 'expired',
          ended_at = COALESCE(ended_at, clock_timestamp())
      WHERE session_id = $1
        AND state = 'active'
    `,
    [sessionId],
  );
}
