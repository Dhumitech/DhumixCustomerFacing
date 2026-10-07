import type { Pool, QueryResultRow } from "pg";
import { withOperatorTransaction } from "../database/transactions.js";

export interface MarketplaceSampleTarget {
  readonly templateVersionId: string;
  readonly templateSlug: "linkedin-posts";
  readonly templateVersion: number;
  readonly metadataChecksum: Buffer;
}

export interface RecordMarketplaceFixtureSampleInput {
  readonly sampleId: string;
  readonly templateVersionId: string;
  readonly sampleVersion: number;
  readonly objectKey: string;
  readonly contentType: "application/json";
  readonly recordCount: number;
  readonly byteCount: number;
  readonly checksum: Buffer;
  readonly metadataChecksum: Buffer;
  readonly schemaVersion: number;
  readonly maskingPolicyVersion: string;
  readonly retentionPolicyVersion: string;
  readonly provenanceEvidenceReference: string;
  readonly rightsEvidenceReference: null;
  readonly collectedAt: Date;
  readonly publishedAt: null;
  readonly expiresAt: Date;
  readonly sourceKind: "synthetic_fixture";
  readonly state: "validated_fixture";
  readonly actor: string;
}

export interface MarketplaceFixtureSample {
  readonly sampleId: string;
  readonly objectKey: string;
  readonly contentType: "application/json";
  readonly recordCount: number;
  readonly byteCount: number;
  readonly checksum: Buffer;
  readonly metadataChecksum: Buffer;
  readonly schemaVersion: number;
  readonly maskingPolicyVersion: string;
  readonly retentionPolicyVersion: string;
  readonly provenanceEvidenceReference: string;
  readonly collectedAt: Date;
  readonly expiresAt: Date;
}

export interface ExpiredMarketplaceFixture {
  readonly sampleId: string;
  readonly objectKey: string;
}

export interface MarketplaceSampleRepository {
  resolveTarget(input: {
    readonly templateSlug: "linkedin-posts";
    readonly templateVersion: number;
  }): Promise<MarketplaceSampleTarget>;
  recordFixture(input: RecordMarketplaceFixtureSampleInput): Promise<{
    readonly sampleId: string;
    readonly disposition: "created" | "existing";
  }>;
  resolveFixture(input: {
    readonly templateSlug: "linkedin-posts";
    readonly templateVersion: number;
    readonly sampleVersion: number;
    readonly asOf: Date;
  }): Promise<MarketplaceFixtureSample>;
  listExpiredFixtures(input: {
    readonly asOf: Date;
    readonly limit: number;
  }): Promise<readonly ExpiredMarketplaceFixture[]>;
  recordFixtureDeletion(input: {
    readonly sampleId: string;
    readonly deletedAt: Date;
    readonly storageDisposition: "deleted" | "already_absent";
    readonly actor: string;
  }): Promise<{
    readonly sampleId: string;
    readonly disposition: "created" | "existing";
  }>;
}

interface TargetRow extends QueryResultRow {
  readonly template_version_id: string;
  readonly template_slug: "linkedin-posts";
  readonly template_version: number;
  readonly metadata_checksum: Buffer;
}


interface FixtureRow extends QueryResultRow {
  readonly sample_id: string;
  readonly object_key: string;
  readonly content_type: "application/json";
  readonly record_count: number;
  readonly byte_count: string;
  readonly checksum: Buffer;
  readonly metadata_checksum: Buffer;
  readonly schema_version: number;
  readonly masking_policy_version: string;
  readonly retention_policy_version: string;
  readonly provenance_evidence_reference: string;
  readonly collected_at: Date;
  readonly expires_at: Date;
}

interface ExpiredFixtureRow extends QueryResultRow {
  readonly sample_id: string;
  readonly object_key: string;
}


function positiveSafeInteger(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("Marketplace sample numeric database value was invalid");
  }
  return parsed;
}

