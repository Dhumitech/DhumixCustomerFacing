import type { Pool } from "pg";
import { ApplicationError } from "../../utils/applicationError.js";
import { withOrganizationWriteTransaction, withOperatorTransaction } from "../database/transactions.js";

import { queryMarketplacePreview } from "../marketplacePreview/marketplacePreviewQuery.js";
import { enquiryOperation, lockMarketplaceRequest, rememberMarketplaceRequest, requestMatches } from "../marketplacePreview/marketplaceIdempotency.js";
export type MarketplaceExpertEnquiryActor = { readonly kind: "browser"; readonly userId: string };

export type MarketplaceExpertEnquiryState = "received" | "in_review" | "contacted" | "closed";

export interface MarketplaceExpertEnquiryRecord {
  readonly enquiryId: string;
  readonly templateSlug: string;
  readonly templateVersion: number;
  readonly state: MarketplaceExpertEnquiryState;
  readonly submittedAt: Date;
}

export type CreateMarketplaceExpertEnquiryOutcome =
  | {
      readonly kind: "created" | "replay" | "existing";
      readonly record: MarketplaceExpertEnquiryRecord;
    }
  | { readonly kind: "conflict" };

export interface MarketplaceExpertEnquiryRepository {
  create(input: {
    readonly enquiryId: string;
    readonly tenantId: string;
    readonly actor: MarketplaceExpertEnquiryActor;
    readonly actorFingerprint: Buffer;
    readonly idempotencyKey: string;
    readonly requestHash: Buffer;
    readonly templateSlug: string;
    readonly expectedTemplateVersion: number;
    readonly requestId: string | null;
    readonly ipFingerprint: Buffer | null;
  }): Promise<CreateMarketplaceExpertEnquiryOutcome>;
}

export class MarketplaceExpertEnquiryNotFoundError extends Error {}
export class MarketplaceExpertEnquiryStaleError extends Error {}
export class MarketplaceExpertEnquiryPersistenceError extends Error {
  public constructor(cause?: unknown) {
    super("Marketplace expert-enquiry persistence failed", { cause });
  }
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
  if(error instanceof MarketplaceExpertEnquiryNotFoundError || error instanceof MarketplaceExpertEnquiryStaleError)return error;
  const message = databaseMessage(error);
  if (message?.includes("MARKETPLACE_EXPERT_ENQUIRY_NOT_FOUND")) {
    return new MarketplaceExpertEnquiryNotFoundError();
  }
  if (message?.includes("MARKETPLACE_EXPERT_ENQUIRY_STALE")) {
    return new MarketplaceExpertEnquiryStaleError();
  }
  return new MarketplaceExpertEnquiryPersistenceError(error);
}



