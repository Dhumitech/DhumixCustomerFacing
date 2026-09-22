import type { Pool, QueryResultRow } from "pg";
import { withOperatorTransaction } from "../database/transactions.js";

export interface MarketplaceQualificationExecutionPlan {
  readonly packetId: string;
  readonly candidateId: string;
  readonly environment: "local" | "test";
  readonly operationCode: "marketplace.dataset.filter";
  readonly providerResourceCiphertext: Buffer;
  readonly providerResourceFingerprint: Buffer;
  readonly exactRequest: Readonly<Record<string, unknown>>;
  readonly maximumEstimatedCostMicros: number;
  readonly currencyCode: "USD";
  readonly pollDeadlineMs: number;
}

export interface MarketplaceQualificationEvidenceReceipt {
  readonly objectKey: string;
  readonly checksum: Buffer;
  readonly contentType: "application/json";
  readonly byteCount: number;
}

export interface MarketplaceQualificationExecutionRepository {
  claim(input: {
    readonly packetId: string;
    readonly requestFingerprint: Buffer;
    readonly actor: string;
  }): Promise<MarketplaceQualificationExecutionPlan>;
  recordSubmissionStart(input: {
    readonly packetId: string;
    readonly request: MarketplaceQualificationEvidenceReceipt;
    readonly actor: string;
  }): Promise<void>;
  recordSnapshotReference(input: {
    readonly packetId: string;
    readonly ciphertext: Buffer;
    readonly fingerprint: Buffer;
    readonly actor: string;
  }): Promise<void>;
  recordPollCheckpoint(input: {
    readonly packetId: string;
    readonly providerStatus: string;
    readonly safeErrorCode: string | null;
    readonly actor: string;
  }): Promise<void>;
  completeSuccess(input: {
    readonly packetId: string;
    readonly raw: MarketplaceQualificationEvidenceReceipt;
    readonly normalized: MarketplaceQualificationEvidenceReceipt;
    readonly rawRecordCount: number;
    readonly normalizedRecordCount: number;
    readonly observedCostMicros: number;
    readonly currencyCode: "USD";
    readonly actor: string;
  }): Promise<void>;
  completeFailure(input: {
    readonly packetId: string;
    readonly executionState: "failed" | "uncertain";
    readonly safeErrorCode: string;
    readonly observedCostMicros: number | null;
    readonly currencyCode: "USD";
    readonly actor: string;
  }): Promise<void>;
}

interface ClaimRow extends QueryResultRow {
  readonly packet_id: string;
  readonly candidate_id: string;
  readonly environment: "local" | "test";
  readonly operation_code: "marketplace.dataset.filter";
  readonly provider_resource_ciphertext: Buffer;
  readonly provider_resource_fingerprint: Buffer;
  readonly exact_request: unknown;
  readonly maximum_estimated_cost_micros: string | number;
  readonly currency_code: "USD";
  readonly poll_deadline_ms: number;
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Marketplace qualification claim returned an invalid request");
  }
  return value as Readonly<Record<string, unknown>>;
}

function safeInteger(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Marketplace qualification claim returned an invalid integer");
  }
  return parsed;
}

function fingerprint(value: unknown): Buffer {
  if (!Buffer.isBuffer(value) || value.byteLength !== 32) {
    throw new Error("Marketplace qualification claim returned an invalid fingerprint");
  }
  return value;
}

function ciphertext(value: unknown): Buffer {
  if (!Buffer.isBuffer(value) || value.byteLength < 30) {
    throw new Error("Marketplace qualification claim returned invalid protected data");
  }
  return value;
}

function asserted(result: { readonly rows: readonly { readonly recorded: boolean }[] }, operation: string): void {
  if (result.rows[0]?.recorded !== true) {
    throw new Error(`${operation} was not recorded`);
  }
}

