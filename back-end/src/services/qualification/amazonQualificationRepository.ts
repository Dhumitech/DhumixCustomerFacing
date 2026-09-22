import type { Pool, QueryResultRow } from "pg";
import type { BrightDataExecutionMode } from "../brightdata/brightDataIntegrationClient.js";
import { withOperatorTransaction } from "../database/transactions.js";

export interface QualificationCandidatePlan {
  readonly candidateCiphertext: Buffer;
  readonly candidateFingerprint: Buffer;
  readonly serviceTemplateVersionId: string;
  readonly adapterVersionId: string;
  readonly providerCredentialId: string;
}

export interface QualificationAcceptancePlan {
  readonly candidateId: string;
  readonly operationCode: string;
  readonly environment: "local" | "test";
  readonly providerExecutionMode: BrightDataExecutionMode;
  readonly candidateCiphertext: Buffer;
  readonly candidateFingerprint: Buffer;
}

export interface AmazonQualificationRepository {
  beginImport(input: {
    readonly importId: string;
    readonly environment: "local" | "test";
    readonly actor: string;
    readonly restrictedReference: string;
  }): Promise<void>;
  completeImport(input: {
    readonly importId: string;
    readonly candidates: readonly {
      readonly id: string;
      readonly ciphertext: Buffer;
      readonly fingerprint: Buffer;
    }[];
    readonly evidenceObjectKey: string;
    readonly evidenceChecksum: Buffer;
    readonly actor: string;
  }): Promise<number>;
  failImport(input: {
    readonly importId: string;
    readonly safeErrorCode: string;
    readonly actor: string;
  }): Promise<void>;
  reviewCandidate(input: {
    readonly candidateId: string;
    readonly decision: "approve" | "reject";
    readonly actor: string;
  }): Promise<void>;
  resolveCandidate(input: {
    readonly candidateId: string;
    readonly operationCode: string;
    readonly environment: "local" | "test";
  }): Promise<QualificationCandidatePlan>;
  beginQualification(input: {
    readonly qualificationId: string;
    readonly candidateId: string;
    readonly operationCode: string;
    readonly environment: "local" | "test";
    readonly providerExecutionMode: BrightDataExecutionMode;
    readonly requestObjectKey: string;
    readonly requestChecksum: Buffer;
    readonly actor: string;
  }): Promise<void>;
  resolveAcceptance(qualificationId: string): Promise<QualificationAcceptancePlan>;
  completeQualification(input: {
    readonly qualificationId: string;
    readonly state: "succeeded" | "failed" | "uncertain";
    readonly submissionMode: "inline" | "snapshot" | null;
    readonly responseObjectKey: string | null;
    readonly responseChecksum: Buffer | null;
    readonly responseContentType: string | null;
    readonly responseByteCount: number | null;
    readonly recordCount: number | null;
    readonly snapshotCiphertext: Buffer | null;
    readonly snapshotFingerprint: Buffer | null;
    readonly safeErrorCode: string | null;
    readonly actor: string;
  }): Promise<void>;
  acceptQualification(input: {
    readonly qualificationId: string;
    readonly mappingId: string;
    readonly mappingCiphertext: Buffer;
    readonly mappingFingerprint: Buffer;
    readonly outputPolicy: Readonly<Record<string, unknown>>;
    readonly commercialConfigVersion: string;
    readonly configVersion: string;
    readonly restrictedReference: string;
    readonly evidenceHash: Buffer;
    readonly reviewer: string;
    readonly expiresAt: Date | null;
  }): Promise<{ readonly mappingId: string; readonly launchEvidenceId: string }>;
  rejectQualification(input: {
    readonly qualificationId: string;
    readonly reason: string;
    readonly reviewer: string;
  }): Promise<void>;
}

interface CandidateRow extends QueryResultRow {
  readonly candidate_ciphertext: Buffer;
  readonly candidate_fingerprint: Buffer;
  readonly service_template_version_id: string;
  readonly adapter_version_id: string;
  readonly provider_credential_id: string;
}

interface AcceptanceRow extends QueryResultRow {
  readonly candidate_id: string;
  readonly operation_code: string;
  readonly environment: "local" | "test";
  readonly provider_execution_mode: BrightDataExecutionMode;
  readonly candidate_ciphertext: Buffer;
  readonly candidate_fingerprint: Buffer;
}

function assertTrue(value: boolean | undefined, operation: string): void {
  if (value !== true) throw new Error(`${operation} was not recorded`);
}

