import type { Pool, QueryResultRow } from "pg";
import { ApplicationError } from "../../utils/applicationError.js";
import { withTenantTransaction } from "../database/transactions.js";

export type MarketplaceSampleDownloadFormat = "json" | "csv";
export type MarketplaceSampleDownloadActor =
  | { readonly kind: "browser"; readonly userId: string }
  | { readonly kind: "api_key"; readonly apiKeyId: string };

export interface MarketplaceSampleDownloadRecord {
  readonly authorizationId: string;
  readonly state: "reserved" | "authorized" | "failed";
  readonly objectKey: string;
  readonly contentType: string;
  readonly fileName: string;
  readonly byteCount: number;
  readonly checksumHex: string;
  readonly recordCount: number;
  readonly downloadExpiresAt: Date | null;
}

export type ReserveMarketplaceSampleDownloadOutcome =
  | { readonly kind: "created"; readonly record: MarketplaceSampleDownloadRecord }
  | { readonly kind: "replay"; readonly record: MarketplaceSampleDownloadRecord }
  | { readonly kind: "conflict" };

export interface MarketplaceSampleDownloadRepository {
  reserve(input: {
    readonly authorizationId: string;
    readonly tenantId: string;
    readonly actor: MarketplaceSampleDownloadActor;
    readonly actorFingerprint: Buffer;
    readonly idempotencyKey: string;
    readonly requestHash: Buffer;
    readonly templateSlug: string;
    readonly expectedSampleVersion: number;
    readonly format: MarketplaceSampleDownloadFormat;
    readonly selectedFields: readonly string[];
    readonly projectionFingerprint: Buffer;
    readonly recordLimit: number;
    readonly recordCount: number;
    readonly objectKey: string;
    readonly contentType: string;
    readonly fileName: string;
    readonly byteCount: number;
    readonly checksum: Buffer;
    readonly rateLimitMax: number;
    readonly rateWindowSeconds: number;
  }): Promise<ReserveMarketplaceSampleDownloadOutcome>;
  complete(input: {
    readonly tenantId: string;
    readonly authorizationId: string;
    readonly downloadExpiresAt: Date;
    readonly requestId: string | null;
    readonly ipFingerprint: Buffer | null;
  }): Promise<void>;
  /** Returns true only after a transaction confirms a failed, fenced reservation. */
  fail(input: { readonly tenantId: string; readonly authorizationId: string }): Promise<boolean>;
}

export class MarketplaceSampleDownloadNotFoundError extends Error {}
export class MarketplaceSampleDownloadRateLimitedError extends Error {}
export class MarketplaceSampleDownloadStaleError extends Error {}
export class MarketplaceSampleDownloadPersistenceError extends Error {
  public constructor(cause?: unknown) {
    super("Marketplace sample-download persistence failed", { cause });
  }
}

interface ReservationRow extends QueryResultRow {
  readonly disposition: "created" | "replay" | "conflict";
  readonly authorization_id: string;
  readonly stored_state: "reserved" | "authorized" | "failed";
  readonly stored_object_key: string;
  readonly stored_content_type: string;
  readonly stored_file_name: string;
  readonly stored_byte_count: string | number;
  readonly stored_checksum: Buffer;
  readonly stored_record_count: number;
  readonly stored_download_expires_at: Date | null;
}

function safeInteger(value: string | number): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Invalid stored byte count");
  return parsed;
}

function databaseMessage(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "message" in error &&
      typeof (error as { message?: unknown }).message === "string"
    ? (error as { message: string }).message
    : undefined;
}

function mapDatabaseError(error: unknown): Error {
  const message = databaseMessage(error);
  if (message?.includes("MARKETPLACE_SAMPLE_DOWNLOAD_NOT_FOUND")) {
    return new MarketplaceSampleDownloadNotFoundError();
  }
  if (message?.includes("MARKETPLACE_SAMPLE_DOWNLOAD_RATE_LIMITED")) {
    return new MarketplaceSampleDownloadRateLimitedError();
  }
  if (message?.includes("MARKETPLACE_SAMPLE_DOWNLOAD_STALE")) {
    return new MarketplaceSampleDownloadStaleError();
  }
  return new MarketplaceSampleDownloadPersistenceError(error);
}

function toRecord(row: ReservationRow): MarketplaceSampleDownloadRecord {
  const checksumHex = row.stored_checksum.toString("hex");
  if (!/^[0-9a-f]{64}$/.test(checksumHex) || !(row.stored_download_expires_at === null ||
      (row.stored_download_expires_at instanceof Date && !Number.isNaN(row.stored_download_expires_at.valueOf())))) {
    throw new Error("Marketplace sample-download reservation was invalid");
  }
  return {
    authorizationId: row.authorization_id,
    state: row.stored_state,
    objectKey: row.stored_object_key,
    contentType: row.stored_content_type,
    fileName: row.stored_file_name,
    byteCount: safeInteger(row.stored_byte_count),
    checksumHex,
    recordCount: row.stored_record_count,
    downloadExpiresAt: row.stored_download_expires_at,
  };
}

export function createMarketplaceSampleDownloadRepository(
  pool: Pool,
): MarketplaceSampleDownloadRepository {
  const repository: MarketplaceSampleDownloadRepository = {
    async reserve(input) {
      try {
        return await withTenantTransaction(pool, input.tenantId, async (database) => {
          const result = await database.query<ReservationRow>(
            `SELECT * FROM app.reserve_marketplace_sample_download(
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11,
              $12, $13, $14, $15, $16, $17, $18, $19, $20
            )`,
            [
              input.authorizationId,
              input.actor.kind === "browser" ? input.actor.userId : null,
              input.actor.kind === "api_key" ? input.actor.apiKeyId : null,
              input.actorFingerprint,
              input.idempotencyKey,
              input.requestHash,
              input.templateSlug,
              input.expectedSampleVersion,
              input.format,
              JSON.stringify(input.selectedFields),
              input.projectionFingerprint,
              input.recordLimit,
              input.recordCount,
              input.objectKey,
              input.contentType,
              input.fileName,
              input.byteCount,
              input.checksum,
              input.rateLimitMax,
              input.rateWindowSeconds,
            ],
          );
          const row = result.rows[0];
          if (row === undefined) throw new Error("Reservation returned no row");
          if (row.disposition === "conflict") return { kind: "conflict" as const };
          return { kind: row.disposition, record: toRecord(row) };
        });
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw mapDatabaseError(error);
      }
    },

    async complete(input) {
      try {
        await withTenantTransaction(pool, input.tenantId, async (database) => {
          await database.query(
            "SELECT app.complete_marketplace_sample_download($1, $2, $3, $4)",
            [input.authorizationId, input.downloadExpiresAt, input.requestId, input.ipFingerprint],
          );
        });
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw mapDatabaseError(error);
      }
    },

    async fail(input) {
      try {
        return await withTenantTransaction(pool, input.tenantId, async (database) => {
          const result = await database.query<{ cleanup_allowed: boolean }>(
            "SELECT app.fail_marketplace_sample_download_for_cleanup($1) AS cleanup_allowed",
            [input.authorizationId],
          );
          const allowed = result.rows[0]?.cleanup_allowed;
          if (typeof allowed !== "boolean") throw new Error("Cleanup outcome was not confirmed");
          return allowed;
        });
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw mapDatabaseError(error);
      }
    },
  };
  return Object.freeze(repository);
}
