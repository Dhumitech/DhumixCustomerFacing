import type { Pool, QueryResultRow } from "pg";
import { ApplicationError } from "../../utils/applicationError.js";
import { withOrganizationWriteTransaction } from "../database/transactions.js";
import { queryMarketplacePreview } from "../marketplacePreview/marketplacePreviewQuery.js";
import { downloadOperation, lockMarketplaceRequest, rememberMarketplaceRequest, requestMatches } from "../marketplacePreview/marketplaceIdempotency.js";

export type MarketplaceSampleDownloadFormat = "json" | "csv";
export type MarketplaceSampleDownloadActor = { readonly kind: "browser"; readonly userId: string };

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
    readonly userId: string;
    readonly tenantId: string;
    readonly authorizationId: string;
    readonly downloadExpiresAt: Date;
    readonly requestId: string | null;
    readonly ipFingerprint: Buffer | null;
  }): Promise<void>;
  /** Returns true only after a transaction confirms a failed, fenced reservation. */
  fail(input: {
    readonly userId: string;
    readonly tenantId: string;
    readonly authorizationId: string;
  }): Promise<boolean>;
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
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
    ? (error as { message: string }).message
    : undefined;
}

function mapDatabaseError(error: unknown): Error {
  if (error instanceof MarketplaceSampleDownloadNotFoundError || error instanceof MarketplaceSampleDownloadRateLimitedError || error instanceof MarketplaceSampleDownloadStaleError) return error;
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
  if (
    !/^[0-9a-f]{64}$/.test(checksumHex) ||
    !(
      row.stored_download_expires_at === null ||
      (row.stored_download_expires_at instanceof Date &&
        !Number.isNaN(row.stored_download_expires_at.valueOf()))
    )
  ) {
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

const reservationColumns = `id authorization_id,state stored_state,object_key stored_object_key,content_type stored_content_type,file_name stored_file_name,byte_count stored_byte_count,checksum stored_checksum,record_count stored_record_count,download_expires_at stored_download_expires_at`;
export function createMarketplaceSampleDownloadRepository(pool: Pool): MarketplaceSampleDownloadRepository {
  return Object.freeze({
    async reserve(input: Parameters<MarketplaceSampleDownloadRepository["reserve"]>[0]) {
      try {
        return await withOrganizationWriteTransaction(pool,{tenantId:input.tenantId,userId:input.actor.userId},async database=>{
          if(input.actor.kind!=="browser" || !Number.isInteger(input.expectedSampleVersion) || input.expectedSampleVersion<1 ||
             !["json","csv"].includes(input.format) || input.selectedFields.length<1 || !Number.isInteger(input.recordLimit) || input.recordLimit<1 || input.recordLimit>100 ||
             !Number.isInteger(input.recordCount) || input.recordCount<0 || input.recordCount>input.recordLimit || !Number.isSafeInteger(input.byteCount) || input.byteCount<1 ||
             input.checksum.length!==32 || input.projectionFingerprint.length!==32 || !Number.isInteger(input.rateLimitMax) || input.rateLimitMax<1 || input.rateLimitMax>10000 ||
             !Number.isInteger(input.rateWindowSeconds) || input.rateWindowSeconds<60 || input.rateWindowSeconds>86400) throw new TypeError("Invalid sample download input");
          const preview=await queryMarketplacePreview(database,input.templateSlug);
          if(!preview || preview.sample_version!==input.expectedSampleVersion) throw new MarketplaceSampleDownloadNotFoundError();
          const replay=await lockMarketplaceRequest(database,input,downloadOperation);
          if(replay){
            if(!requestMatches(replay,input))return {kind:"conflict" as const};
            const found=await database.query<ReservationRow>(`SELECT 'replay' disposition,${reservationColumns} FROM app.marketplace_sample_downloads WHERE organization_id=$1 AND id=$2 FOR UPDATE`,[input.tenantId,replay.resource_id]);
            if(!found.rows[0])throw new Error("Download replay resource missing");
            return {kind:"replay" as const,record:toRecord(found.rows[0])};
          }
          const recent=await database.query<{n:string}>("SELECT count(*)::text n FROM app.marketplace_sample_downloads WHERE organization_id=$1 AND state IN ('reserved','authorized') AND created_at>=clock_timestamp()-make_interval(secs=>$2)",[input.tenantId,input.rateWindowSeconds]);
          if(Number(recent.rows[0]?.n)>=input.rateLimitMax)throw new MarketplaceSampleDownloadRateLimitedError();
          const inserted=await database.query<ReservationRow>(`INSERT INTO app.marketplace_sample_downloads(id,organization_id,sample_version_id,actor_user_id,format,selected_fields,record_limit,record_count,object_key,content_type,file_name,byte_count,checksum,state)
            VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,'reserved') RETURNING 'created' disposition,${reservationColumns}`,
            [input.authorizationId,input.tenantId,preview.sample_id,input.actor.userId,input.format,JSON.stringify(input.selectedFields),input.recordLimit,input.recordCount,input.objectKey,input.contentType,input.fileName,input.byteCount,input.checksum]);
          const row=inserted.rows[0];if(!row)throw new Error("Download reservation missing");
          await rememberMarketplaceRequest(database,input,downloadOperation,input.authorizationId,{projection_fingerprint:input.projectionFingerprint.toString("hex")},false);
          return {kind:"created" as const,record:toRecord(row)};
        });
      }catch(error){if(error instanceof ApplicationError)throw error;throw mapDatabaseError(error);}
    },
    async complete(input: Parameters<MarketplaceSampleDownloadRepository["complete"]>[0]) {
      try{
        await withOrganizationWriteTransaction(pool,{tenantId:input.tenantId,userId:input.userId},async database=>{
          const found=await database.query(`SELECT d.*,t.slug,v.version template_version,s.sample_version FROM app.marketplace_sample_downloads d
            JOIN app.marketplace_samples s ON s.id=d.sample_version_id JOIN app.service_template_versions v ON v.id=s.template_version_id JOIN app.service_templates t ON t.id=v.service_template_id
            WHERE d.organization_id=$1 AND d.id=$2 FOR UPDATE OF d`,[input.tenantId,input.authorizationId]);
          const row=found.rows[0];
          if(!row || row.state!=="reserved" || !(input.downloadExpiresAt instanceof Date) || !Number.isFinite(input.downloadExpiresAt.valueOf()))throw new MarketplaceSampleDownloadStaleError();
          const preview=await queryMarketplacePreview(database,String(row.slug));
          if(!preview || preview.sample_id!==row.sample_version_id || preview.template_version!==row.template_version)throw new MarketplaceSampleDownloadStaleError();
          const updated=await database.query(`UPDATE app.marketplace_sample_downloads SET state='authorized',finished_at=clock_timestamp(),download_expires_at=$3,trace_id=$4
            WHERE organization_id=$1 AND id=$2 AND $3::timestamptz>clock_timestamp() RETURNING id`,[input.tenantId,input.authorizationId,input.downloadExpiresAt,input.requestId]);
          if(updated.rowCount!==1)throw new MarketplaceSampleDownloadStaleError();
          const idem=await database.query("UPDATE app.idempotency_records SET state='completed',response_status=201,completed_at=clock_timestamp() WHERE organization_id=$1 AND operation_code=$2 AND resource_id=$3 RETURNING response_body",[input.tenantId,downloadOperation,input.authorizationId]);
          if(idem.rowCount!==1)throw new Error("Download replay record missing");
          await database.query(`INSERT INTO app.audit_events(organization_id,actor_user_id,action,target_type,target_id,outcome,trace_id,ip_fingerprint,safe_diff)
            VALUES($1,$2,'marketplace.sample_download_authorize','marketplace_sample_download',$3,'authorized',$4,$5,$6::jsonb)`,
            [input.tenantId,row.actor_user_id,input.authorizationId,input.requestId,input.ipFingerprint,JSON.stringify({template_slug:row.slug,template_version:row.template_version,sample_version:row.sample_version,format:row.format,selected_fields:row.selected_fields,record_limit:row.record_limit,record_count:row.record_count,byte_count:Number(row.byte_count),checksum:(row.checksum as Buffer).toString("hex"),projection_fingerprint:idem.rows[0]?.response_body?.projection_fingerprint,delivery_method:"signed_object_url",provider_calls:0})]);
        });
      }catch(error){if(error instanceof ApplicationError)throw error;throw mapDatabaseError(error);}
    },
    async fail(input: Parameters<MarketplaceSampleDownloadRepository["fail"]>[0]) {
      try{
        return await withOrganizationWriteTransaction(pool,{tenantId:input.tenantId,userId:input.userId},async database=>{
          const found=await database.query<{state:string}>("SELECT state FROM app.marketplace_sample_downloads WHERE organization_id=$1 AND id=$2 FOR UPDATE",[input.tenantId,input.authorizationId]);
          const state=found.rows[0]?.state;if(!state || state==="authorized")return false;
          if(state!=="failed" && state!=="reserved")throw new Error("Unknown reservation state");
          if(state==="reserved"){
            await database.query("UPDATE app.marketplace_sample_downloads SET state='failed',finished_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",[input.tenantId,input.authorizationId]);
            await database.query("UPDATE app.idempotency_records SET state='failed' WHERE organization_id=$1 AND operation_code=$2 AND resource_id=$3",[input.tenantId,downloadOperation,input.authorizationId]);
          }
          return true;
        });
      }catch(error){if(error instanceof ApplicationError)throw error;throw mapDatabaseError(error);}
    },
  });
}
