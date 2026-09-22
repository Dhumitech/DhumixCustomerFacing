import type { Pool, QueryResultRow } from "pg";
import { withJobManagerTenantTransaction } from "../../database/transactions.js";
import type { ControlledRunExecutionInput } from "../../jobs/controlledRunExecutor.js";
import type { ProviderExecutionPlanRepository } from "../providerExecutionPlanRepository.js";
import { ScraperContractError } from "../../scrapers/scraperProcessing.js";

export interface ScraperAdapterIdentity {
  readonly code: string; readonly version: string; readonly digest: string;
}
export type ScraperExecutionPhase = "submission" | "normalization" | "reconciliation";
export interface ScraperExecutionPlan {
  readonly identity: ScraperAdapterIdentity;
  readonly contract: unknown;
  readonly contractHash: string;
  readonly validatedInput: Readonly<Record<string, unknown>>;
  readonly providerEnvironment: string;
  readonly providerResourceAadMappingId: string;
  readonly providerResourceCiphertext: Buffer | null;
  readonly providerResourceFingerprint: Buffer | null;
  readonly vaultSecretReference: string | null;
  readonly sourceAttemptId: string;
  readonly sourceProviderReferenceCiphertext: Buffer | null;
  readonly sourceProviderReferenceFingerprint: Buffer | null;
}
export interface ScraperExecutionRepository extends Pick<ProviderExecutionPlanRepository,
  "checkpointPoll" | "recordProviderReference" | "isCancellationRequested"> {
  resolveIdentity(input: ControlledRunExecutionInput): Promise<ScraperAdapterIdentity>;
  resolvePlan(input: ControlledRunExecutionInput, phase: ScraperExecutionPhase, sourceAttemptId?: string): Promise<ScraperExecutionPlan>;
}
interface IdentityRow extends QueryResultRow {
  readonly adapter_code: string; readonly adapter_version: string; readonly adapter_digest: string;
}
interface PlanRow extends IdentityRow {
  readonly operation_code: string; readonly input_schema: unknown; readonly output_schema: unknown;
  readonly output_policy: Readonly<Record<string, unknown>>; readonly validated_input: Readonly<Record<string, unknown>>;
  readonly provider_environment: string; readonly provider_resource_aad_mapping_id: string;
  readonly provider_resource_ciphertext: Buffer | null; readonly provider_resource_fingerprint: Buffer | null;
  readonly vault_secret_reference: string | null; readonly source_attempt_id: string;
  readonly source_provider_reference_ciphertext: Buffer | null; readonly source_provider_reference_fingerprint: Buffer | null;
}
function identity(row: IdentityRow | undefined): ScraperAdapterIdentity {
  if (!row || !/^[a-z][a-z0-9_.-]{2,127}$/.test(row.adapter_code) ||
    !/^[a-zA-Z0-9_.-]{1,128}$/.test(row.adapter_version) || !/^[a-f0-9]{64}$/.test(row.adapter_digest)) throw new ScraperContractError();
  return { code: row.adapter_code, version: row.adapter_version, digest: row.adapter_digest };
}
export function createScraperExecutionRepository(pool: Pool, fenced: Pick<ProviderExecutionPlanRepository,
  "checkpointPoll" | "recordProviderReference" | "isCancellationRequested">): ScraperExecutionRepository {
  return {
    ...fenced,
    async resolveIdentity(input) {
      const result = await withJobManagerTenantTransaction(pool, input.tenantId, (database) =>
        database.query<IdentityRow>("SELECT * FROM app.resolve_provider_executor_identity($1,$2,$3)",
          [input.runId, input.attemptId, input.fenceToken]));
      return identity(result.rows[0]);
    },
    async resolvePlan(input, phase, sourceAttemptId) {
      const result = await withJobManagerTenantTransaction(pool, input.tenantId, (database) =>
        database.query<PlanRow>("SELECT * FROM app.resolve_shared_scraper_execution_plan($1,$2,$3,$4,$5)",
          [input.runId, input.attemptId, input.fenceToken, phase, sourceAttemptId ?? input.attemptId]));
      const row = result.rows[0];
      const resolvedIdentity = identity(row);
      if (!row || typeof row.output_policy?.scraper_contract_sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(row.output_policy.scraper_contract_sha256)) throw new ScraperContractError();
      return {
        identity: resolvedIdentity,
        contract: { operationCode: row.operation_code, inputSchema: row.input_schema, outputSchema: row.output_schema,
          processing: row.output_policy.scraper_processing },
        contractHash: row.output_policy.scraper_contract_sha256,
        validatedInput: row.validated_input,
        providerEnvironment: row.provider_environment,
        providerResourceAadMappingId: row.provider_resource_aad_mapping_id,
        providerResourceCiphertext: row.provider_resource_ciphertext,
        providerResourceFingerprint: row.provider_resource_fingerprint,
        vaultSecretReference: row.vault_secret_reference,
        sourceAttemptId: row.source_attempt_id,
        sourceProviderReferenceCiphertext: row.source_provider_reference_ciphertext,
        sourceProviderReferenceFingerprint: row.source_provider_reference_fingerprint,
      };
    },
  };
}
