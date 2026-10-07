import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import type { DatabaseExecutor } from "../../types/database.js";

export const downloadOperation = "marketplace.sample_download.authorize.v1";
export const enquiryOperation = "marketplace.expert_enquiry.create.v1";
export interface MarketplaceReplay extends QueryResultRow {
  readonly resource_id: string;
  readonly actor_fingerprint: Buffer;
  readonly request_hash: Buffer;
  readonly response_body: Record<string, unknown> | null;
}
export interface MarketplaceRequest {
  readonly tenantId: string;
  readonly actorFingerprint: Buffer;
  readonly requestHash: Buffer;
  readonly idempotencyKey: string;
}
export function validateMarketplaceRequest(input: MarketplaceRequest): void {
  if (!Buffer.isBuffer(input.actorFingerprint) || input.actorFingerprint.length !== 32 ||
      !Buffer.isBuffer(input.requestHash) || input.requestHash.length !== 32 ||
      !/^[A-Za-z0-9._:-]{16,128}$/.test(input.idempotencyKey)) {
    throw new TypeError("Invalid Marketplace idempotency input");
  }
}
export async function lockMarketplaceRequest(database: DatabaseExecutor, input: MarketplaceRequest, operation: string): Promise<MarketplaceReplay | undefined> {
  validateMarketplaceRequest(input);
  // The same organization lock serializes both Marketplace write operations.
  await database.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", [input.tenantId]);
  const result = await database.query<MarketplaceReplay>(
    // The organization advisory lock protects claim creation. Read immutable
    // replay identity without a row lock: completion/cleanup lock the download
    // before updating its claim, and must never meet the reverse lock order.
    "SELECT resource_id,actor_fingerprint,request_hash,response_body FROM app.idempotency_records WHERE organization_id=$1 AND operation_code=$2 AND idempotency_key=$3",
    [input.tenantId, operation, input.idempotencyKey],
  );
  return result.rows[0];
}
export function requestMatches(row: MarketplaceReplay, input: MarketplaceRequest): boolean {
  return row.actor_fingerprint.equals(input.actorFingerprint) && row.request_hash.equals(input.requestHash);
}
export async function rememberMarketplaceRequest(database: DatabaseExecutor, input: MarketplaceRequest, operation: string, resourceId: string, body: Record<string, unknown>, completed: boolean): Promise<void> {
  // Preserve the original indefinite replay lifetime; a download's own URL expiry
  // remains independently enforced. No request payload or sample bytes are stored.
  await database.query(`INSERT INTO app.idempotency_records
    (id,organization_id,actor_fingerprint,operation_code,idempotency_key,request_hash,state,response_status,resource_type,resource_id,response_body,expires_at,completed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,'infinity',CASE WHEN $7='completed' THEN clock_timestamp() ELSE NULL END)`,
    [randomUUID(),input.tenantId,input.actorFingerprint,operation,input.idempotencyKey,input.requestHash,completed ? "completed" : "in_progress",completed ? 201 : null,
      operation === downloadOperation ? "marketplace_sample_download" : "marketplace_expert_enquiry",resourceId,JSON.stringify(body)]);
}
