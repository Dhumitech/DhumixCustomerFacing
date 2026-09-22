import type { Pool, QueryResultRow } from "pg";
import { withOperatorTransaction } from "../database/transactions.js";

export type MarketplaceOfferCode = "linkedin.posts" | "linkedin.people.standard";

export interface MarketplaceImportCandidate {
  readonly id: string;
  readonly offerCode: MarketplaceOfferCode;
  readonly providerName: string;
  readonly recordCount: number | null;
  readonly catalogueEntryChecksum: Buffer;
  readonly ciphertext: Buffer;
  readonly fingerprint: Buffer;
  readonly metadataObjectKey: string;
  readonly metadataChecksum: Buffer;
  readonly metadataObservedAt: Date;
}

export interface MarketplaceImportCandidateResult {
  readonly candidateId: string;
  readonly offerCode: MarketplaceOfferCode;
  readonly disposition: "created" | "existing";
}

export interface MarketplaceCandidateReviewResult {
  readonly candidateId: string;
  readonly reviewState: "approved" | "rejected";
  readonly templateSlug: string | null;
  readonly templateVersion: number | null;
}

export interface MarketplaceCatalogueRepository {
  beginImport(input: {
    readonly importId: string;
    readonly environment: "local" | "test";
    readonly actor: string;
    readonly restrictedReference: string;
  }): Promise<void>;
  completeImport(input: {
    readonly importId: string;
    readonly candidates: readonly MarketplaceImportCandidate[];
    readonly evidenceObjectKey: string;
    readonly evidenceChecksum: Buffer;
    readonly actor: string;
  }): Promise<readonly MarketplaceImportCandidateResult[]>;
  failImport(input: {
    readonly importId: string;
    readonly safeErrorCode: string;
    readonly actor: string;
  }): Promise<void>;
  reviewCandidate(input: {
    readonly candidateId: string;
    readonly decision: "approve" | "reject";
    readonly actor: string;
  }): Promise<MarketplaceCandidateReviewResult>;
}

interface CompleteRow extends QueryResultRow {
  readonly candidate_results: unknown;
}

interface ReviewRow extends QueryResultRow {
  readonly candidate_id: string;
  readonly review_state: "approved" | "rejected";
  readonly template_slug: string | null;
  readonly template_version: number | null;
}

function isOfferCode(value: unknown): value is MarketplaceOfferCode {
  return value === "linkedin.posts" || value === "linkedin.people.standard";
}

function candidateResults(value: unknown): readonly MarketplaceImportCandidateResult[] {
  if (!Array.isArray(value)) throw new Error("Marketplace import returned invalid candidates");
  return Object.freeze(value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("Marketplace import returned invalid candidates");
    }
    const row = entry as Record<string, unknown>;
    if (
      typeof row.candidate_id !== "string" ||
      !isOfferCode(row.offer_code) ||
      (row.disposition !== "created" && row.disposition !== "existing")
    ) {
      throw new Error("Marketplace import returned invalid candidates");
    }
    return Object.freeze({
      candidateId: row.candidate_id,
      offerCode: row.offer_code,
      disposition: row.disposition,
    });
  }));
}

export function createMarketplaceCatalogueRepository(
  pool: Pool,
): MarketplaceCatalogueRepository {
  return Object.freeze({
    async beginImport(input: Parameters<MarketplaceCatalogueRepository["beginImport"]>[0]) {
      await withOperatorTransaction(pool, async (database) => {
        const result = await database.query(
          "SELECT * FROM app.begin_marketplace_catalog_import($1, $2, $3, $4)",
          [input.importId, input.environment, input.actor, input.restrictedReference],
        );
        if (result.rowCount !== 1) throw new Error("Marketplace import was not started");
      });
    },

    async completeImport(input: Parameters<MarketplaceCatalogueRepository["completeImport"]>[0]) {
      return withOperatorTransaction(pool, async (database) => {
        const serialized = input.candidates.map((candidate: MarketplaceImportCandidate) => ({
          id: candidate.id,
          offer_code: candidate.offerCode,
          provider_name: candidate.providerName,
          record_count: candidate.recordCount,
          catalogue_entry_checksum_hex: candidate.catalogueEntryChecksum.toString("hex"),
          ciphertext_hex: candidate.ciphertext.toString("hex"),
          fingerprint_hex: candidate.fingerprint.toString("hex"),
          metadata_object_key: candidate.metadataObjectKey,
          metadata_checksum_hex: candidate.metadataChecksum.toString("hex"),
          metadata_observed_at: candidate.metadataObservedAt.toISOString(),
        }));
        const result = await database.query<CompleteRow>(
          `SELECT app.complete_marketplace_catalog_import($1, $2, $3, $4, $5)
             AS candidate_results`,
          [
            input.importId,
            JSON.stringify(serialized),
            input.evidenceObjectKey,
            input.evidenceChecksum,
            input.actor,
          ],
        );
        return candidateResults(result.rows[0]?.candidate_results);
      });
    },

    async failImport(input: Parameters<MarketplaceCatalogueRepository["failImport"]>[0]) {
      await withOperatorTransaction(pool, async (database) => {
        const result = await database.query<{ recorded: boolean }>(
          "SELECT app.fail_marketplace_catalog_import($1, $2, $3) AS recorded",
          [input.importId, input.safeErrorCode, input.actor],
        );
        if (result.rows[0]?.recorded !== true) {
          throw new Error("Marketplace import failure was not recorded");
        }
      });
    },

    async reviewCandidate(input: Parameters<MarketplaceCatalogueRepository["reviewCandidate"]>[0]) {
      return withOperatorTransaction(pool, async (database) => {
        const result = await database.query<ReviewRow>(
          "SELECT * FROM app.review_marketplace_catalog_candidate($1, $2, $3)",
          [input.candidateId, input.decision, input.actor],
        );
        const row = result.rows[0];
        if (
          row === undefined ||
          row.candidate_id !== input.candidateId ||
          !["approved", "rejected"].includes(row.review_state) ||
          (row.template_version !== null && (!Number.isSafeInteger(row.template_version) || row.template_version < 1))
        ) {
          throw new Error("Marketplace candidate review was not recorded");
        }
        return Object.freeze({
          candidateId: row.candidate_id,
          reviewState: row.review_state,
          templateSlug: row.template_slug,
          templateVersion: row.template_version,
        });
      });
    },
  });
}
