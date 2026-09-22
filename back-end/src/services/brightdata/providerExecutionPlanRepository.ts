import type { Pool, QueryResultRow } from "pg";
import { withJobManagerTenantTransaction } from "../database/transactions.js";

export interface ProviderExecutionPlan {
  readonly mappingId: string;
  readonly providerResourceAadMappingId: string;
  readonly validatedInput: Readonly<Record<string, unknown>>;
  readonly operationCode: string;
  readonly providerResourceCiphertext: Buffer;
  readonly providerResourceFingerprint: Buffer;
  readonly outputPolicy: Readonly<Record<string, unknown>>;
  readonly mappingConfigVersion: string;
  readonly providerCode: string;
  readonly providerEnvironment: string;
  readonly vaultSecretReference: string;
}

export interface ProviderReconciliationPlan extends ProviderExecutionPlan {
  readonly sourceAttemptId: string;
  readonly sourceProviderReferenceCiphertext: Buffer;
  readonly sourceProviderReferenceFingerprint: Buffer;
}

export interface ProviderNormalizationPlan {
  readonly operationCode: string;
  readonly outputPolicy: Readonly<Record<string, unknown>>;
}

export interface ProviderExecutionPlanRepository {
  resolveExecutorKind(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly attemptId: string;
    readonly fenceToken: string;
  }): Promise<"amazon" | "marketplace">;
  checkpointPoll(input: {
    readonly tenantId: string; readonly runId: string; readonly attemptId: string;
    readonly fenceToken: string; readonly sourceAttemptId: string;
    readonly maxElapsedMs: number; readonly status?: string;
    readonly failure?: boolean; readonly delayMs?: number;
  }): Promise<{ readonly remainingMs: number; readonly waitMs: number; readonly consecutiveFailures: number }>;
  resolveSubmission(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly attemptId: string;
    readonly fenceToken: string;
  }): Promise<ProviderExecutionPlan>;
  recordProviderReference(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly attemptId: string;
    readonly fenceToken: string;
    readonly ciphertext: Buffer;
    readonly fingerprint: Buffer;
  }): Promise<void>;
  resolveReconciliation(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly attemptId: string;
    readonly fenceToken: string;
  }): Promise<ProviderReconciliationPlan>;
  resolveNormalization(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly attemptId: string;
    readonly fenceToken: string;
    readonly sourceAttemptId: string;
  }): Promise<ProviderNormalizationPlan>;
  isCancellationRequested(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly attemptId: string;
    readonly fenceToken: string;
  }): Promise<boolean>;
}

interface PlanRow extends QueryResultRow {
  readonly mapping_id: string;
  readonly provider_resource_aad_mapping_id: string;
  readonly validated_input: unknown;
  readonly operation_code: string;
  readonly provider_resource_ciphertext: Buffer;
  readonly provider_resource_fingerprint: Buffer;
  readonly output_policy: unknown;
  readonly mapping_config_version: string;
  readonly provider_code: string;
  readonly provider_environment: string;
  readonly vault_secret_reference: string;
}

interface ReconciliationPlanRow extends PlanRow {
  readonly source_attempt_id: string;
  readonly source_provider_reference_ciphertext: Buffer;
  readonly source_provider_reference_fingerprint: Buffer;
}

interface NormalizationPlanRow extends QueryResultRow {
  readonly operation_code: string;
  readonly output_policy: unknown;
}

