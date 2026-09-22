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

export interface MarketplaceQualifiedSampleSource {
  readonly packetId: string;
  readonly templateVersionId: string;
  readonly templateSlug: "linkedin-posts";
  readonly templateVersion: number;
  readonly environment: "local" | "test";
  readonly providerResourceCiphertext: Buffer;
  readonly providerResourceFingerprint: Buffer;
  readonly rawObjectKey: string;
  readonly rawContentType: "application/json";
  readonly rawRecordCount: number;
  readonly rawByteCount: number;
  readonly rawChecksum: Buffer;
  readonly completedAt: Date;
}

export interface RecordMarketplaceProviderSampleInput {
  readonly sampleId: string;
  readonly packetId: string;
  readonly templateVersionId: string;
  readonly sampleVersion: number;
  readonly objectKey: string;
  readonly recordCount: number;
  readonly byteCount: number;
  readonly checksum: Buffer;
  readonly metadataChecksum: Buffer;
  readonly fieldDictionary: readonly Readonly<Record<string, unknown>>[];
  readonly interimDecisionReference: string;
  readonly actor: string;
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

export interface MarketplaceProviderSampleRepository {
  resolveQualifiedSource(input: {
    readonly packetId: string;
  }): Promise<MarketplaceQualifiedSampleSource>;
  recordProviderSample(input: RecordMarketplaceProviderSampleInput): Promise<{
    readonly sampleId: string;
    readonly disposition: "created" | "existing";
    readonly collectedAt: Date;
    readonly expiresAt: Date;
  }>;
}

interface TargetRow extends QueryResultRow {
  readonly template_version_id: string;
  readonly template_slug: "linkedin-posts";
  readonly template_version: number;
  readonly metadata_checksum: Buffer;
}

interface RecordRow extends QueryResultRow {
  readonly sample_id: string;
  readonly disposition: "created" | "existing";
  readonly collected_at?: Date;
  readonly expires_at?: Date;
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

interface DeletionRow extends QueryResultRow {
  readonly sample_id: string;
  readonly disposition: "created" | "existing";
}

interface QualifiedSourceRow extends QueryResultRow {
  readonly packet_id: string;
  readonly template_version_id: string;
  readonly template_slug: "linkedin-posts";
  readonly template_version: number;
  readonly environment: "local" | "test";
  readonly provider_resource_ciphertext: Buffer;
  readonly provider_resource_fingerprint: Buffer;
  readonly raw_object_key: string;
  readonly raw_content_type: "application/json";
  readonly raw_record_count: number;
  readonly raw_byte_count: string | number;
  readonly raw_checksum: Buffer;
  readonly completed_at: Date;
}

function positiveSafeInteger(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("Marketplace sample numeric database value was invalid");
  }
  return parsed;
}

export function createMarketplaceSampleRepository(
  pool: Pool,
): MarketplaceSampleRepository & MarketplaceProviderSampleRepository {
  return Object.freeze({
    async resolveTarget(input: Parameters<MarketplaceSampleRepository["resolveTarget"]>[0]) {
      return withOperatorTransaction(pool, async (database) => {
        const result = await database.query<TargetRow>(
          "SELECT * FROM app.resolve_marketplace_sample_ingestion_target($1, $2)",
          [input.templateSlug, input.templateVersion],
        );
        const row = result.rows[0];
        if (
          row === undefined ||
          row.template_slug !== "linkedin-posts" ||
          row.template_version !== input.templateVersion ||
          !Buffer.isBuffer(row.metadata_checksum) ||
          row.metadata_checksum.byteLength !== 32
        ) {
          throw new Error("Marketplace sample target resolution was invalid");
        }
        return {
          templateVersionId: row.template_version_id,
          templateSlug: row.template_slug,
          templateVersion: row.template_version,
          metadataChecksum: row.metadata_checksum,
        };
      });
    },

    async recordFixture(input: Parameters<MarketplaceSampleRepository["recordFixture"]>[0]) {
      return withOperatorTransaction(pool, async (database) => {
        const result = await database.query<RecordRow>(
          `SELECT * FROM app.record_marketplace_fixture_sample(
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
           )`,
          [
            input.sampleId,
            input.templateVersionId,
            input.sampleVersion,
            input.objectKey,
            input.contentType,
            input.recordCount,
            input.byteCount,
            input.checksum,
            input.metadataChecksum,
            input.schemaVersion,
            input.maskingPolicyVersion,
            input.retentionPolicyVersion,
            input.provenanceEvidenceReference,
            input.collectedAt,
            input.expiresAt,
            input.actor,
          ],
        );
        const row = result.rows[0];
        if (
          row === undefined ||
          (row.disposition !== "created" && row.disposition !== "existing")
        ) {
          throw new Error("Marketplace fixture sample was not recorded");
        }
        return { sampleId: row.sample_id, disposition: row.disposition };
      });
    },

    async resolveFixture(input: Parameters<MarketplaceSampleRepository["resolveFixture"]>[0]) {
      return withOperatorTransaction(pool, async (database) => {
        const result = await database.query<FixtureRow>(
          "SELECT * FROM app.resolve_marketplace_fixture_sample($1, $2, $3, $4)",
          [input.templateSlug, input.templateVersion, input.sampleVersion, input.asOf],
        );
        const row = result.rows[0];
        if (
          row === undefined ||
          row.content_type !== "application/json" ||
          !Buffer.isBuffer(row.checksum) ||
          row.checksum.byteLength !== 32 ||
          !Buffer.isBuffer(row.metadata_checksum) ||
          row.metadata_checksum.byteLength !== 32 ||
          !(row.collected_at instanceof Date) ||
          !(row.expires_at instanceof Date)
        ) {
          throw new Error("Marketplace fixture sample was unavailable");
        }
        return {
          sampleId: row.sample_id,
          objectKey: row.object_key,
          contentType: row.content_type,
          recordCount: positiveSafeInteger(row.record_count),
          byteCount: positiveSafeInteger(row.byte_count),
          checksum: row.checksum,
          metadataChecksum: row.metadata_checksum,
          schemaVersion: positiveSafeInteger(row.schema_version),
          maskingPolicyVersion: row.masking_policy_version,
          retentionPolicyVersion: row.retention_policy_version,
          provenanceEvidenceReference: row.provenance_evidence_reference,
          collectedAt: row.collected_at,
          expiresAt: row.expires_at,
        };
      });
    },

    async listExpiredFixtures(
      input: Parameters<MarketplaceSampleRepository["listExpiredFixtures"]>[0],
    ) {
      return withOperatorTransaction(pool, async (database) => {
        const result = await database.query<ExpiredFixtureRow>(
          "SELECT * FROM app.list_expired_marketplace_fixture_samples($1, $2)",
          [input.asOf, input.limit],
        );
        return result.rows.map((row) => ({
          sampleId: row.sample_id,
          objectKey: row.object_key,
        }));
      });
    },

    async recordFixtureDeletion(
      input: Parameters<MarketplaceSampleRepository["recordFixtureDeletion"]>[0],
    ) {
      return withOperatorTransaction(pool, async (database) => {
        const result = await database.query<DeletionRow>(
          "SELECT * FROM app.record_marketplace_fixture_deletion($1, $2, $3, $4)",
          [input.sampleId, input.deletedAt, input.storageDisposition, input.actor],
        );
        const row = result.rows[0];
        if (
          row === undefined ||
          (row.disposition !== "created" && row.disposition !== "existing")
        ) {
          throw new Error("Marketplace fixture deletion was not recorded");
        }
        return { sampleId: row.sample_id, disposition: row.disposition };
      });
    },

    async resolveQualifiedSource(
      input: Parameters<MarketplaceProviderSampleRepository["resolveQualifiedSource"]>[0],
    ) {
      return withOperatorTransaction(pool, async (database) => {
        const result = await database.query<QualifiedSourceRow>(
          "SELECT * FROM app.resolve_marketplace_provider_sample_source($1)",
          [input.packetId],
        );
        const row = result.rows[0];
        if (
          row === undefined ||
          row.packet_id !== input.packetId ||
          row.template_slug !== "linkedin-posts" ||
          !["local", "test"].includes(row.environment) ||
          row.raw_content_type !== "application/json" ||
          !Buffer.isBuffer(row.provider_resource_ciphertext) ||
          row.provider_resource_ciphertext.byteLength < 30 ||
          !Buffer.isBuffer(row.provider_resource_fingerprint) ||
          row.provider_resource_fingerprint.byteLength !== 32 ||
          !Buffer.isBuffer(row.raw_checksum) ||
          row.raw_checksum.byteLength !== 32 ||
          !(row.completed_at instanceof Date)
        ) {
          throw new Error("Marketplace qualified sample source was unavailable");
        }
        return Object.freeze({
          packetId: row.packet_id,
          templateVersionId: row.template_version_id,
          templateSlug: row.template_slug,
          templateVersion: positiveSafeInteger(row.template_version),
          environment: row.environment,
          providerResourceCiphertext: row.provider_resource_ciphertext,
          providerResourceFingerprint: row.provider_resource_fingerprint,
          rawObjectKey: row.raw_object_key,
          rawContentType: row.raw_content_type,
          rawRecordCount: positiveSafeInteger(row.raw_record_count),
          rawByteCount: positiveSafeInteger(row.raw_byte_count),
          rawChecksum: row.raw_checksum,
          completedAt: row.completed_at,
        });
      });
    },

    async recordProviderSample(
      input: Parameters<MarketplaceProviderSampleRepository["recordProviderSample"]>[0],
    ) {
      return withOperatorTransaction(pool, async (database) => {
        const result = await database.query<RecordRow>(
          `SELECT * FROM app.record_marketplace_provider_sample_v2(
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12
           )`,
          [
            input.sampleId,
            input.packetId,
            input.templateVersionId,
            input.sampleVersion,
            input.objectKey,
            input.recordCount,
            input.byteCount,
            input.checksum,
            input.metadataChecksum,
            JSON.stringify(input.fieldDictionary),
            input.interimDecisionReference,
            input.actor,
          ],
        );
        const row = result.rows[0];
        if (
          row === undefined ||
          (row.disposition !== "created" && row.disposition !== "existing") ||
          !(row.collected_at instanceof Date) ||
          Number.isNaN(row.collected_at.valueOf()) ||
          !(row.expires_at instanceof Date) ||
          Number.isNaN(row.expires_at.valueOf())
        ) {
          throw new Error("Marketplace provider sample was not recorded");
        }
        return {
          sampleId: row.sample_id,
          disposition: row.disposition,
          collectedAt: row.collected_at,
          expiresAt: row.expires_at,
        };
      });
    },
  });
}