export function createMarketplaceQualificationExecutionRepository(
  pool: Pool,
): MarketplaceQualificationExecutionRepository {
  return Object.freeze({
    async claim(input: Parameters<MarketplaceQualificationExecutionRepository["claim"]>[0]) {
      return withOperatorTransaction(pool, async (database) => {
        const result = await database.query<ClaimRow>(
          "SELECT * FROM app.claim_marketplace_qualification_submission($1,$2,$3)",
          [input.packetId, input.requestFingerprint, input.actor],
        );
        const row = result.rows[0];
        if (row === undefined || row.packet_id !== input.packetId ||
            row.operation_code !== "marketplace.dataset.filter" ||
            !["local", "test"].includes(row.environment) || row.currency_code !== "USD") {
          throw new Error("Marketplace qualification submission was not claimed");
        }
        return Object.freeze({
          packetId: row.packet_id,
          candidateId: row.candidate_id,
          environment: row.environment,
          operationCode: row.operation_code,
          providerResourceCiphertext: ciphertext(row.provider_resource_ciphertext),
          providerResourceFingerprint: fingerprint(row.provider_resource_fingerprint),
          exactRequest: object(row.exact_request),
          maximumEstimatedCostMicros: safeInteger(row.maximum_estimated_cost_micros),
          currencyCode: row.currency_code,
          pollDeadlineMs: safeInteger(row.poll_deadline_ms),
        });
      });
    },

    async recordSubmissionStart(
      input: Parameters<MarketplaceQualificationExecutionRepository["recordSubmissionStart"]>[0],
    ) {
      await withOperatorTransaction(pool, async (database) => {
        const result = await database.query<{ recorded: boolean }>(
          "SELECT app.record_marketplace_qualification_submission_start($1,$2,$3,$4,$5,$6) AS recorded",
          [input.packetId, input.request.objectKey, input.request.checksum,
            input.request.contentType, input.request.byteCount, input.actor],
        );
        asserted(result, "Marketplace qualification submission start");
      });
    },

    async recordSnapshotReference(
      input: Parameters<MarketplaceQualificationExecutionRepository["recordSnapshotReference"]>[0],
    ) {
      await withOperatorTransaction(pool, async (database) => {
        const result = await database.query<{ recorded: boolean }>(
          "SELECT app.record_marketplace_qualification_snapshot_reference($1,$2,$3,$4) AS recorded",
          [input.packetId, input.ciphertext, input.fingerprint, input.actor],
        );
        asserted(result, "Marketplace qualification Snapshot reference");
      });
    },

    async recordPollCheckpoint(
      input: Parameters<MarketplaceQualificationExecutionRepository["recordPollCheckpoint"]>[0],
    ) {
      await withOperatorTransaction(pool, async (database) => {
        const result = await database.query<{ recorded: boolean }>(
          "SELECT app.record_marketplace_qualification_poll_checkpoint($1,$2,$3,$4) AS recorded",
          [input.packetId, input.providerStatus, input.safeErrorCode, input.actor],
        );
        asserted(result, "Marketplace qualification poll checkpoint");
      });
    },

    async completeSuccess(
      input: Parameters<MarketplaceQualificationExecutionRepository["completeSuccess"]>[0],
    ) {
      await withOperatorTransaction(pool, async (database) => {
        const result = await database.query<{ recorded: boolean }>(
          `SELECT app.complete_marketplace_qualification_success(
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
           ) AS recorded`,
          [
            input.packetId,
            input.raw.objectKey,
            input.raw.checksum,
            input.raw.contentType,
            input.raw.byteCount,
            input.rawRecordCount,
            input.normalized.objectKey,
            input.normalized.checksum,
            input.normalized.contentType,
            input.normalized.byteCount,
            input.normalizedRecordCount,
            input.observedCostMicros,
            input.currencyCode,
            input.actor,
            "provider_execution_completed",
          ],
        );
        asserted(result, "Marketplace qualification success");
      });
    },

    async completeFailure(
      input: Parameters<MarketplaceQualificationExecutionRepository["completeFailure"]>[0],
    ) {
      await withOperatorTransaction(pool, async (database) => {
        const result = await database.query<{ recorded: boolean }>(
          "SELECT app.complete_marketplace_qualification_failure($1,$2,$3,$4,$5,$6) AS recorded",
          [input.packetId, input.executionState, input.safeErrorCode,
            input.observedCostMicros, input.currencyCode, input.actor],
        );
        asserted(result, "Marketplace qualification failure");
      });
    },
  });
}