function objectValue(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Provider execution plan returned invalid ${field}`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function mapPlan(row: PlanRow | undefined): ProviderExecutionPlan {
  if (
    row === undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      row.mapping_id,
    ) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      row.provider_resource_aad_mapping_id,
    ) ||
    !Buffer.isBuffer(row.provider_resource_ciphertext) ||
    row.provider_resource_ciphertext.byteLength < 30 ||
    !Buffer.isBuffer(row.provider_resource_fingerprint) ||
    row.provider_resource_fingerprint.byteLength !== 32 ||
    row.provider_code !== "bright_data" ||
    !/^[a-z][a-z0-9_.-]{2,127}$/.test(row.operation_code) ||
    !/^[a-zA-Z0-9_.:-]{1,128}$/.test(row.mapping_config_version)
  ) {
    throw new Error("Provider execution plan was incomplete or unsupported");
  }
  return {
    mappingId: row.mapping_id,
    providerResourceAadMappingId: row.provider_resource_aad_mapping_id,
    validatedInput: objectValue(row.validated_input, "validated input"),
    operationCode: row.operation_code,
    providerResourceCiphertext: row.provider_resource_ciphertext,
    providerResourceFingerprint: row.provider_resource_fingerprint,
    outputPolicy: objectValue(row.output_policy, "output policy"),
    mappingConfigVersion: row.mapping_config_version,
    providerCode: row.provider_code,
    providerEnvironment: row.provider_environment,
    vaultSecretReference: row.vault_secret_reference,
  };
}

export function providerMappingAad(mappingId: string): Buffer {
  return Buffer.from(`dhumi:provider-mapping:v1:${mappingId}`, "utf8");
}

export function providerSnapshotAad(input: {
  readonly tenantId: string;
  readonly runId: string;
  readonly attemptId: string;
}): Buffer {
  return Buffer.from(
    `dhumi:provider-snapshot:v1:${input.tenantId}:${input.runId}:${input.attemptId}`,
    "utf8",
  );
}

export function createProviderExecutionPlanRepository(
  pool: Pool,
): ProviderExecutionPlanRepository {
  return {
    async resolveExecutorKind(input) {
      const result = await withJobManagerTenantTransaction(pool, input.tenantId, async (database) =>
        database.query<{ adapter_code: string }>(
          "SELECT * FROM app.resolve_provider_executor_kind($1, $2, $3)",
          [input.runId, input.attemptId, input.fenceToken],
        ),
      );
      const code = result.rows[0]?.adapter_code;
      if (code === "bright_data.amazon.scraper_library") return "amazon";
      if (code === "bright_data.marketplace.filter") return "marketplace";
      throw new Error("Provider executor kind was unavailable or unsupported");
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
      if (!row || ![Number(row.remaining_ms), Number(row.wait_ms), row.consecutive_failures].every(Number.isSafeInteger)) {
        throw new Error("Provider poll checkpoint was incomplete");
      }
      return { remainingMs: Number(row.remaining_ms), waitMs: Number(row.wait_ms), consecutiveFailures: row.consecutive_failures };
    },
    async resolveSubmission(input): Promise<ProviderExecutionPlan> {
      const result = await withJobManagerTenantTransaction(pool, input.tenantId, async (database) =>
        database.query<PlanRow>(
          "SELECT * FROM app.resolve_provider_execution_plan_v2($1, $2, $3)",
          [input.runId, input.attemptId, input.fenceToken],
        ),
      );
      return mapPlan(result.rows[0]);
    },

    async recordProviderReference(input): Promise<void> {
      const result = await withJobManagerTenantTransaction(pool, input.tenantId, async (database) =>
        database.query<{ recorded: boolean }>(
          `
            SELECT app.record_provider_reference_fenced(
              $1, $2, $3, $4, $5
            ) AS recorded
          `,
          [
            input.runId,
            input.attemptId,
            input.fenceToken,
            input.ciphertext,
            input.fingerprint,
          ],
        ),
      );
      if (result.rows[0]?.recorded !== true) {
        throw new Error("Provider reference was not recorded");
      }
    },

    async resolveReconciliation(input): Promise<ProviderReconciliationPlan> {
      const result = await withJobManagerTenantTransaction(pool, input.tenantId, async (database) =>
        database.query<ReconciliationPlanRow>(
          "SELECT * FROM app.resolve_provider_reconciliation_plan_v2($1, $2, $3)",
          [input.runId, input.attemptId, input.fenceToken],
        ),
      );
      const row = result.rows[0];
      const base = mapPlan(row);
      if (
        row === undefined ||
        !Buffer.isBuffer(row.source_provider_reference_ciphertext) ||
        row.source_provider_reference_ciphertext.byteLength < 30 ||
        !Buffer.isBuffer(row.source_provider_reference_fingerprint) ||
        row.source_provider_reference_fingerprint.byteLength !== 32
      ) {
        throw new Error("Provider reconciliation plan was incomplete");
      }
      return {
        ...base,
        sourceAttemptId: row.source_attempt_id,
        sourceProviderReferenceCiphertext: row.source_provider_reference_ciphertext,
        sourceProviderReferenceFingerprint: row.source_provider_reference_fingerprint,
      };
    },

    async resolveNormalization(input): Promise<ProviderNormalizationPlan> {
      const result = await withJobManagerTenantTransaction(pool, input.tenantId, async (database) =>
        database.query<NormalizationPlanRow>(
          "SELECT * FROM app.resolve_provider_normalization_plan($1, $2, $3, $4)",
          [input.runId, input.attemptId, input.fenceToken, input.sourceAttemptId],
        ),
      );
      const row = result.rows[0];
      if (
        row === undefined ||
        !/^[a-z][a-z0-9_.-]{2,127}$/.test(row.operation_code)
      ) {
        throw new Error("Provider normalization plan was incomplete or unsupported");
      }
      return {
        operationCode: row.operation_code,
        outputPolicy: objectValue(row.output_policy, "output policy"),
      };
    },

    async isCancellationRequested(input): Promise<boolean> {
      const result = await withJobManagerTenantTransaction(pool, input.tenantId, async (database) =>
        database.query<{ cancellation_requested: boolean }>(
          `
            SELECT app.is_run_cancellation_requested_fenced($1, $2, $3)
              AS cancellation_requested
          `,
          [input.runId, input.attemptId, input.fenceToken],
        ),
      );
      return result.rows[0]?.cancellation_requested === true;
    },
  };
}
