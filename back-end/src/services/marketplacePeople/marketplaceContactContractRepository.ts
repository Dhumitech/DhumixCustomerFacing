import type { Pool, QueryResultRow } from "pg";
import { withOperatorTransaction } from "../database/transactions.js";

export type MarketplaceContactModeCode =
  | "standard"
  | "enriched_when_available"
  | "contacts_only";

export interface StandardPeopleContactCandidate {
  readonly candidateId: string;
  readonly environment: "local" | "test";
  readonly templateVersionId: string;
  readonly templateVersion: 1;
  readonly metadataChecksum: Buffer;
  readonly sampleVersion: 1;
}

export interface MarketplaceContactModeContract {
  readonly code: MarketplaceContactModeCode;
  readonly displayOrder: 1 | 2 | 3;
  readonly customerMeaning: string;
  readonly previewState: "available" | "not_enabled";
  readonly fulfillmentState: "not_enabled";
}

export interface ExistingMarketplaceContactContract {
  readonly packetId: string;
  readonly templateVersionId: string;
  readonly contractVersion: 1;
  readonly faqChecksum: Buffer;
  readonly searchChecksum: Buffer;
  readonly providerResourceFingerprint: Buffer;
  readonly governanceState: "fulfillment_evidence_pending";
  readonly fulfillmentState: "not_enabled";
  readonly registeredAt: Date;
}

export interface MarketplaceContactContractResult {
  readonly packetId: string;
  readonly templateVersionId: string;
  readonly contractVersion: 1;
  readonly governanceState: "fulfillment_evidence_pending";
  readonly fulfillmentState: "not_enabled";
  readonly registeredAt: Date;
  readonly disposition: "created" | "existing";
}

export interface MarketplaceContactContractRepository {
  resolveStandardPeopleCandidate(candidateId: string): Promise<StandardPeopleContactCandidate>;
  findContract(input: {
    readonly templateVersionId: string;
    readonly contractVersion: 1;
  }): Promise<ExistingMarketplaceContactContract | undefined>;
  recordContract(input: {
    readonly packetId: string;
    readonly candidateId: string;
    readonly templateVersionId: string;
    readonly contractVersion: 1;
    readonly evidenceObjectKey: string;
    readonly evidenceChecksum: Buffer;
    readonly evidenceByteCount: number;
    readonly faqEvidenceObjectKey: string;
    readonly searchEvidenceObjectKey: string;
    readonly providerResourceCiphertext: Buffer;
    readonly providerResourceFingerprint: Buffer;
    readonly faqSourceUri: string;
    readonly faqChecksum: Buffer;
    readonly searchSourceUri: string;
    readonly searchChecksum: Buffer;
    readonly sourceObservedOn: string;
    readonly restrictedReference: string;
    readonly contactModes: readonly MarketplaceContactModeContract[];
    readonly governanceState: "fulfillment_evidence_pending";
    readonly fulfillmentState: "not_enabled";
    readonly providerCalls: 0;
    readonly actor: string;
  }): Promise<MarketplaceContactContractResult>;
}

interface CandidateRow extends QueryResultRow {
  readonly candidate_id: string;
  readonly environment: "local" | "test";
  readonly template_version_id: string;
  readonly template_version: number;
  readonly metadata_checksum: Buffer;
  readonly sample_version: number;
}

interface ContractRow extends QueryResultRow {
  readonly packet_id: string;
  readonly template_version_id: string;
  readonly contract_version: number;
  readonly faq_checksum: Buffer;
  readonly search_checksum: Buffer;
  readonly provider_resource_fingerprint: Buffer;
  readonly governance_state: "fulfillment_evidence_pending";
  readonly fulfillment_state: "not_enabled";
  readonly registered_at: Date;
  readonly disposition?: "created" | "existing";
}

function contract(row: ContractRow, disposition: "created" | "existing"):
  MarketplaceContactContractResult {
  if (
    row.contract_version !== 1 ||
    row.governance_state !== "fulfillment_evidence_pending" ||
    row.fulfillment_state !== "not_enabled" ||
    !(row.registered_at instanceof Date)
  ) {
    throw new Error("LinkedIn People contact contract was invalid");
  }
  return Object.freeze({
    packetId: row.packet_id,
    templateVersionId: row.template_version_id,
    contractVersion: 1,
    governanceState: row.governance_state,
    fulfillmentState: row.fulfillment_state,
    registeredAt: row.registered_at,
    disposition,
  });
}