export function createMarketplaceSampleRepository(pool:Pool):MarketplaceSampleRepository {
 return Object.freeze({
  async resolveTarget(input:Parameters<MarketplaceSampleRepository["resolveTarget"]>[0]) {
   return withOperatorTransaction(pool,async database=>{
    const result=await database.query<TargetRow>(`SELECT
    version.id template_version_id,
    template.slug template_slug,
    version.version template_version,
    decode(version.presentation_metadata->>'sample_metadata_checksum','hex') metadata_checksum
  FROM app.service_templates AS template
  JOIN app.service_template_versions AS version
    ON version.service_template_id = template.id
  WHERE $1 = 'linkedin-posts'
    AND $2 = 1
    AND template.slug = $1
    AND template.product_family = 'marketplace_dataset'
    AND template.state = 'draft'
    AND template.current_public_version_id IS NULL
    AND version.version = $2
    AND version.availability_state = 'coming_soon'
    AND version.published_at IS NULL
    AND version.presentation_metadata->>'sample_metadata_checksum' ~ '^[0-9a-f]{64}$'
    AND version.engine IS NULL
    AND version.execution_definition IS NULL
    AND version.provider_dataset_ciphertext IS NULL`,[input.templateSlug,input.templateVersion]);const row=result.rows[0];
    if(!row || row.template_slug!=="linkedin-posts" || row.template_version!==input.templateVersion || !Buffer.isBuffer(row.metadata_checksum) || row.metadata_checksum.length!==32)throw new Error("Marketplace sample target resolution was invalid");
    return {templateVersionId:row.template_version_id,templateSlug:row.template_slug,templateVersion:row.template_version,metadataChecksum:row.metadata_checksum};
   });
  },
    async recordFixture(input: Parameters<MarketplaceSampleRepository["recordFixture"]>[0]) {
      if(!Number.isInteger(input.sampleVersion)||input.sampleVersion<1 || input.contentType!=="application/json" || !Number.isSafeInteger(input.recordCount)||input.recordCount<1 || !Number.isSafeInteger(input.byteCount)||input.byteCount<2 || input.checksum.length!==32 || input.metadataChecksum.toString("hex")!=="c210bf596129141cee74e7d4b339fc70b12fd4117201c693116073bcdde7d3a4" || !Number.isInteger(input.schemaVersion)||input.schemaVersion<1 || !/^[a-z][a-z0-9._-]{2,127}$/.test(input.maskingPolicyVersion) || !/^[a-z][a-z0-9._-]{2,127}$/.test(input.retentionPolicyVersion) || !new RegExp("^fixture://[A-Za-z0-9][A-Za-z0-9._/-]*$").test(input.provenanceEvidenceReference) || input.provenanceEvidenceReference.length<16 || input.provenanceEvidenceReference.length>1024 || !(input.collectedAt instanceof Date) || !(input.expiresAt instanceof Date) || !Number.isFinite(input.collectedAt.valueOf()) || !Number.isFinite(input.expiresAt.valueOf()) || input.expiresAt<=input.collectedAt || !/^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$/.test(input.actor) || input.objectKey!=="marketplace/samples/"+input.templateVersionId+"/"+input.sampleVersion+"/"+input.checksum.toString("hex")+".json") throw new TypeError("Invalid Marketplace fixture sample");
      return withOperatorTransaction(pool,async database=>{
        const target=await database.query<TargetRow>(`SELECT
    version.id template_version_id,
    template.slug template_slug,
    version.version template_version,
    decode(version.presentation_metadata->>'sample_metadata_checksum','hex') metadata_checksum
  FROM app.service_templates AS template
  JOIN app.service_template_versions AS version
    ON version.service_template_id = template.id
  WHERE $1 = 'linkedin-posts'
    AND $2 = 1
    AND template.slug = $1
    AND template.product_family = 'marketplace_dataset'
    AND template.state = 'draft'
    AND template.current_public_version_id IS NULL
    AND version.version = $2
    AND version.availability_state = 'coming_soon'
    AND version.published_at IS NULL
    AND version.presentation_metadata->>'sample_metadata_checksum' ~ '^[0-9a-f]{64}$'
    AND version.engine IS NULL
    AND version.execution_definition IS NULL
    AND version.provider_dataset_ciphertext IS NULL`,["linkedin-posts",1]);
        if(target.rows[0]?.template_version_id!==input.templateVersionId || !target.rows[0]?.metadata_checksum.equals(input.metadataChecksum))throw new Error("Marketplace sample target not found");
        await database.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text||':'||$2::text,0))",[input.templateVersionId,input.sampleVersion]);
        const evidence=JSON.stringify({provenance:input.provenanceEvidenceReference,rights:null,decision:null,qualification_packet_id:null});
        const values=[input.sampleId,input.templateVersionId,input.sampleVersion,input.objectKey,input.contentType,input.recordCount,input.byteCount,input.checksum,input.metadataChecksum,input.schemaVersion,input.maskingPolicyVersion,input.retentionPolicyVersion,evidence,input.collectedAt,input.expiresAt,JSON.stringify([{"name":"url","type":"url","active":true,"required":true,"description":"LinkedIn post URL","sample_visibility":"visible","allowed_operators":["=","!=","in","not_in","includes","not_includes","is_null","is_not_null"],"post_purchase_visibility":"visible"},{"name":"text","type":"text","active":true,"required":false,"description":"LinkedIn post text","sample_visibility":"masked","allowed_operators":[],"post_purchase_visibility":"visible"}])];
        const existing=await database.query(`SELECT id,(object_key=$4 AND content_type=$5 AND record_count=$6 AND byte_count=$7 AND checksum=$8 AND source_metadata_checksum=$9 AND schema_version=$10 AND masking_policy_version=$11 AND retention_policy_version=$12 AND evidence_ref::jsonb=$13::jsonb AND collected_at=$14 AND expires_at=$15 AND source_kind='synthetic_fixture' AND state='validated_fixture' AND field_dictionary=$16::jsonb AND governance_state='synthetic_fixture' AND published_at IS NULL) matches FROM app.marketplace_samples WHERE template_version_id=$2 AND sample_version=$3 AND $1::uuid IS NOT NULL`,values);
        if(existing.rows[0]){if(existing.rows[0].matches!==true)throw new Error("Marketplace sample version conflict");return {sampleId:String(existing.rows[0].id),disposition:"existing" as const};}
        await database.query(`INSERT INTO app.marketplace_samples(id,template_version_id,sample_version,object_key,content_type,record_count,byte_count,checksum,source_metadata_checksum,schema_version,masking_policy_version,retention_policy_version,evidence_ref,collected_at,expires_at,field_dictionary,source_kind,state,governance_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,'synthetic_fixture','validated_fixture','synthetic_fixture')`,values);
        await database.query("INSERT INTO app.audit_events(action,target_type,target_id,outcome,safe_diff) VALUES('marketplace.sample_fixture.ingest','marketplace_sample_version',$1,'completed',$2::jsonb)",[input.sampleId,JSON.stringify({actor:input.actor,template_slug:"linkedin-posts",template_version:1,sample_version:input.sampleVersion,record_count:input.recordCount,byte_count:input.byteCount,checksum:input.checksum.toString("hex"),schema_version:input.schemaVersion,masking_policy_version:input.maskingPolicyVersion,retention_policy_version:input.retentionPolicyVersion,expires_at:input.expiresAt.toISOString(),source_kind:"synthetic_fixture",customer_visible:false,provider_calls:0})]);
        return {sampleId:input.sampleId,disposition:"created" as const};
      });
    },


  async resolveFixture(input:Parameters<MarketplaceSampleRepository["resolveFixture"]>[0]) {
   return withOperatorTransaction(pool,async database=>{
    const result=await database.query<FixtureRow>(`SELECT
    sample.id sample_id,
    sample.object_key,
    sample.content_type,
    sample.record_count,
    sample.byte_count,
    sample.checksum,
    sample.source_metadata_checksum metadata_checksum,
    sample.schema_version,
    sample.masking_policy_version,
    sample.retention_policy_version,
    sample.evidence_ref::jsonb->>'provenance' provenance_evidence_reference,
    sample.collected_at,
    sample.expires_at
  FROM app.marketplace_samples AS sample
  JOIN app.service_template_versions AS version
    ON version.id = sample.template_version_id
  JOIN app.service_templates AS template
    ON template.id = version.service_template_id
  WHERE $1 = 'linkedin-posts'
    AND $2 = 1
    AND $3 > 0
    AND $4::timestamptz IS NOT NULL
    AND template.slug = $1
    AND template.product_family = 'marketplace_dataset'
    AND template.state = 'draft'
    AND template.current_public_version_id IS NULL
    AND version.version = $2
    AND version.availability_state = 'coming_soon'
    AND sample.sample_version = $3
    AND sample.source_kind = 'synthetic_fixture'
    AND sample.state = 'validated_fixture'
    AND (sample.evidence_ref::jsonb->>'rights') IS NULL
    AND sample.published_at IS NULL
    AND sample.masking_policy_version =
      'linkedin-posts-provider-mask-preservation-v1'
    AND sample.retention_policy_version = 'linkedin-posts-sample-30d-v1'
    AND sample.expires_at = sample.collected_at + interval '720 hours'
    AND $4 < sample.expires_at
    AND sample.deleted_at IS NULL`,[input.templateSlug,input.templateVersion,input.sampleVersion,input.asOf]);const row=result.rows[0];
    if(!row || row.content_type!=="application/json" || !Buffer.isBuffer(row.checksum)||row.checksum.length!==32 || !Buffer.isBuffer(row.metadata_checksum)||row.metadata_checksum.length!==32 || !(row.collected_at instanceof Date)||!(row.expires_at instanceof Date))throw new Error("Marketplace fixture sample was unavailable");
    return {sampleId:row.sample_id,objectKey:row.object_key,contentType:row.content_type,recordCount:positiveSafeInteger(row.record_count),byteCount:positiveSafeInteger(row.byte_count),checksum:row.checksum,metadataChecksum:row.metadata_checksum,schemaVersion:positiveSafeInteger(row.schema_version),maskingPolicyVersion:row.masking_policy_version,retentionPolicyVersion:row.retention_policy_version,provenanceEvidenceReference:row.provenance_evidence_reference,collectedAt:row.collected_at,expiresAt:row.expires_at};
   });
  },
  async listExpiredFixtures(input:Parameters<MarketplaceSampleRepository["listExpiredFixtures"]>[0]) {
   if(!(input.asOf instanceof Date)||!Number.isFinite(input.asOf.valueOf())||!Number.isInteger(input.limit)||input.limit<1||input.limit>1000)throw new TypeError("Invalid sample expiry input");
   return withOperatorTransaction(pool,async database=>{
    const result=await database.query<ExpiredFixtureRow>(`
  SELECT sample.id sample_id, sample.object_key
  FROM app.marketplace_samples AS sample
  WHERE sample.source_kind IN ('synthetic_fixture', 'provider_qualification')
    AND sample.state IN ('validated_fixture', 'validated_provider_sample')
    AND sample.retention_policy_version IN (
      'linkedin-posts-sample-30d-v1',
      'linkedin-people-sample-30d-v1'
    )
    AND sample.expires_at <= $1
    AND sample.deleted_at IS NULL
  ORDER BY sample.expires_at, sample.id
  LIMIT $2`,[input.asOf,input.limit]);return result.rows.map(row=>({sampleId:row.sample_id,objectKey:row.object_key}));
   });
  },
    async recordFixtureDeletion(input:Parameters<MarketplaceSampleRepository["recordFixtureDeletion"]>[0]) {
      if(!(input.deletedAt instanceof Date)||!Number.isFinite(input.deletedAt.valueOf()) || !["deleted","already_absent"].includes(input.storageDisposition) || !/^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$/.test(input.actor))throw new TypeError("Invalid Marketplace expiry receipt");
      return withOperatorTransaction(pool,async database=>{
        await database.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))",[input.sampleId]);
        const result=await database.query("SELECT * FROM app.marketplace_samples WHERE id=$1 AND source_kind IN ('synthetic_fixture','provider_qualification') AND state IN ('validated_fixture','validated_provider_sample') AND expires_at<=$2 FOR UPDATE",[input.sampleId,input.deletedAt]);
        const row=result.rows[0];if(!row)throw new Error("Marketplace sample expiry not due");
        if(row.deleted_at!==null)return {sampleId:input.sampleId,disposition:"existing" as const};
        await database.query("UPDATE app.marketplace_samples SET deleted_at=$2 WHERE id=$1 AND deleted_at IS NULL",[input.sampleId,input.deletedAt]);
        await database.query("INSERT INTO app.audit_events(action,target_type,target_id,outcome,safe_diff) VALUES($1,'marketplace_sample_version',$2,'completed',$3::jsonb)",[row.source_kind==="provider_qualification"?"marketplace.provider_sample.expire":"marketplace.sample_fixture.expire",input.sampleId,JSON.stringify({actor:input.actor,deleted_at:input.deletedAt.toISOString(),storage_disposition:input.storageDisposition,checksum:(row.checksum as Buffer).toString("hex"),byte_count:Number(row.byte_count),source_kind:row.source_kind,sample_content_retained:false,provider_calls:0})]);
        return {sampleId:input.sampleId,disposition:"created" as const};
      });
    },
  });
}
