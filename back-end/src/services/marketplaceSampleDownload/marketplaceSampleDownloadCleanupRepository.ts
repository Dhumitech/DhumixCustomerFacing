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
          await database.query("SELECT set_config('app.organization_id',$1,true)",[input.tenantId]);
          const result=await database.query("SELECT *,clock_timestamp() now FROM app.marketplace_sample_downloads WHERE organization_id=$1 AND id=$2 FOR UPDATE",[input.tenantId,input.authorizationId]);
          const stored=result.rows[0];
          if(!stored || stored.object_key!==input.objectKey || stored.object_key!=="marketplace/sample-downloads/"+input.tenantId+"/"+input.authorizationId+"/"+(stored.checksum as Buffer).toString("hex")+"."+stored.format)return {kind:"untracked" as const};
          const reservedDue=stored.state==="reserved" && stored.created_at instanceof Date && stored.created_at.valueOf()<=stored.now.valueOf()-3600000;
          const authorizedDue=stored.state==="authorized" && stored.download_expires_at instanceof Date && stored.download_expires_at.valueOf()<=stored.now.valueOf()-3600000;
          if(stored.state!=="failed" && !reservedDue && !authorizedDue)return {kind:"protected" as const};
          if(reservedDue){
            await database.query("UPDATE app.marketplace_sample_downloads SET state='failed',finished_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",[input.tenantId,input.authorizationId]);
            await database.query("UPDATE app.idempotency_records SET state='failed' WHERE organization_id=$1 AND resource_id=$2 AND operation_code='marketplace.sample_download.authorize.v1'",[input.tenantId,input.authorizationId]);
          }
          const row:ClaimRow={disposition:"eligible",stored_content_type:stored.content_type,stored_file_name:stored.file_name,stored_byte_count:stored.byte_count,stored_checksum:stored.checksum};
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
