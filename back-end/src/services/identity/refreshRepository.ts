import type { Pool } from "pg";
import type { DatabaseExecutor } from "../../types/database.js";
import { ApplicationError } from "../../utils/applicationError.js";
import { withIdentityTransaction } from "../database/transactions.js";
import { expireSessionFamily, revokeSessionFamily } from "./sessionRevocation.js";

export interface RefreshRotationInput {
  readonly expectedSessionId: string;
  readonly presentedTokenHash: Buffer;
  readonly replacementTokenHash: Buffer;
  /** Must already be a UUID or null; audit_events.trace_id is uuid. */
  readonly requestId: string | null;
  readonly ipFingerprint: Buffer | null;
}

export type RefreshRotationOutcome =
  | {
      readonly kind: "rotated";
      readonly sessionId: string;
      readonly userId: string;
      readonly refreshExpiresAt: Date;
    }
  | { readonly kind: "reuse_detected" }
  | { readonly kind: "session_unavailable" };

export interface RefreshRepository {
  findSessionIdByTokenHash(tokenHash: Buffer): Promise<string | undefined>;
  rotate(input: RefreshRotationInput): Promise<RefreshRotationOutcome>;
}

interface LockedSessionRow {
  readonly session_id: string;
  readonly user_id: string;
  readonly session_state: "active" | "revoked" | "expired";
  readonly expires_at: Date;
  readonly is_expired: boolean;
}

interface LockedTokenRow {
  readonly token_id: string;
  readonly session_id: string;
  readonly generation: number;
  readonly token_state: "active" | "rotated" | "reused" | "revoked" | "expired";
}

type RefreshRow = LockedSessionRow & LockedTokenRow;

interface IdentityRow {
  readonly state: string;
}

function internalFailure(cause: unknown): ApplicationError {
  return new ApplicationError({
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Internal server error",
    cause,
  });
}

async function auditRefresh(
  database: DatabaseExecutor,
  input: RefreshRotationInput,
  session: RefreshRow,
  tenantId: string | null,
  outcome: string,
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
      ) VALUES ($1, $2, 'identity.refresh', 'auth_session', $3, $4, $5::uuid, $6)
    `,
    [tenantId, session.user_id, session.session_id, outcome, input.requestId, input.ipFingerprint],
  );
}

export function createRefreshRepository(pool: Pool): RefreshRepository {
  return {
    async findSessionIdByTokenHash(tokenHash: Buffer): Promise<string | undefined> {
      try {
        return await withIdentityTransaction(pool, async (database) => {
          const result = await database.query<{ session_id: string }>(
            `SELECT session_id FROM app.auth_refresh_tokens WHERE token_hash = $1`,
            [tokenHash],
          );
          return result.rows[0]?.session_id;
        });
      } catch (error) {
        throw internalFailure(error);
      }
    },

    async rotate(input: RefreshRotationInput): Promise<RefreshRotationOutcome> {
      try {
        return await withIdentityTransaction(pool, async (database) => {
          // Reset and refresh use user -> session -> token. Discovery alone
          // grants nothing; the locked session is rechecked afterwards.
          const discovered = await database.query<{ user_id: string }>(
            "SELECT user_id FROM app.auth_sessions WHERE id = $1", [input.expectedSessionId],
          );
          const ownerId = discovered.rows[0]?.user_id;
          if (!ownerId) return { kind: "session_unavailable" };
          const identityResult = await database.query<IdentityRow>(
            "SELECT state FROM app.users WHERE id = $1 FOR NO KEY UPDATE", [ownerId],
          );
          // Every session-family writer locks the session before any refresh
          // generation. This explicit order prevents logout and refresh from
          // each holding one row while waiting for the other.
          const sessionResult = await database.query<LockedSessionRow>(
            `
              SELECT
                id AS session_id,
                user_id,
                state AS session_state,
                expires_at,
                clock_timestamp() >= expires_at AS is_expired
              FROM app.auth_sessions
              WHERE id = $1
              FOR UPDATE
            `,
            [input.expectedSessionId],
          );
          const lockedSession = sessionResult.rows[0];
          if (lockedSession === undefined || lockedSession.user_id !== ownerId) {
            return { kind: "session_unavailable" };
          }

          if (lockedSession.session_state !== "active") {
            return { kind: "session_unavailable" };
          }

          const tokenResult = await database.query<LockedTokenRow>(
            `
              SELECT
                id AS token_id,
                session_id,
                generation,
                state AS token_state
              FROM app.auth_refresh_tokens
              WHERE token_hash = $1
                AND session_id = $2
              FOR UPDATE
            `,
            [input.presentedTokenHash, input.expectedSessionId],
          );
          const lockedToken = tokenResult.rows[0];
          if (lockedToken === undefined) {
            return { kind: "session_unavailable" };
          }

          const session: RefreshRow = { ...lockedSession, ...lockedToken };

          if (session.is_expired) {
            await expireSessionFamily(database, session.session_id);
            await auditRefresh(database, input, session, null, "denied_expired");
            return { kind: "session_unavailable" };
          }

          if (session.token_state === "rotated") {
            // A token that successfully rotated once is being presented again.
            // Revoke the complete family in this same locked transaction so a
            // concurrent request cannot receive another valid generation.
            await revokeSessionFamily(database, session.session_id, "refresh_reuse");
            await database.query(
              `
                UPDATE app.auth_refresh_tokens
                SET state = 'reused', ended_at = clock_timestamp()
                WHERE id = $1 AND state = 'rotated'
              `,
              [session.token_id],
            );
            await auditRefresh(database, input, session, null, "denied_reuse");
            await database.query(
              `
                INSERT INTO app.outbox_events (
                  aggregate_type,
                  aggregate_id,
                  topic,
                  ordering_key,
                  payload
                ) VALUES (
                  'auth_session',
                  $1::uuid,
                  'security.refresh_token_reuse',
                  $1::text,
                  jsonb_build_object(
                    'session_id', $1::uuid,
                    'user_id', $2::uuid,
                    'reason', 'rotated_token_reused'
                  )
                )
              `,
              [session.session_id, session.user_id],
            );
            return { kind: "reuse_detected" };
          }

          if (session.token_state !== "active") {
            return { kind: "session_unavailable" };
          }

          // A valid cookie must still belong to an active, locked-read user.
          const identity = identityResult.rows[0];
          if (identity?.state !== "active") {
            await revokeSessionFamily(database, session.session_id, "identity_unavailable");
            await auditRefresh(database, input, session, null, "denied_identity");
            return { kind: "session_unavailable" };
          }

          await database.query(
            `
              UPDATE app.auth_refresh_tokens
              SET state = 'rotated', ended_at = clock_timestamp()
              WHERE id = $1 AND state = 'active'
            `,
            [session.token_id],
          );
          await database.query(
            `
              INSERT INTO app.auth_refresh_tokens (
                session_id,
                token_hash,
                generation
              ) VALUES ($1, $2, $3)
            `,
            [session.session_id, input.replacementTokenHash, session.generation + 1],
          );
          await database.query(
            `
              UPDATE app.auth_sessions
              SET token_family_hash = $2
              WHERE id = $1 AND state = 'active'
            `,
            [session.session_id, input.replacementTokenHash],
          );
          await auditRefresh(database, input, session, null, "accepted");

          return {
            kind: "rotated",
            sessionId: session.session_id,
            userId: session.user_id,
            refreshExpiresAt: session.expires_at,
          };
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