export function createMarketplaceExpertEnquiryRepository(pool:Pool):MarketplaceExpertEnquiryRepository {
  return Object.freeze({
    async create(input:Parameters<MarketplaceExpertEnquiryRepository["create"]>[0]) {
      try{
        return await withOrganizationWriteTransaction(pool,{tenantId:input.tenantId,userId:input.actor.userId},async database=>{
          if(input.actor.kind!=="browser")throw new TypeError("A browser actor is required");
          const preview=await queryMarketplacePreview(database,input.templateSlug);
          if(!preview)throw new MarketplaceExpertEnquiryNotFoundError();
          if(preview.template_version!==input.expectedTemplateVersion)throw new MarketplaceExpertEnquiryStaleError();
          const replay=await lockMarketplaceRequest(database,input,enquiryOperation);
          if(replay){
            if(!requestMatches(replay,input))return {kind:"conflict" as const};
            const b=replay.response_body;
            if(!b || typeof b.enquiryId!=="string" || typeof b.templateSlug!=="string" || !Number.isInteger(b.templateVersion) || !["received","in_review","contacted","closed"].includes(String(b.state)) || typeof b.submittedAt!=="string" || !Number.isFinite(Date.parse(b.submittedAt)))throw new Error("Enquiry replay invalid");
            return {kind:"replay" as const,record:{enquiryId:b.enquiryId,templateSlug:b.templateSlug,templateVersion:Number(b.templateVersion),state:b.state as MarketplaceExpertEnquiryState,submittedAt:new Date(b.submittedAt)}};
          }
          const found=await database.query("SELECT id,state,created_at FROM app.marketplace_expert_enquiries WHERE organization_id=$1 AND template_version_id=$2 AND state IN ('received','in_review','contacted') FOR UPDATE",[input.tenantId,preview.template_version_id]);
          let row=found.rows[0];const kind=row ? "existing" as const : "created" as const;
          if(!row){
            const added=await database.query("INSERT INTO app.marketplace_expert_enquiries(id,organization_id,template_version_id,actor_user_id,state,trace_id) VALUES($1,$2,$3,$4,'received',$5) RETURNING id,state,created_at",[input.enquiryId,input.tenantId,preview.template_version_id,input.actor.userId,input.requestId]);row=added.rows[0];
            await database.query("INSERT INTO app.audit_events(organization_id,actor_user_id,action,target_type,target_id,outcome,trace_id,ip_fingerprint,safe_diff) VALUES($1,$2,'marketplace.expert_enquiry.create','marketplace_expert_enquiry',$3,'received',$4,$5,$6::jsonb)",[input.tenantId,input.actor.userId,input.enquiryId,input.requestId,input.ipFingerprint,JSON.stringify({template_slug:input.templateSlug,template_version:preview.template_version,provider_calls:0,payment_created:false,entitlement_created:false,service_created:false,run_created:false,outbox_event_created:false})]);
          }
          if(!row || !(row.created_at instanceof Date))throw new Error("Enquiry creation missing");
          const record:MarketplaceExpertEnquiryRecord={enquiryId:row.id,templateSlug:input.templateSlug,templateVersion:preview.template_version,state:row.state,submittedAt:row.created_at};
          await rememberMarketplaceRequest(database,input,enquiryOperation,row.id,{...record,submittedAt:record.submittedAt.toISOString()},true);
          return {kind,record};
        });
      }catch(error){if(error instanceof ApplicationError)throw error;throw mapDatabaseError(error);}
    },
  });
}

/** Private operator-capability seam. No public endpoint or execution entitlement. */
export async function transitionMarketplaceExpertEnquiry(pool:Pool,input:{tenantId:string;enquiryId:string;expectedState:MarketplaceExpertEnquiryState;targetState:MarketplaceExpertEnquiryState;actorUserId:string;traceId:string|null}):Promise<void> {
  const transitions:Partial<Record<MarketplaceExpertEnquiryState,MarketplaceExpertEnquiryState>>={received:"in_review",in_review:"contacted",contacted:"closed"};
  if(transitions[input.expectedState]!==input.targetState)throw new MarketplaceExpertEnquiryStaleError();
  await withOperatorTransaction(pool,async database=>{
    await database.query("SELECT set_config('app.organization_id',$1,true),set_config('app.user_id',$2,true)",[input.tenantId,input.actorUserId]);
    const actor=await database.query("SELECT id FROM app.users WHERE id=$1 AND state='active' FOR SHARE",[input.actorUserId]);
    if(actor.rowCount!==1)throw new Error("Named active staff actor required");
    const row=await database.query("SELECT state FROM app.marketplace_expert_enquiries WHERE organization_id=$1 AND id=$2 FOR UPDATE",[input.tenantId,input.enquiryId]);
    if(!row.rows[0])throw new MarketplaceExpertEnquiryNotFoundError();
    if(row.rows[0].state!==input.expectedState)throw new MarketplaceExpertEnquiryStaleError();
    await database.query("UPDATE app.marketplace_expert_enquiries SET state=$3 WHERE organization_id=$1 AND id=$2",[input.tenantId,input.enquiryId,input.targetState]);
    await database.query("INSERT INTO app.audit_events(organization_id,actor_user_id,action,target_type,target_id,outcome,trace_id,safe_diff) VALUES($1,$2,'marketplace.expert_enquiry.transition','marketplace_expert_enquiry',$3,$4,$5,jsonb_build_object('from',$6::text,'to',$4::text,'transition_at',clock_timestamp(),'provider_calls',0))",[input.tenantId,input.actorUserId,input.enquiryId,input.targetState,input.traceId,input.expectedState]);
  });
}
