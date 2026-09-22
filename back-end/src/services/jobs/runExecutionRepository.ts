import type { Pool, QueryResultRow } from "pg";
import { withJobManagerTenantTransaction } from "../database/transactions.js";
import type { NormalizedUsageObservation } from "./controlledRunExecutor.js";

export type AttemptClaimDisposition =
  | "claimed"
  | "recovered"
  | "busy"
  | "terminal"
  | "reconciliation_required"
  | "not_claimable";

export interface RunAttemptClaim {
  readonly disposition: AttemptClaimDisposition;
  readonly attemptId: string | null;
  readonly attemptNumber: number | null;
  readonly fenceToken: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly runStateVersion: number;
  readonly runInternalStatus: string;
  readonly adapterVersionId: string;
  readonly providerMappingId: string;
  readonly providerCredentialId: string | null;
  readonly cancellationRequested: boolean;
}

export interface RunReconciliationEvidence {
  readonly sourceAttemptId: string;
  readonly hasRawArtifact: boolean;
  readonly hasNormalizedArtifact: boolean;
}

interface AttemptClaimRow extends QueryResultRow {
  readonly disposition: string;
  readonly attempt_id: string | null;
  readonly attempt_number: number | null;
  readonly fence_token: string | null;
  readonly worker_lease_expires_at: Date | null;
  readonly run_state_version: string | number;
  readonly run_internal_status: string;
  readonly adapter_version_id: string;
  readonly provider_mapping_id: string;
  readonly provider_credential_id: string | null;
  readonly cancellation_requested: boolean;
}

interface TransitionedRunRow extends QueryResultRow {
  readonly state_version: string | number;
  readonly internal_status: string;
  readonly public_status: string;
}

export interface RunExecutionRepository {
  claimSubmission(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly leaseTtlMs: number;
  }): Promise<RunAttemptClaim>;
  claimReconciliation(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly leaseTtlMs: number;
  }): Promise<RunAttemptClaim>;
  scheduleReconciliation(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly reasonCode: "submission_outcome_uncertain" | "cancellation_requested";
  }): Promise<{ readonly commandEventId: string; readonly scheduled: boolean }>;
  inspectReconciliation(input: {
    readonly tenantId: string;
    readonly runId: string;
  }): Promise<RunReconciliationEvidence>;
  renew(input: {
    readonly tenantId: string;
    readonly attemptId: string;
    readonly fenceToken: string;
    readonly leaseTtlMs: number;
  }): Promise<Date | null>;
  transition(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly expectedStateVersion: number;
    readonly toInternalStatus: string;
    readonly eventType: string;
    readonly eventIdempotencyKey: string;
    readonly attemptId: string;
    readonly fenceToken: string;
    readonly customerErrorCode?: string | null;
    readonly retryable?: boolean;
    readonly safePayload: Readonly<Record<string, unknown>>;
  }): Promise<{ readonly stateVersion: number; readonly internalStatus: string; readonly publicStatus: string }>;
  finish(input: {
    readonly tenantId: string;
    readonly attemptId: string;
    readonly fenceToken: string;
    readonly state: "rejected" | "ambiguous" | "completed" | "failed";
    readonly outcomeClass: string;
  }): Promise<boolean>;
  completeSuccess(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly expectedStateVersion: number;
    readonly eventIdempotencyKey: string;
    readonly attemptId: string;
    readonly fenceToken: string;
    readonly outcomeClass: string;
    readonly normalizedArtifactId: string;
    readonly usage: NormalizedUsageObservation | null;
    readonly safePayload: Readonly<Record<string, unknown>>;
  }): Promise<{ readonly stateVersion: number; readonly internalStatus: string; readonly publicStatus: string }>;
  completeReconciliation(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly expectedStateVersion: number;
    readonly toInternalStatus: "UPSTREAM_FAILED" | "PROCESSING_FAILED" | "CANCELLED" | "COMPLETED";
    readonly eventType: "failed" | "cancelled" | "completed";
    readonly eventIdempotencyKey: string;
    readonly reconciliationAttemptId: string;
    readonly reconciliationFenceToken: string;
    readonly sourceAttemptId: string;
    readonly sourceAttemptState: "completed" | "failed";
    readonly sourceOutcomeClass: string;
    readonly reconciliationOutcomeClass: string;
    readonly customerErrorCode?: string | null;
    readonly retryable?: boolean;
    readonly safePayload: Readonly<Record<string, unknown>>;
  }): Promise<{ readonly stateVersion: number; readonly internalStatus: string; readonly publicStatus: string }>;
  completeReconciliationSuccess(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly expectedStateVersion: number;
    readonly eventIdempotencyKey: string;
    readonly reconciliationAttemptId: string;
    readonly reconciliationFenceToken: string;
    readonly sourceAttemptId: string;
    readonly reconciliationOutcomeClass: string;
    readonly normalizedArtifactId: string;
    readonly usage: NormalizedUsageObservation | null;
    readonly safePayload: Readonly<Record<string, unknown>>;
  }): Promise<{ readonly stateVersion: number; readonly internalStatus: string; readonly publicStatus: string }>;
}

