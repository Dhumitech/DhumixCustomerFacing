import type { Pool, QueryResultRow } from "pg";
import { withOperatorTransaction } from "../database/transactions.js";

export interface ApprovedPeopleCandidate {
  readonly candidateId: string;
  readonly environment: "local" | "test";
  readonly resourceCode: "linkedin.people.standard";
  readonly ciphertext: Buffer;
  readonly fingerprint: Buffer;
}

export interface PeopleMetadataObservation {
  readonly observationId: string;
  readonly candidateId: string;
  readonly fieldCount: number;
  readonly byteCount: number;
  readonly checksum: Buffer;
  readonly observedAt: Date;
  readonly disposition: "created" | "existing";
}

export interface MarketplacePeopleMetadataRepository {
  resolveApprovedCandidate(candidateId: string): Promise<ApprovedPeopleCandidate>;
  recordObservation(input: {
    readonly observationId: string;
    readonly candidateId: string;
    readonly evidenceObjectKey: string;
    readonly checksum: Buffer;
    readonly byteCount: number;
    readonly fieldCount: number;
    readonly contentType: "application/json";
    readonly restrictedReference: string;
    readonly actor: string;
  }): Promise<PeopleMetadataObservation>;
}

interface CandidateRow extends QueryResultRow {
  readonly candidate_id: string;
  readonly environment: "local" | "test";
  readonly resource_code: "linkedin.people.standard";
  readonly provider_resource_ciphertext: Buffer;
  readonly provider_resource_fingerprint: Buffer;
}

interface ObservationRow extends QueryResultRow {
  readonly observation_id: string;
  readonly candidate_id: string;
  readonly field_count: number;
  readonly byte_count: number;
  readonly metadata_checksum: Buffer;
  readonly observed_at: Date;
  readonly disposition: "created" | "existing";
}

export function createMarketplacePeopleMetadataRepository(
  pool: Pool,
): MarketplacePeopleMetadataRepository {
  return Object.freeze({
    async resolveApprovedCandidate(candidateId: string) {
      return withOperatorTransaction(pool, async (database) => {
        const result = await database.query<CandidateRow>(
          "SELECT * FROM app.resolve_linkedin_people_metadata_candidate($1)",
          [candidateId],
        );
        const row = result.rows[0];
        if (
          result.rowCount !== 1 ||
          row === undefined ||
          row.candidate_id !== candidateId ||
          !["local", "test"].includes(row.environment) ||
          row.resource_code !== "linkedin.people.standard" ||
          !Buffer.isBuffer(row.provider_resource_ciphertext) ||
          !Buffer.isBuffer(row.provider_resource_fingerprint)
        ) {
          throw new Error("Approved LinkedIn People candidate was not resolved");
        }
        return Object.freeze({
          candidateId: row.candidate_id,
          environment: row.environment,
          resourceCode: row.resource_code,
          ciphertext: row.provider_resource_ciphertext,
          fingerprint: row.provider_resource_fingerprint,
        });
      });
    },

    async recordObservation(
      input: Parameters<MarketplacePeopleMetadataRepository["recordObservation"]>[0],
    ) {
      return withOperatorTransaction(pool, async (database) => {
        const result = await database.query<ObservationRow>(
          `SELECT * FROM app.record_linkedin_people_metadata_observation(
             $1, $2, $3, $4, $5, $6, $7, $8, $9
           )`,
          [
            input.observationId,
            input.candidateId,
            input.evidenceObjectKey,
            input.checksum,
            input.byteCount,
            input.fieldCount,
            input.contentType,
            input.restrictedReference,
            input.actor,
          ],
        );
        const row = result.rows[0];
        if (
          result.rowCount !== 1 ||
          row === undefined ||
          row.candidate_id !== input.candidateId ||
          !["created", "existing"].includes(row.disposition) ||
          !Buffer.isBuffer(row.metadata_checksum) ||
          !(row.observed_at instanceof Date)
        ) {
          throw new Error("LinkedIn People metadata observation was not recorded");
        }
        return Object.freeze({
          observationId: row.observation_id,
          candidateId: row.candidate_id,
          fieldCount: row.field_count,
          byteCount: row.byte_count,
          checksum: row.metadata_checksum,
          observedAt: row.observed_at,
          disposition: row.disposition,
        });
      });
    },
  });
}
