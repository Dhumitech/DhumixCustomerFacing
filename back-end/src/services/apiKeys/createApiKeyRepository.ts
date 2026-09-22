import type { Pool } from "pg";
import type { ApiScope } from "../../helpers/apiKeyMaterial.js";
import type { DatabaseExecutor } from "../../types/database.js";
import { ApplicationError } from "../../utils/applicationError.js";
import { withTenantTransaction } from "../database/transactions.js";

export interface CreateApiKeyPersistenceInput {
  readonly idempotencyRecordId: string;
  readonly apiKeyId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly actorFingerprint: Buffer;
  readonly requestHash: Buffer;
  readonly name: string;
  readonly scopes: readonly ApiScope[];
  readonly keyPrefix: string;
  readonly keyHash: Buffer;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly envelopeCiphertext: Buffer;
  readonly envelopeKeyReference: string;
  readonly requestId: string | null;
  readonly ipFingerprint: Buffer | null;
}

export type CreateApiKeyPersistenceOutcome =
  | { readonly kind: "created" }
  | {
      readonly kind: "replay";
      readonly idempotencyRecordId: string;
      readonly apiKeyId: string;
      readonly envelopeCiphertext: Buffer;
      readonly envelopeKeyReference: string;
    }
  | { readonly kind: "conflict" }
  | { readonly kind: "expired" };

export interface CreateApiKeyRepository {
  persist(input: CreateApiKeyPersistenceInput): Promise<CreateApiKeyPersistenceOutcome>;
}

interface ClaimRow {
  readonly id: string;
}

interface ExistingClaimRow {
  readonly id: string;
  readonly actor_fingerprint: Buffer;
  readonly request_hash: Buffer;
  readonly state: "in_progress" | "completed" | "failed";
  readonly resource_id: string | null;
  readonly response_envelope_ciphertext: Buffer | null;
  readonly response_envelope_key_reference: string | null;
  readonly recoverable: boolean;
}

export class ApiKeyMaterialCollisionError extends Error {
  public constructor(cause: unknown) {
    super("Generated API-key material collided", { cause });
    this.name = "ApiKeyMaterialCollisionError";
  }
}

function internalFailure(cause: unknown): ApplicationError {
  return new ApplicationError({
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Internal server error",
    cause,
  });
}

