import type { Pool } from "pg";
import type { DatabaseExecutor } from "../../types/database.js";
import { ApplicationError } from "../../utils/applicationError.js";
import { withTenantTransaction } from "../database/transactions.js";

export interface RevokeApiKeyRepositoryInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly keyId: string;
  /** Must already be a UUID or null; audit_events.request_id is uuid. */
  readonly requestId: string | null;
  readonly ipFingerprint: Buffer | null;
}

export type RevokeApiKeyOutcome = "revoked" | "already_inactive" | "not_found";

export interface RevokeApiKeyRepository {
  revoke(input: RevokeApiKeyRepositoryInput): Promise<RevokeApiKeyOutcome>;
}

interface LockedApiKeyRow {
  readonly key_prefix: string;
  readonly state: "active" | "revoked" | "expired";
  readonly expires_at: Date | null;
  readonly evaluated_at: Date;
}

interface UpdatedApiKeyRow {
  readonly id: string;
}

function internalFailure(cause: unknown): ApplicationError {
  return new ApplicationError({
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Internal server error",
    cause,
  });
}

async function lockVisibleKey(
  database: DatabaseExecutor,
  input: RevokeApiKeyRepositoryInput,
): Promise<LockedApiKeyRow | undefined> {
  const result = await database.query<LockedApiKeyRow>(
    `
      SELECT
        state,
        key_prefix,
        expires_at,
        clock_timestamp() AS evaluated_at
      FROM app.platform_api_keys
      WHERE tenant_id = $1
        AND id = $2
      FOR UPDATE
    `,
    [input.tenantId, input.keyId],
  );
  return result.rows[0];
}

function isEffectivelyInactive(key: LockedApiKeyRow): boolean {
  return (
    key.state !== "active" ||
    (key.expires_at !== null && key.expires_at.getTime() <= key.evaluated_at.getTime())
  );
}

async function transitionKey(
  database: DatabaseExecutor,
  input: RevokeApiKeyRepositoryInput,
  evaluatedAt: Date,
): Promise<void> {
  const result = await database.query<UpdatedApiKeyRow>(
    `
      UPDATE app.platform_api_keys
      SET
        state = 'revoked',
        revoked_at = $3
      WHERE tenant_id = $1
        AND id = $2
        AND state = 'active'
        AND (expires_at IS NULL OR expires_at > $3)
      RETURNING id
    `,
    [input.tenantId, input.keyId, evaluatedAt],
  );
  if (result.rows[0] === undefined) {
    throw internalFailure(new Error("The locked API key could not be revoked"));
  }
}

async function auditRevocation(
  database: DatabaseExecutor,
  input: RevokeApiKeyRepositoryInput,
): Promise<void> {
  await database.query(
    `
      INSERT INTO app.audit_events (
        tenant_id,
        actor_user_id,
        action,
        target_type,
        target_id,
        outcome,
        request_id,
        ip_fingerprint,
        safe_diff
      ) VALUES (
        $1,
        $2,
        'api_keys.revoke',
        'platform_api_key',
        $3,
        'revoked',
        $4,
        $5,
        jsonb_build_object('state_from', 'active', 'state_to', 'revoked')
      )
    `,
    [input.tenantId, input.userId, input.keyId, input.requestId, input.ipFingerprint],
  );
}

async function enqueueInvalidation(
  database: DatabaseExecutor,
  input: RevokeApiKeyRepositoryInput,
  keyPrefix: string,
): Promise<void> {
  await database.query(
    `
      INSERT INTO app.outbox_events (
        aggregate_type,
        aggregate_id,
        tenant_id,
        topic,
        ordering_key,
        payload,
        schema_version
      ) VALUES (
        'platform_api_key',
        $1::uuid,
        $2::uuid,
        'security.api_key_revoked',
        ($1::uuid)::text,
        jsonb_build_object('api_key_id', $1::uuid, 'key_prefix', $3::text),
        2
      )
    `,
    [input.keyId, input.tenantId, keyPrefix],
  );
}

export function createRevokeApiKeyRepository(pool: Pool): RevokeApiKeyRepository {
  return {
    async revoke(input): Promise<RevokeApiKeyOutcome> {
      try {
        return await withTenantTransaction(pool, input.tenantId, async (database) => {
          const key = await lockVisibleKey(database, input);
          if (key === undefined) return "not_found";
          if (isEffectivelyInactive(key)) return "already_inactive";

          await transitionKey(database, input, key.evaluated_at);
          await auditRevocation(database, input);
          await enqueueInvalidation(database, input, key.key_prefix);
          return "revoked";
        });
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw internalFailure(error);
      }
    },
  };
}
