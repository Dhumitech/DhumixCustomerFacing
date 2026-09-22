import type { Pool } from "pg";
import type { ApiKeyListCursorPosition } from "../../helpers/apiKeyListCursor.js";
import type { ApiScope } from "../../helpers/apiKeyMaterial.js";
import { ApplicationError } from "../../utils/applicationError.js";
import { withTenantTransaction } from "../database/transactions.js";

export type ApiKeyMetadataState = "active" | "revoked" | "expired";

export interface ListApiKeysRecord {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly ApiScope[];
  readonly state: ApiKeyMetadataState;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface ListApiKeysRepositoryInput {
  readonly tenantId: string;
  readonly cursor: ApiKeyListCursorPosition | undefined;
  readonly fetchLimit: number;
}

export interface ListApiKeysRepository {
  list(input: ListApiKeysRepositoryInput): Promise<readonly ListApiKeysRecord[]>;
}

interface ListApiKeysRow {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: ApiScope[];
  readonly state: ApiKeyMetadataState;
  readonly created_at: Date;
  readonly last_used_at: Date | null;
  readonly expires_at: Date | null;
  readonly revoked_at: Date | null;
}

function internalFailure(cause: unknown): ApplicationError {
  return new ApplicationError({
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Internal server error",
    cause,
  });
}

export function createListApiKeysRepository(pool: Pool): ListApiKeysRepository {
  return {
    async list(input): Promise<readonly ListApiKeysRecord[]> {
      if (!Number.isInteger(input.fetchLimit) || input.fetchLimit < 2 || input.fetchLimit > 101) {
        throw new TypeError("fetchLimit must be an integer between 2 and 101");
      }

      try {
        return await withTenantTransaction(pool, input.tenantId, async (database) => {
          const result = await database.query<ListApiKeysRow>(
            `
              SELECT
                api_key.id,
                api_key.name,
                api_key.key_prefix AS prefix,
                api_key.scopes,
                CASE
                  WHEN api_key.state = 'revoked' THEN 'revoked'
                  WHEN api_key.state = 'expired'
                    OR (
                      api_key.expires_at IS NOT NULL
                      AND api_key.expires_at <= statement_timestamp()
                    ) THEN 'expired'
                  ELSE 'active'
                END AS state,
                api_key.created_at,
                api_key.last_used_at,
                api_key.expires_at,
                api_key.revoked_at
              FROM app.platform_api_keys AS api_key
              WHERE api_key.tenant_id = $1
                AND (
                  $2::timestamptz IS NULL
                  OR (api_key.created_at, api_key.id) < ($2::timestamptz, $3::uuid)
                )
              ORDER BY api_key.created_at DESC, api_key.id DESC
              LIMIT $4::integer
            `,
            [
              input.tenantId,
              input.cursor?.createdAt ?? null,
              input.cursor?.id ?? null,
              input.fetchLimit,
            ],
          );

          return result.rows.map((row) => ({
            id: row.id,
            name: row.name,
            prefix: row.prefix,
            scopes: row.scopes,
            state: row.state,
            createdAt: row.created_at,
            lastUsedAt: row.last_used_at,
            expiresAt: row.expires_at,
            revokedAt: row.revoked_at,
          }));
        });
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw internalFailure(error);
      }
    },
  };
}
