import type { Pool, QueryResultRow } from "pg";
import { withJobManagerTenantTransaction } from "../../database/transactions.js";
import type {
  MarketplaceExecutionPlan,
  MarketplaceExecutionPlanRepository,
  MarketplaceReconciliationPlan,
} from "./marketplaceRunExecutor.js";

interface PlanRow extends QueryResultRow {
  readonly mapping_id: string;
  readonly provider_resource_aad_mapping_id: string;
  readonly validated_input: unknown;
  readonly validated_configuration: unknown;
  readonly template_slug: string;
  readonly template_version: number;
  readonly template_output_schema: unknown;
  readonly adapter_code: string;
  readonly provider_resource_ciphertext: Buffer;
  readonly provider_resource_fingerprint: Buffer;
  readonly output_policy: unknown;
  readonly provider_code: string;
  readonly provider_environment: string;
  readonly vault_secret_reference: string;
  readonly source_attempt_id: string;
  readonly source_provider_reference_ciphertext: Buffer | null;
  readonly source_provider_reference_fingerprint: Buffer | null;
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Marketplace execution plan contained an invalid object");
  }
  return value as Readonly<Record<string, unknown>>;
}

function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function mapPlan(row: PlanRow | undefined): MarketplaceExecutionPlan {
  if (
    row === undefined ||
    !uuid(row.mapping_id) ||
    !uuid(row.provider_resource_aad_mapping_id) ||
    !Buffer.isBuffer(row.provider_resource_ciphertext) ||
    row.provider_resource_ciphertext.byteLength < 30 ||
    !Buffer.isBuffer(row.provider_resource_fingerprint) ||
    row.provider_resource_fingerprint.byteLength !== 32 ||
    row.adapter_code !== "bright_data.marketplace.filter" ||
    row.provider_code !== "bright_data" ||
    row.provider_environment !== "test" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.template_slug) ||
    !Number.isSafeInteger(row.template_version) ||
    row.template_version < 1 ||
    row.vault_secret_reference.length < 1
  ) {
    throw new Error("Marketplace execution plan was unavailable or unsupported");
  }
  return {
    mappingId: row.mapping_id,
    providerResourceAadMappingId: row.provider_resource_aad_mapping_id,
    validatedInput: object(row.validated_input),
    validatedConfiguration: object(row.validated_configuration),
    templateSlug: row.template_slug,
    templateVersion: row.template_version,
    templateOutputSchema: object(row.template_output_schema),
    adapterCode: row.adapter_code,
    providerResourceCiphertext: row.provider_resource_ciphertext,
    providerResourceFingerprint: row.provider_resource_fingerprint,
    outputPolicy: object(row.output_policy),
    providerCode: row.provider_code,
    providerEnvironment: row.provider_environment,
    vaultSecretReference: row.vault_secret_reference,
  };
}

