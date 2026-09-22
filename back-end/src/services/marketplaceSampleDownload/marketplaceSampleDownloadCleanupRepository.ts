import type { Pool, QueryResultRow } from "pg";
import { withOperatorTransaction } from "../database/transactions.js";
import { MarketplaceSampleDownloadPersistenceError } from "./marketplaceSampleDownloadRepository.js";
import type {
  MarketplaceSampleDownloadCleanupCandidate,
  MarketplaceSampleDownloadReceipt,
} from "./marketplaceSampleDownloadStore.js";

export type MarketplaceSampleDownloadCleanupClaim =
  | { readonly kind: "protected" | "untracked" }
  | { readonly kind: "eligible"; readonly receipt: Omit<MarketplaceSampleDownloadReceipt, "eTag"> };

export interface MarketplaceSampleDownloadCleanupRepository {
  claim(input: MarketplaceSampleDownloadCleanupCandidate): Promise<MarketplaceSampleDownloadCleanupClaim>;
}

interface ClaimRow extends QueryResultRow {
  readonly disposition: string;
  readonly stored_content_type: string | null;
  readonly stored_file_name: string | null;
  readonly stored_byte_count: string | number | null;
  readonly stored_checksum: Buffer | null;
}

export function createMarketplaceSampleDownloadCleanupRepository(
  pool: Pool,
): MarketplaceSampleDownloadCleanupRepository {
  return Object.freeze({
    async claim(input: MarketplaceSampleDownloadCleanupCandidate): Promise<MarketplaceSampleDownloadCleanupClaim> {
      try {
        return await withOperatorTransaction<MarketplaceSampleDownloadCleanupClaim>(pool, async (database) => {
          const result = await database.query<ClaimRow>(
            "SELECT * FROM app.claim_marketplace_sample_download_cleanup($1, $2, $3)",
            [input.tenantId, input.authorizationId, input.objectKey],
          );
          const row = result.rows[0];
          if (row?.disposition === "protected" || row?.disposition === "untracked") {
            return { kind: row.disposition };
          }
          const byteCount = Number(row?.stored_byte_count);
          if (row?.disposition !== "eligible" || typeof row.stored_content_type !== "string" ||
              typeof row.stored_file_name !== "string" || !Number.isSafeInteger(byteCount) || byteCount < 1 ||
              !Buffer.isBuffer(row.stored_checksum) || row.stored_checksum.byteLength !== 32) {
            throw new Error("Sample-download cleanup claim was not confirmed");
          }
          return {
            kind: "eligible" as const,
            receipt: {
              objectKey: input.objectKey,
              contentType: row.stored_content_type,
              fileName: row.stored_file_name,
              byteCount,
              checksumHex: row.stored_checksum.toString("hex"),
            },
          };
        });
      } catch (error) {
        throw new MarketplaceSampleDownloadPersistenceError(error);
      }
    },
  });
}