const dispositions = new Set<AttemptClaimDisposition>([
  "claimed",
  "recovered",
  "busy",
  "terminal",
  "reconciliation_required",
  "not_claimable",
]);

function safeInteger(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Run execution returned invalid ${field}`);
  }
  return parsed;
}

function mapClaim(row: AttemptClaimRow | undefined): RunAttemptClaim {
  if (row === undefined || !dispositions.has(row.disposition as AttemptClaimDisposition)) {
    throw new Error("Run Attempt claim returned an invalid disposition");
  }
  const disposition = row.disposition as AttemptClaimDisposition;
  const ownsClaim = disposition === "claimed" || disposition === "recovered";
  if (
    ownsClaim &&
    (row.attempt_id === null ||
      row.attempt_number === null ||
      row.fence_token === null ||
      row.worker_lease_expires_at === null ||
      row.provider_credential_id === null)
  ) {
    throw new Error("Run Attempt claim omitted authoritative ownership fields");
  }
  return {
    disposition,
    attemptId: row.attempt_id,
    attemptNumber: row.attempt_number,
    fenceToken: row.fence_token,
    leaseExpiresAt: row.worker_lease_expires_at,
    runStateVersion: safeInteger(row.run_state_version, "state version"),
    runInternalStatus: row.run_internal_status,
    adapterVersionId: row.adapter_version_id,
    providerMappingId: row.provider_mapping_id,
    providerCredentialId: row.provider_credential_id,
    cancellationRequested: row.cancellation_requested,
  };
}

export function createRunExecutionRepository(pool: Pool): RunExecutionRepository {
  async function claim(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly leaseTtlMs: number;
    readonly kind: "submission" | "reconciliation";
  }): Promise<RunAttemptClaim> {
    const result = await withJobManagerTenantTransaction(pool, input.tenantId, async (database) =>
      database.query<AttemptClaimRow>(
        `
          SELECT *
          FROM app.claim_run_attempt(
            $1,
            $2,
            $3::bigint * interval '1 millisecond'
          )
        `,
        [input.runId, input.kind, input.leaseTtlMs],
      ),
    );
    return mapClaim(result.rows[0]);
  }

  return {
    async claimSubmission(input): Promise<RunAttemptClaim> {
      return claim({ ...input, kind: "submission" });
    },
    async claimReconciliation(input): Promise<RunAttemptClaim> {
      return claim({ ...input, kind: "reconciliation" });
    },
    async scheduleReconciliation(input) {
      const result = await withJobManagerTenantTransaction(pool, input.tenantId, async (database) =>
        database.query<{ command_event_id: string; scheduled: boolean }>(
          "SELECT * FROM app.schedule_run_reconciliation($1, $2)",
          [input.runId, input.reasonCode],
        ),
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("Run reconciliation scheduling returned no row");
      return { commandEventId: row.command_event_id, scheduled: row.scheduled };
    },
    async inspectReconciliation(input): Promise<RunReconciliationEvidence> {
      const result = await withJobManagerTenantTransaction(pool, input.tenantId, async (database) =>
        database.query<{
          source_attempt_id: string;
          has_raw_artifact: boolean;
          has_normalized_artifact: boolean;
        }>("SELECT * FROM app.inspect_run_reconciliation($1)", [input.runId]),
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("RUN_RECONCILIATION_EVIDENCE_NOT_FOUND");
      return {
        sourceAttemptId: row.source_attempt_id,
        hasRawArtifact: row.has_raw_artifact,
        hasNormalizedArtifact: row.has_normalized_artifact,
      };
    },
    async renew(input): Promise<Date | null> {
      const result = await withJobManagerTenantTransaction(pool, input.tenantId, async (database) =>
        database.query<{ renewed_until: Date | null }>(
          `
            SELECT app.renew_run_attempt_claim(
              $1,
              $2,
              $3::bigint * interval '1 millisecond'
            ) AS renewed_until
          `,
          [input.attemptId, input.fenceToken, input.leaseTtlMs],
        ),
      );
      return result.rows[0]?.renewed_until ?? null;
    },
    async transition(input) {
      const result = await withJobManagerTenantTransaction(pool, input.tenantId, async (database) =>
        database.query<TransitionedRunRow>(
          `
            SELECT
              (transitioned).state_version,
              (transitioned).internal_status,
              (transitioned).public_status
            FROM (
              SELECT app.transition_run_fenced(
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb
              ) AS transitioned
            ) AS result
          `,
          [
            input.runId,
            input.expectedStateVersion,
            input.toInternalStatus,
            input.eventType,
            input.eventIdempotencyKey,
            input.attemptId,
            input.fenceToken,
            input.customerErrorCode ?? null,
            input.retryable ?? false,
            input.safePayload,
          ],
        ),
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("Run transition returned no row");
      return {
        stateVersion: safeInteger(row.state_version, "state version"),
        internalStatus: row.internal_status,
        publicStatus: row.public_status,
      };
    },
    async finish(input): Promise<boolean> {
      const result = await withJobManagerTenantTransaction(pool, input.tenantId, async (database) =>
        database.query<{ finished: boolean }>(
          "SELECT app.finish_run_attempt_claim($1, $2, $3, $4) AS finished",
          [input.attemptId, input.fenceToken, input.state, input.outcomeClass],
        ),
      );
      return result.rows[0]?.finished === true;
    },
    async completeSuccess(input) {
      const result = await withJobManagerTenantTransaction(pool, input.tenantId, async (database) =>
        database.query<TransitionedRunRow>(
          `
            SELECT
              (transitioned).state_version,
              (transitioned).internal_status,
              (transitioned).public_status
            FROM (
              SELECT app.complete_run_execution_with_usage(
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb
              ) AS transitioned
            ) AS result
          `,
          [
            input.runId,
            input.expectedStateVersion,
            input.eventIdempotencyKey,
            input.attemptId,
            input.fenceToken,
            input.outcomeClass,
            input.normalizedArtifactId,
            input.usage?.meterCode ?? null,
            input.usage?.unit ?? null,
            input.safePayload,
          ],
        ),
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("Run usage completion returned no row");
      return {
        stateVersion: safeInteger(row.state_version, "state version"),
        internalStatus: row.internal_status,
        publicStatus: row.public_status,
      };
    },
    async completeReconciliation(input) {
      const result = await withJobManagerTenantTransaction(pool, input.tenantId, async (database) =>
        database.query<TransitionedRunRow>(
          `
            SELECT
              (transitioned).state_version,
              (transitioned).internal_status,
              (transitioned).public_status
            FROM (
              SELECT app.complete_run_reconciliation(
                $1, $2, $3, $4, $5, $6, $7, $8,
                $9, $10, $11, $12, $13, $14::jsonb
              ) AS transitioned
            ) AS result
          `,
          [
            input.runId,
            input.expectedStateVersion,
            input.toInternalStatus,
            input.eventType,
            input.eventIdempotencyKey,
            input.reconciliationAttemptId,
            input.reconciliationFenceToken,
            input.sourceAttemptId,
            input.sourceAttemptState,
            input.sourceOutcomeClass,
            input.reconciliationOutcomeClass,
            input.customerErrorCode ?? null,
            input.retryable ?? false,
            input.safePayload,
          ],
        ),
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("Run reconciliation completion returned no row");
      return {
        stateVersion: safeInteger(row.state_version, "state version"),
        internalStatus: row.internal_status,
        publicStatus: row.public_status,
      };
    },
    async completeReconciliationSuccess(input) {
      const result = await withJobManagerTenantTransaction(pool, input.tenantId, async (database) =>
        database.query<TransitionedRunRow>(
          `
            SELECT
              (transitioned).state_version,
              (transitioned).internal_status,
              (transitioned).public_status
            FROM (
              SELECT app.complete_run_reconciliation_with_usage(
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb
              ) AS transitioned
            ) AS result
          `,
          [
            input.runId,
            input.expectedStateVersion,
            input.eventIdempotencyKey,
            input.reconciliationAttemptId,
            input.reconciliationFenceToken,
            input.sourceAttemptId,
            input.reconciliationOutcomeClass,
            input.normalizedArtifactId,
            input.usage?.meterCode ?? null,
            input.usage?.unit ?? null,
            input.safePayload,
          ],
        ),
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("Run reconciliation usage completion returned no row");
      return {
        stateVersion: safeInteger(row.state_version, "state version"),
        internalStatus: row.internal_status,
        publicStatus: row.public_status,
      };
    },
  };
}
