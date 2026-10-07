import type { Pool } from "pg";
import { withIdentityTransaction } from "../database/transactions.js";
import { ApplicationError } from "../../utils/applicationError.js";

/** Session issuance and audit remain one locked transaction. */

export interface IdentityRecord {
  readonly userId: string;
  readonly passwordHash: string;
  readonly state: string;
  readonly failedAuthCount: number;
  readonly lastFailedAuthAt: Date | null;
}

export interface SessionInsert {
  readonly userId: string;
  readonly tokenFamilyHash: Buffer;
  readonly expiresAt: Date;
}

export interface SessionAuthorization {
  readonly verifiedPasswordHash: string;
  readonly allowExpiredLock: boolean;
  readonly lockoutWindowMs: number;
}

export type SessionCreationOutcome =
  | { readonly kind: "created"; readonly sessionId: string }
  | { readonly kind: "identity_unavailable" };

export interface AuditInsert {
  readonly tenantId: string | null;
  readonly actorUserId: string | null;
  readonly action: string;
  readonly outcome: string;
  /** Must already be a UUID or null; `audit_events.trace_id` is `uuid`. */
  readonly requestId: string | null;
  readonly ipFingerprint: Buffer | null;
}

export interface SignInRepository {
  findIdentity(emailNormalized: string): Promise<IdentityRecord | undefined>;
  recordFailure(audit: AuditInsert, userId: string | null, lockAt: number): Promise<void>;
  createSession(
    session: SessionInsert,
    audit: AuditInsert,
    authorization: SessionAuthorization,
  ): Promise<SessionCreationOutcome>;
  updatePasswordHash(userId: string, passwordHash: string, expectedHash: string): Promise<void>;
}

interface IdentityRow {
  readonly id: string;
  readonly password_hash: string;
  readonly state: string;
  readonly failed_auth_count: number;
  readonly last_failed_auth_at: Date | null;
}

interface CurrentIdentityRow {
  readonly password_hash: string;
  readonly state: string;
  readonly lock_expired: boolean;
}

function internalFailure(cause: unknown): ApplicationError {
  return new ApplicationError({
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Internal server error",
    cause,
  });
}

const AUDIT_INSERT = `
  INSERT INTO app.audit_events
    (organization_id, actor_user_id, action, target_type, target_id, outcome,
     trace_id, ip_fingerprint)
  VALUES ($1, $2, $3, 'user', $2, $4, $5::uuid, $6)
`;