export function createMarketplaceContactContractRepository(
  pool: Pool,
): MarketplaceContactContractRepository {
  return Object.freeze({
    async resolveStandardPeopleCandidate(candidateId: string) {
      return withOperatorTransaction(pool, async (database) => {
        const result = await database.query<CandidateRow>(
          "SELECT * FROM app.resolve_linkedin_people_contact_contract_candidate($1)",
          [candidateId],
        );
        const row = result.rows[0];
        if (
          result.rowCount !== 1 || row === undefined ||
          row.candidate_id !== candidateId ||
          !["local", "test"].includes(row.environment) ||
          row.template_version !== 1 || row.sample_version !== 1 ||
          !Buffer.isBuffer(row.metadata_checksum) || row.metadata_checksum.byteLength !== 32
        ) {
          throw new Error("Standard LinkedIn People evidence was not resolved");
        }
        return Object.freeze({
          candidateId: row.candidate_id,
          environment: row.environment,
          templateVersionId: row.template_version_id,
          templateVersion: 1 as const,
          metadataChecksum: row.metadata_checksum,
          sampleVersion: 1 as const,
        });
      });
    },

    async findContract(input: {
      readonly templateVersionId: string;
      readonly contractVersion: 1;
    }) {
      return withOperatorTransaction(pool, async (database) => {
        const result = await database.query<ContractRow>(
          `SELECT
             id AS packet_id,
             service_template_version_id AS template_version_id,
             contract_version,
             faq_checksum,
             search_checksum,
             provider_resource_fingerprint,
             governance_state,
             fulfillment_state,
             registered_at
           FROM app.marketplace_contact_contract_packets
           WHERE service_template_version_id = $1
             AND contract_version = $2`,
          [input.templateVersionId, input.contractVersion],
        );
        const row = result.rows[0];
        if (row === undefined) return undefined;
        if (
          result.rowCount !== 1 ||
          !Buffer.isBuffer(row.faq_checksum) ||
          !Buffer.isBuffer(row.search_checksum) ||
          !Buffer.isBuffer(row.provider_resource_fingerprint)
        ) {
          throw new Error("LinkedIn People contact contract lookup was invalid");
        }
        return Object.freeze({
          ...contract(row, "existing"),
          faqChecksum: row.faq_checksum,
          searchChecksum: row.search_checksum,
          providerResourceFingerprint: row.provider_resource_fingerprint,
        });
      });
    },

    async recordContract(input: Parameters<
      MarketplaceContactContractRepository["recordContract"]
    >[0]) {
      return withOperatorTransaction(pool, async (database) => {
        const modes = input.contactModes.map((mode) => ({
          code: mode.code,
          display_order: mode.displayOrder,
          customer_meaning: mode.customerMeaning,
          preview_state: mode.previewState,
          fulfillment_state: mode.fulfillmentState,
        }));
        const result = await database.query<ContractRow>(
          `SELECT * FROM app.record_linkedin_people_contact_contract(
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
           )`,
          [
            input.packetId,
            input.candidateId,
            input.templateVersionId,
            input.contractVersion,
            input.evidenceObjectKey,
            input.evidenceChecksum,
            input.evidenceByteCount,
            input.faqEvidenceObjectKey,
            input.searchEvidenceObjectKey,
            input.providerResourceCiphertext,
            input.providerResourceFingerprint,
            input.faqSourceUri,
            input.faqChecksum,
            input.searchSourceUri,
            input.searchChecksum,
            input.sourceObservedOn,
            input.restrictedReference,
            JSON.stringify(modes),
            input.providerCalls,
            input.actor,
          ],
        );
        const row = result.rows[0];
        if (result.rowCount !== 1 || row === undefined || row.disposition === undefined) {
          throw new Error("LinkedIn People contact contract was not recorded");
        }
        return contract(row, row.disposition);
      });
    },
  });
}