export function createAmazonQualificationRepository(pool: Pool): AmazonQualificationRepository {
  return {
    async beginImport(input): Promise<void> {
      await withOperatorTransaction(pool, async (database) => {
        const result = await database.query(
          "SELECT * FROM app.begin_amazon_scraper_catalog_import_v2($1, $2, $3, $4)",
          [input.importId, input.environment, input.actor, input.restrictedReference],
        );
        if (result.rowCount !== 1) throw new Error("Qualification import was not started");
      });
    },

    async completeImport(input): Promise<number> {
      return withOperatorTransaction(pool, async (database) => {
        const candidates = input.candidates.map((candidate) => ({
          id: candidate.id,
          ciphertext_hex: candidate.ciphertext.toString("hex"),
          fingerprint_hex: candidate.fingerprint.toString("hex"),
        }));
        const result = await database.query<{ candidate_count: number }>(
          "SELECT app.complete_amazon_scraper_catalog_import($1, $2, $3, $4, $5) AS candidate_count",
          [
            input.importId,
            JSON.stringify(candidates),
            input.evidenceObjectKey,
            input.evidenceChecksum,
            input.actor,
          ],
        );
        const count = Number(result.rows[0]?.candidate_count);
        if (!Number.isSafeInteger(count) || count < 0) {
          throw new Error("Qualification import returned an invalid candidate count");
        }
        return count;
      });
    },

    async failImport(input): Promise<void> {
      await withOperatorTransaction(pool, async (database) => {
        const result = await database.query<{ recorded: boolean }>(
          "SELECT app.fail_amazon_scraper_catalog_import($1, $2, $3) AS recorded",
          [input.importId, input.safeErrorCode, input.actor],
        );
        assertTrue(result.rows[0]?.recorded, "Qualification import failure");
      });
    },

    async reviewCandidate(input): Promise<void> {
      await withOperatorTransaction(pool, async (database) => {
        const result = await database.query<{ recorded: boolean }>(
          "SELECT app.review_amazon_scraper_catalog_candidate($1, $2, $3) AS recorded",
          [input.candidateId, input.decision, input.actor],
        );
        assertTrue(result.rows[0]?.recorded, "Qualification candidate review");
      });
    },

    async resolveCandidate(input): Promise<QualificationCandidatePlan> {
      return withOperatorTransaction(pool, async (database) => {
        const result = await database.query<CandidateRow>(
          "SELECT * FROM app.resolve_amazon_qualification_candidate_v2($1, $2, $3)",
          [input.candidateId, input.operationCode, input.environment],
        );
        const row = result.rows[0];
        if (
          row === undefined ||
          !Buffer.isBuffer(row.candidate_ciphertext) ||
          row.candidate_ciphertext.byteLength < 30 ||
          !Buffer.isBuffer(row.candidate_fingerprint) ||
          row.candidate_fingerprint.byteLength !== 32
        ) {
          throw new Error("Qualification candidate plan was incomplete");
        }
        return {
          candidateCiphertext: row.candidate_ciphertext,
          candidateFingerprint: row.candidate_fingerprint,
          serviceTemplateVersionId: row.service_template_version_id,
          adapterVersionId: row.adapter_version_id,
          providerCredentialId: row.provider_credential_id,
        };
      });
    },

    async beginQualification(input): Promise<void> {
      await withOperatorTransaction(pool, async (database) => {
        const result = await database.query<{ recorded: boolean }>(
          "SELECT app.begin_amazon_provider_qualification_v3($1, $2, $3, $4, $5, $6, $7, $8) AS recorded",
          [
            input.qualificationId,
            input.candidateId,
            input.operationCode,
            input.environment,
            input.providerExecutionMode,
            input.requestObjectKey,
            input.requestChecksum,
            input.actor,
          ],
        );
        assertTrue(result.rows[0]?.recorded, "Provider qualification");
      });
    },

    async resolveAcceptance(qualificationId): Promise<QualificationAcceptancePlan> {
      return withOperatorTransaction(pool, async (database) => {
        const result = await database.query<AcceptanceRow>(
          "SELECT * FROM app.resolve_amazon_qualification_acceptance_plan_v3($1)",
          [qualificationId],
        );
        const row = result.rows[0];
        if (
          row === undefined ||
          !Buffer.isBuffer(row.candidate_ciphertext) ||
          row.candidate_ciphertext.byteLength < 30 ||
          !Buffer.isBuffer(row.candidate_fingerprint) ||
          row.candidate_fingerprint.byteLength !== 32 ||
          !["local", "test"].includes(row.environment) ||
          !["scrape", "trigger"].includes(row.provider_execution_mode)
        ) {
          throw new Error("Qualification acceptance plan was incomplete");
        }
        return {
          candidateId: row.candidate_id,
          operationCode: row.operation_code,
          environment: row.environment,
          providerExecutionMode: row.provider_execution_mode,
          candidateCiphertext: row.candidate_ciphertext,
          candidateFingerprint: row.candidate_fingerprint,
        };
      });
    },

    async completeQualification(input): Promise<void> {
      await withOperatorTransaction(pool, async (database) => {
        const result = await database.query<{ recorded: boolean }>(
          `SELECT app.complete_amazon_provider_qualification(
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
           ) AS recorded`,
          [
            input.qualificationId,
            input.state,
            input.submissionMode,
            input.responseObjectKey,
            input.responseChecksum,
            input.responseContentType,
            input.responseByteCount,
            input.recordCount,
            input.snapshotCiphertext,
            input.snapshotFingerprint,
            input.safeErrorCode,
            input.actor,
          ],
        );
        assertTrue(result.rows[0]?.recorded, "Provider qualification completion");
      });
    },

    async acceptQualification(input) {
      return withOperatorTransaction(pool, async (database) => {
        const result = await database.query<{
          provider_mapping_id: string;
          launch_evidence_id: string;
        }>(
          `SELECT * FROM app.accept_amazon_provider_qualification_v3(
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
           )`,
          [
            input.qualificationId,
            input.mappingId,
            input.mappingCiphertext,
            input.mappingFingerprint,
            JSON.stringify(input.outputPolicy),
            input.commercialConfigVersion,
            input.configVersion,
            input.restrictedReference,
            input.evidenceHash,
            input.reviewer,
            input.expiresAt,
          ],
        );
        const row = result.rows[0];
        if (row === undefined) throw new Error("Qualification acceptance returned no mapping");
        return {
          mappingId: row.provider_mapping_id,
          launchEvidenceId: row.launch_evidence_id,
        };
      });
    },

    async rejectQualification(input): Promise<void> {
      await withOperatorTransaction(pool, async (database) => {
        const result = await database.query<{ recorded: boolean }>(
          "SELECT app.reject_amazon_provider_qualification($1, $2, $3) AS recorded",
          [input.qualificationId, input.reason, input.reviewer],
        );
        assertTrue(result.rows[0]?.recorded, "Provider qualification rejection");
      });
    },
  };
}