export function createMarketplaceExecutionPlanRepository(pool: Pool): MarketplaceExecutionPlanRepository {
  async function resolve(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly attemptId: string;
    readonly fenceToken: string;
    readonly reconciliation: boolean;
    readonly sourceAttemptId: string | null;
  }): Promise<PlanRow> {
    const result = await withJobManagerTenantTransaction(pool, input.tenantId, async (database) =>
      database.query<PlanRow>(
        "SELECT * FROM app.resolve_marketplace_execution_plan_fixture($1,$2,$3,$4,$5)",
        [input.runId, input.attemptId, input.fenceToken, input.reconciliation, input.sourceAttemptId],
      ),
    );
    const row = result.rows[0];
    if (row === undefined) throw Object.assign(new Error("Marketplace execution plan not found"), { code: "P0002" });
    return row;
  }

  return {
    async resolveSubmission(input) {
      return mapPlan(await resolve({ ...input, reconciliation: false, sourceAttemptId: null }));
    },
    async resolveReconciliation(input): Promise<MarketplaceReconciliationPlan> {
      const row = await resolve({ ...input, reconciliation: true, sourceAttemptId: input.sourceAttemptId });
      const base = mapPlan(row);
      if (
        !uuid(row.source_attempt_id) ||
        !Buffer.isBuffer(row.source_provider_reference_ciphertext) ||
        row.source_provider_reference_ciphertext.byteLength < 30 ||
        !Buffer.isBuffer(row.source_provider_reference_fingerprint) ||
        row.source_provider_reference_fingerprint.byteLength !== 32
      ) throw new Error("Marketplace reconciliation plan was incomplete");
      return {
        ...base,
        sourceAttemptId: row.source_attempt_id,
        sourceProviderReferenceCiphertext: row.source_provider_reference_ciphertext,
        sourceProviderReferenceFingerprint: row.source_provider_reference_fingerprint,
      };
    },
    async resolveNormalization(input) {
      return mapPlan(await resolve({
        ...input,
        reconciliation: input.attemptId !== input.sourceAttemptId,
        sourceAttemptId: input.sourceAttemptId,
      }));
    },
    async recordProviderReference(input) {
      const result = await withJobManagerTenantTransaction(pool, input.tenantId, async (database) =>
        database.query<{ recorded: boolean }>(
          "SELECT app.record_provider_reference_fenced($1,$2,$3,$4,$5) AS recorded",
          [input.runId, input.attemptId, input.fenceToken, input.ciphertext, input.fingerprint],
        ),
      );
      if (result.rows[0]?.recorded !== true) throw new Error("Marketplace Snapshot reference was not recorded");
    },
    async checkpointPoll(input) {
      const result = await withJobManagerTenantTransaction(pool, input.tenantId, async (database) =>
        database.query<{ remaining_ms: string; wait_ms: string; consecutive_failures: number }>(
          "SELECT * FROM app.checkpoint_provider_poll_fenced($1,$2,$3,$4,$5,$6,$7,$8)",
          [input.runId, input.attemptId, input.fenceToken, input.sourceAttemptId,
            input.maxElapsedMs, input.status ?? null, input.failure ?? null, input.delayMs ?? 0],
        ),
      );
      const row = result.rows[0];
      const remainingMs = Number(row?.remaining_ms);
      const waitMs = Number(row?.wait_ms);
      if (!Number.isSafeInteger(remainingMs) || !Number.isSafeInteger(waitMs) || !Number.isSafeInteger(row?.consecutive_failures)) {
        throw new Error("Marketplace poll checkpoint was incomplete");
      }
      return { remainingMs, waitMs, consecutiveFailures: row?.consecutive_failures ?? 0 };
    },
    async recordSnapshotObservation(input) {
      const result = await withJobManagerTenantTransaction(pool, input.tenantId, async (database) =>
        database.query<{ recorded: boolean }>(
          "SELECT app.record_marketplace_snapshot_observation_fenced($1,$2,$3,$4,$5,$6,$7,$8,$9) AS recorded",
          [input.runId, input.attemptId, input.fenceToken, input.sourceAttemptId,
            input.status, input.datasetSize, input.fileSize, input.costMicros, input.currencyCode],
        ),
      );
      if (result.rows[0]?.recorded !== true) throw new Error("Marketplace Snapshot observation was not recorded");
    },
    async recordKnownSubmissionOutcome(input) {
      const result = await withJobManagerTenantTransaction(pool, input.tenantId, async (database) =>
        database.query<{ recorded: boolean }>(
          "SELECT app.record_marketplace_known_submission_outcome_fenced($1,$2,$3,$4) AS recorded",
          [input.runId, input.attemptId, input.fenceToken, input.outcome],
        ),
      );
      if (result.rows[0]?.recorded !== true) throw new Error("Marketplace submission outcome was not recorded");
    },
    async isCancellationRequested(input) {
      const result = await withJobManagerTenantTransaction(pool, input.tenantId, async (database) =>
        database.query<{ cancellation_requested: boolean }>(
          "SELECT app.is_run_cancellation_requested_fenced($1,$2,$3) AS cancellation_requested",
          [input.runId, input.attemptId, input.fenceToken],
        ),
      );
      return result.rows[0]?.cancellation_requested === true;
    },
  };
}