export function createSignInRepository(pool: Pool): SignInRepository {
  return {
    async findIdentity(emailNormalized: string): Promise<IdentityRecord | undefined> {
      const result = await withIdentityTransaction(pool, async (database) =>
        database.query<IdentityRow>(
          `
            SELECT id, password_hash, state, failed_auth_count, last_failed_auth_at
            FROM app.users
            WHERE email_normalized = $1
          `,
          [emailNormalized],
        ),
      );

      const row = result.rows[0];
      if (row === undefined) {
        return undefined;
      }

      return {
        userId: row.id,
        passwordHash: row.password_hash,
        state: row.state,
        failedAuthCount: row.failed_auth_count,
        lastFailedAuthAt: row.last_failed_auth_at,
      };
    },

    /**
     * Records a failed attempt.
     *
     * Runs even though the request returns 401: the counter is the whole point.
     * `lockAt` of 0 disables locking, so an unknown identity still produces an
     * audit row without inventing a user to lock.
     */
    async recordFailure(
      audit: AuditInsert,
      userId: string | null,
      lockAt: number,
    ): Promise<void> {
      try {
        await withIdentityTransaction(pool, async (database) => {
          if (userId !== null) {
            // The lock decision is made in the same statement that increments,
            // so two concurrent failures cannot both read a stale count and
            // leave the account one short of the threshold.
            await database.query(
              `
                UPDATE app.users
                SET failed_auth_count = failed_auth_count + 1,
                    last_failed_auth_at = clock_timestamp(),
                    state = CASE
                      WHEN $2 > 0 AND failed_auth_count + 1 >= $2 AND state = 'active'
                        THEN 'locked'
                      ELSE state
                    END
                WHERE id = $1
              `,
              [userId, lockAt],
            );
          }

          await database.query(AUDIT_INSERT, [
            audit.tenantId,
            audit.actorUserId,
            audit.action,
            audit.outcome,
            audit.requestId,
            audit.ipFingerprint,
          ]);
        });
      } catch (error) {
        // A failed audit write must not turn a rejected sign-in into a 500 that
        // tells the caller something different happened. Surface it as the same
        // internal error the caller would otherwise never see.
        throw internalFailure(error);
      }
    },

    /**
     * Creates the session, resets the failure counters and audits, in one
     * transaction. A success that failed to clear `failed_auth_count` would
     * drift the account toward a lockout it never earned.
     */
    async createSession(
      session: SessionInsert,
      audit: AuditInsert,
      authorization: SessionAuthorization,
    ): Promise<SessionCreationOutcome> {
      try {
        return await withIdentityTransaction(pool, async (database) => {
          // The identity and lock timestamp were read in an earlier transaction.
          // Re-read both while holding the User row lock so a failure that
          // refreshes a lock between the two reads cannot be cleared here.
          const currentIdentity = await database.query<CurrentIdentityRow>(
            `
              SELECT
                state,
                password_hash,
                state = 'locked'
                  AND last_failed_auth_at IS NOT NULL
                  AND clock_timestamp() >=
                    last_failed_auth_at + ($2::bigint * interval '1 millisecond')
                  AS lock_expired
              FROM app.users
              WHERE id = $1
              FOR NO KEY UPDATE
            `,
            [session.userId, authorization.lockoutWindowMs],
          );
          const identity = currentIdentity.rows[0];
          if (identity === undefined || identity.password_hash !== authorization.verifiedPasswordHash) {
            return { kind: "identity_unavailable" };
          }

          const expiredLockIsUsable =
            authorization.allowExpiredLock &&
            identity.state === "locked" &&
            identity.lock_expired;
          if (identity.state !== "active" && !expiredLockIsUsable) {
            return { kind: "identity_unavailable" };
          }

          const inserted = await database.query<{ id: string }>(
            `
              INSERT INTO app.auth_sessions
                (user_id, token_family_hash, expires_at)
              VALUES ($1, $2, $3)
              RETURNING id
            `,
            [
              session.userId,
              session.tokenFamilyHash,
              session.expiresAt,
            ],
          );

          await database.query(
            `
              UPDATE app.users
              SET failed_auth_count = 0,
                  last_failed_auth_at = NULL,
                  -- A lock whose window has elapsed is cleared here, on the
                  -- proof of a correct password. Only 'locked' is restored;
                  -- suspended and closed never reach this statement because
                  -- the service rejects them before a session is created.
                  state = CASE WHEN state = 'locked' THEN 'active' ELSE state END
              WHERE id = $1
            `,
            [session.userId],
          );

          await database.query(AUDIT_INSERT, [
            audit.tenantId,
            audit.actorUserId,
            audit.action,
            audit.outcome,
            audit.requestId,
            audit.ipFingerprint,
          ]);

          const row = inserted.rows[0];
          if (row === undefined) {
            throw internalFailure(new Error("auth_sessions insert returned no row"));
          }

          // Generation history is what lets refresh distinguish a genuinely
          // reused token from an unrelated invalid secret. The same hash is
          // retained on auth_sessions as the current-family pointer during the
          // forward-compatible migration from the original schema.
          await database.query(
            `
              INSERT INTO app.auth_refresh_tokens
                (session_id, token_hash, generation)
              VALUES ($1, $2, 1)
            `,
            [row.id, session.tokenFamilyHash],
          );

          return { kind: "created", sessionId: row.id };
        });
      } catch (error) {
        if (error instanceof ApplicationError) {
          throw error;
        }
        throw internalFailure(error);
      }
    },

    /** Applied after a correct password when the stored cost is below current. */
    async updatePasswordHash(userId: string, passwordHash: string, expectedHash: string): Promise<void> {
      await withIdentityTransaction(pool, async (database) =>
        database.query(`UPDATE app.users SET password_hash = $2 WHERE id = $1 AND password_hash = $3 AND state = 'active'`, [
          userId,
          passwordHash,
          expectedHash,
        ]),
      );
    },
  };
}