function databaseErrorField(error: unknown, field: "code" | "constraint"): string | undefined {
  if (typeof error !== "object" || error === null || !(field in error)) return undefined;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function isGeneratedMaterialCollision(error: unknown): boolean {
  const constraint = databaseErrorField(error, "constraint");
  return (
    databaseErrorField(error, "code") === "23505" &&
    (constraint === "platform_api_keys_key_prefix_key" ||
      constraint === "platform_api_keys_key_hash_key")
  );
}

async function insertClaim(
  database: DatabaseExecutor,
  input: CreateApiKeyPersistenceInput,
): Promise<boolean> {
  const result = await database.query<ClaimRow>(
    `
      INSERT INTO app.idempotency_records (
        id,
        tenant_id,
        scope_kind,
        actor_fingerprint,
        operation_code,
        idempotency_key,
        request_hash,
        state,
        expires_at
      ) VALUES ($1, $2, 'tenant', $3, 'api_keys.create', $4, $5, 'in_progress',
        clock_timestamp() + interval '10 minutes')
      ON CONFLICT DO NOTHING
      RETURNING id
    `,
    [
      input.idempotencyRecordId,
      input.tenantId,
      input.actorFingerprint,
      input.idempotencyKey,
      input.requestHash,
    ],
  );
  return result.rows[0] !== undefined;
}

async function completeNewClaim(
  database: DatabaseExecutor,
  input: CreateApiKeyPersistenceInput,
): Promise<void> {
  await database.query(
    `
      INSERT INTO app.platform_api_keys (
        id,
        tenant_id,
        creator_user_id,
        name,
        key_prefix,
        key_hash,
        scopes,
        state,
        created_at,
        expires_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::text[], 'active', $8, $9, $8)
    `,
    [
      input.apiKeyId,
      input.tenantId,
      input.userId,
      input.name,
      input.keyPrefix,
      input.keyHash,
      input.scopes,
      input.createdAt,
      input.expiresAt,
    ],
  );

  const completion = await database.query<ClaimRow>(
    `
      UPDATE app.idempotency_records
      SET
        state = 'completed',
        response_status = 201,
        resource_type = 'platform_api_key',
        resource_id = $2,
        response_body_reference = 'encrypted_response_envelope',
        response_envelope_ciphertext = $3,
        response_envelope_key_reference = $4,
        response_envelope_recoverable_until = expires_at,
        completed_at = clock_timestamp(),
        updated_at = clock_timestamp()
      WHERE id = $1
      RETURNING id
    `,
    [
      input.idempotencyRecordId,
      input.apiKeyId,
      input.envelopeCiphertext,
      input.envelopeKeyReference,
    ],
  );
  if (completion.rows[0] === undefined) {
    throw internalFailure(new Error("The API-key idempotency claim disappeared"));
  }

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
        $1, $2, 'api_keys.create', 'platform_api_key', $3, 'created', $4, $5,
        jsonb_build_object('name', $6::text, 'scopes', $7::text[], 'expires_at', $8::timestamptz)
      )
    `,
    [
      input.tenantId,
      input.userId,
      input.apiKeyId,
      input.requestId,
      input.ipFingerprint,
      input.name,
      input.scopes,
      input.expiresAt,
    ],
  );
}

async function classifyExistingClaim(
  database: DatabaseExecutor,
  input: CreateApiKeyPersistenceInput,
): Promise<CreateApiKeyPersistenceOutcome> {
  const result = await database.query<ExistingClaimRow>(
    `
      SELECT
        id,
        actor_fingerprint,
        request_hash,
        state,
        resource_id,
        response_envelope_ciphertext,
        response_envelope_key_reference,
        response_envelope_recoverable_until > clock_timestamp() AS recoverable
      FROM app.idempotency_records
      WHERE tenant_id = $1
        AND operation_code = 'api_keys.create'
        AND idempotency_key = $2
      FOR UPDATE
    `,
    [input.tenantId, input.idempotencyKey],
  );
  const existing = result.rows[0];
  if (existing === undefined) {
    throw internalFailure(new Error("A conflicting API-key idempotency claim was not visible"));
  }
  if (
    !existing.actor_fingerprint.equals(input.actorFingerprint) ||
    !existing.request_hash.equals(input.requestHash)
  ) {
    return { kind: "conflict" };
  }
  if (
    existing.state !== "completed" ||
    existing.resource_id === null
  ) {
    throw internalFailure(new Error("The API-key idempotency claim is not complete"));
  }
  if (
    !existing.recoverable ||
    existing.response_envelope_ciphertext === null ||
    existing.response_envelope_key_reference === null
  ) {
    return { kind: "expired" };
  }
  return {
    kind: "replay",
    idempotencyRecordId: existing.id,
    apiKeyId: existing.resource_id,
    envelopeCiphertext: existing.response_envelope_ciphertext,
    envelopeKeyReference: existing.response_envelope_key_reference,
  };
}

export function createApiKeyRepository(pool: Pool): CreateApiKeyRepository {
  return {
    async persist(input): Promise<CreateApiKeyPersistenceOutcome> {
      try {
        return await withTenantTransaction(pool, input.tenantId, async (database) => {
          if (await insertClaim(database, input)) {
            await completeNewClaim(database, input);
            return { kind: "created" };
          }
          return classifyExistingClaim(database, input);
        });
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        if (isGeneratedMaterialCollision(error)) {
          throw new ApiKeyMaterialCollisionError(error);
        }
        throw internalFailure(error);
      }
    },
  };
}
