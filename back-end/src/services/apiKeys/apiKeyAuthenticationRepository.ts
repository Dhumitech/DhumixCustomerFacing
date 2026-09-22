import type { Pool } from "pg";
import { API_SCOPES, type ApiScope } from "../../helpers/apiKeyMaterial.js";
import { ApplicationError } from "../../utils/applicationError.js";
import { withIdentityTransaction } from "../database/transactions.js";

export interface ApiKeyVerifierCandidate {
  readonly keyId: string;
  readonly keyHash: Buffer;
}

export interface ApiKeyFinalizationInput {
  readonly keyId: string;
  readonly prefix: string;
  readonly presentedHash: Buffer;
}

export type ApiKeyFinalizationOutcome =
  | {
      readonly status: "authenticated";
      readonly tenantId: string;
      readonly scopes: readonly ApiScope[];
    }
  | { readonly status: "credential_unavailable" }
  | { readonly status: "access_denied" };

export interface ApiKeyAuthenticationRepository {
  findVerifierCandidate(prefix: string): Promise<ApiKeyVerifierCandidate | undefined>;
  finalizeAuthentication(input: ApiKeyFinalizationInput): Promise<ApiKeyFinalizationOutcome>;
}

interface VerifierRow {
  readonly id: string;
  readonly key_hash: Buffer;
}

interface FinalizationRow {
  readonly tenant_id: string;
  readonly scopes: string[];
  readonly key_state: "active" | "revoked" | "expired";
  readonly tenant_state: "active" | "suspended" | "closing" | "closed";
  readonly expires_at: Date | null;
  readonly evaluated_at: Date;
}

function internalFailure(cause: unknown): ApplicationError {
  return new ApplicationError({
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Internal server error",
    cause,
  });
}

function validatedScopes(scopes: readonly string[]): readonly ApiScope[] {
  if (scopes.length === 0 || scopes.some((scope) => !API_SCOPES.includes(scope as ApiScope))) {
    throw internalFailure(new Error("Stored API-key scopes violate the application allowlist"));
  }
  return scopes as readonly ApiScope[];
}

export function createApiKeyAuthenticationRepository(
  pool: Pool,
): ApiKeyAuthenticationRepository {
  return {
    async findVerifierCandidate(prefix): Promise<ApiKeyVerifierCandidate | undefined> {
      try {
        return await withIdentityTransaction(pool, async (database) => {
          const result = await database.query<VerifierRow>(
            `
              SELECT id, key_hash
              FROM app.platform_api_keys
              WHERE key_prefix = $1
            `,
            [prefix],
          );
          const row = result.rows[0];
          return row === undefined ? undefined : { keyId: row.id, keyHash: row.key_hash };
        });
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw internalFailure(error);
      }
    },

    async finalizeAuthentication(input): Promise<ApiKeyFinalizationOutcome> {
      try {
        return await withIdentityTransaction(pool, async (database) => {
          const result = await database.query<FinalizationRow>(
            `
              SELECT
                api_key.tenant_id,
                api_key.scopes,
                api_key.state AS key_state,
                tenant.state AS tenant_state,
                api_key.expires_at,
                clock_timestamp() AS evaluated_at
              FROM app.platform_api_keys api_key
              JOIN app.tenants tenant
                ON tenant.id = api_key.tenant_id
              WHERE api_key.id = $1
                AND api_key.key_prefix = $2
                AND api_key.key_hash = $3
              FOR UPDATE OF api_key, tenant
            `,
            [input.keyId, input.prefix, input.presentedHash],
          );
          const row = result.rows[0];
          if (
            row === undefined ||
            row.key_state !== "active" ||
            (row.expires_at !== null && row.expires_at.getTime() <= row.evaluated_at.getTime())
          ) {
            return { status: "credential_unavailable" };
          }
          if (row.tenant_state !== "active") {
            return { status: "access_denied" };
          }

          const scopes = validatedScopes(row.scopes);
          const update = await database.query(
            `
              UPDATE app.platform_api_keys
              SET last_used_at = GREATEST(COALESCE(last_used_at, $2), $2)
              WHERE id = $1
            `,
            [input.keyId, row.evaluated_at],
          );
          if (update.rowCount !== 1) {
            throw internalFailure(new Error("The locked API key could not be marked as used"));
          }
          return { status: "authenticated", tenantId: row.tenant_id, scopes };
        });
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw internalFailure(error);
      }
    },
  };
}
