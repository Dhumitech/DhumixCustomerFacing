import type { Pool, QueryResultRow } from "pg";
import { withOperatorTransaction } from "../database/transactions.js";

export interface LinkedInPeopleSyntheticSampleSource {
  readonly observationId: string;
  readonly candidateId: string;
  readonly templateVersionId: string;
  readonly templateSlug: "linkedin-people";
  readonly templateVersion: 1;
  readonly evidenceObjectKey: string;
  readonly metadataChecksum: Buffer;
  readonly metadataByteCount: number;
  readonly metadataFieldCount: 46;
  readonly observedAt: Date;
}

export interface LinkedInPeopleFieldDictionaryEntry extends Readonly<Record<string, unknown>> {
  readonly name: string;
  readonly type: "text" | "url" | "date" | "number" | "array" | "object" | "boolean";
  readonly active: true;
  readonly required: boolean;
  readonly description: string;
  readonly sample_visibility: "visible" | "masked";
  readonly allowed_operators: readonly string[];
  readonly post_purchase_visibility: "visible";
}

export interface MarketplacePeopleSampleRepository {
  resolveSource(): Promise<LinkedInPeopleSyntheticSampleSource>;
  recordSyntheticSample(input: {
    readonly sampleId: string;
    readonly observationId: string;
    readonly templateVersionId: string;
    readonly sampleVersion: 1;
    readonly objectKey: string;
    readonly recordCount: 5;
    readonly byteCount: number;
    readonly checksum: Buffer;
    readonly metadataChecksum: Buffer;
    readonly fieldDictionary: readonly LinkedInPeopleFieldDictionaryEntry[];
    readonly actor: string;
  }): Promise<{
    readonly sampleId: string;
    readonly disposition: "created" | "existing";
  }>;
}

interface SourceRow extends QueryResultRow {
  readonly observation_id: string;
  readonly candidate_id: string;
  readonly template_version_id: string;
  readonly template_slug: "linkedin-people";
  readonly template_version: number;
  readonly evidence_object_key: string;
  readonly metadata_checksum: Buffer;
  readonly metadata_byte_count: string | number;
  readonly metadata_field_count: number;
  readonly observed_at: Date;
}

interface RecordRow extends QueryResultRow {
  readonly sample_id: string;
  readonly disposition: "created" | "existing";
}

function positiveSafeInteger(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("LinkedIn People sample numeric database value was invalid");
  }
  return parsed;
}

export function createMarketplacePeopleSampleRepository(
  pool: Pool,
): MarketplacePeopleSampleRepository {
  return Object.freeze({
    async resolveSource() {
      return withOperatorTransaction(pool, async (database) => {
        const result = await database.query<SourceRow>(
          "SELECT * FROM app.resolve_linkedin_people_synthetic_sample_source()",
        );
        const row = result.rows[0];
        if (
          result.rowCount !== 1 ||
          row === undefined ||
          row.template_slug !== "linkedin-people" ||
          row.template_version !== 1 ||
          row.metadata_field_count !== 46 ||
          !Buffer.isBuffer(row.metadata_checksum) ||
          row.metadata_checksum.byteLength !== 32 ||
          !(row.observed_at instanceof Date) ||
          Number.isNaN(row.observed_at.valueOf())
        ) {
          throw new Error("LinkedIn People synthetic sample source was unavailable");
        }
        return Object.freeze({
          observationId: row.observation_id,
          candidateId: row.candidate_id,
          templateVersionId: row.template_version_id,
          templateSlug: row.template_slug,
          templateVersion: 1 as const,
          evidenceObjectKey: row.evidence_object_key,
          metadataChecksum: row.metadata_checksum,
          metadataByteCount: positiveSafeInteger(row.metadata_byte_count),
          metadataFieldCount: 46 as const,
          observedAt: row.observed_at,
        });
      });
    },

    async recordSyntheticSample(
      input: Parameters<MarketplacePeopleSampleRepository["recordSyntheticSample"]>[0],
    ) {
      return withOperatorTransaction(pool, async (database) => {
        const result = await database.query<RecordRow>(
          `SELECT * FROM app.record_linkedin_people_synthetic_sample_v2(
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11
           )`,
          [
            input.sampleId,
            input.observationId,
            input.templateVersionId,
            input.sampleVersion,
            input.objectKey,
            input.recordCount,
            input.byteCount,
            input.checksum,
            input.metadataChecksum,
            JSON.stringify(input.fieldDictionary),
            input.actor,
          ],
        );
        const row = result.rows[0];
        if (
          result.rowCount !== 1 ||
          row === undefined ||
          !["created", "existing"].includes(row.disposition)
        ) {
          throw new Error("LinkedIn People synthetic sample was not recorded");
        }
        return Object.freeze({ sampleId: row.sample_id, disposition: row.disposition });
      });
    },
  });
}
