import type { Pool } from "pg";
import type { DatabaseExecutor } from "../../types/database.js";
import { ApplicationError } from "../../utils/applicationError.js";
import { withIdentityTransaction } from "../database/transactions.js";
import { expireSessionFamily, revokeSessionFamily } from "./sessionRevocation.js";

export interface LogoutInput {
  readonly userId: string;
  readonly sessionId: string;
  /** Must already be a UUID or null; audit_events.trace_id is uuid. */
  readonly requestId: string | null;
  readonly ipFingerprint: Buffer | null;
}

export type LogoutOutcome = "revoked" | "already_revoked" | "session_unavailable";

export interface LogoutRepository {
  revoke(input: LogoutInput): Promise<LogoutOutcome>;
}

interface SessionRow {
  readonly session_id: string;
  readonly user_id: string;
  readonly state: "active" | "revoked" | "expired";
  readonly is_expired: boolean;
}

function internalFailure(cause: unknown): ApplicationError {
  return new ApplicationError({
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Internal server error",
    cause,
  });
}

async function lockActiveGeneration(
  database: DatabaseExecutor,
  sessionId: string,
): Promise<void> {
  await database.query(
    `
      SELECT id
      FROM app.auth_refresh_tokens
      WHERE session_id = $1
        AND state = 'active'
      FOR UPDATE
    `,
    [sessionId],
  );
}

async function auditLogout(
  database: DatabaseExecutor,
  input: LogoutInput,
  tenantId: string | null,
): Promise<void> {
  await database.query(
    `
      INSERT INTO app.audit_events (
        organization_id,
        actor_user_id,
        action,
        target_type,
        target_id,
        outcome,
        trace_id,
        ip_fingerprint
      ) VALUES ($1, $2, 'identity.logout', 'auth_session', $3, 'accepted', $4::uuid, $5)
    `,
    [tenantId, input.userId, input.sessionId, input.requestId, input.ipFingerprint],
  );
}

export function createLogoutRepository(pool: Pool): LogoutRepository {
  return {
    async revoke(input): Promise<LogoutOutcome> {
      try {
        return await withIdentityTransaction(pool, async (database) => {
          // Canonical family lock order: session first, refresh generation second.
          // Refresh uses the same order, so the two operations serialize instead
          // of each holding one row while waiting for the other.
          const sessionResult = await database.query<SessionRow>(
            `
              SELECT
                id AS session_id,
                user_id,
                state,
                clock_timestamp() >= expires_at AS is_expired
              FROM app.auth_sessions
              WHERE id = $1
              FOR UPDATE
            `,
            [input.sessionId],
          );
          const session = sessionResult.rows[0];
          if (session === undefined || session.user_id !== input.userId) {
            return "session_unavailable";
          }
          if (session.state === "revoked") {
            return "already_revoked";
          }
          if (session.state !== "active") {
            return "session_unavailable";
          }

          await lockActiveGeneration(database, input.sessionId);
          if (session.is_expired) {
            await expireSessionFamily(database, input.sessionId);
            return "session_unavailable";
          }

          await revokeSessionFamily(database, input.sessionId, "logout");
          await auditLogout(database, input, null);
          return "revoked";
        });
      } catch (error) {
        if (error instanceof ApplicationError) {
          throw error;
        }
        throw internalFailure(error);
      }
    },
  };
}
