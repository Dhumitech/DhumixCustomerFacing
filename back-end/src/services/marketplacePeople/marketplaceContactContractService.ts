import { createHash, randomUUID } from "node:crypto";
import type { ProviderReferenceProtector } from
  "../brightdata/providerReferenceProtector.js";
import type { QualificationEvidenceStore } from
  "../qualification/qualificationEvidenceStore.js";
import type {
  MarketplaceContactContractRepository,
  MarketplaceContactModeContract,
} from "./marketplaceContactContractRepository.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$/;
const DATASET_ID = /\bgd_[a-z0-9]{8,128}\b/g;
const FAQ_SOURCE_URI = "https://docs.brightdata.com/products/marketplace/faqs";
const SEARCH_SOURCE_URI =
  "https://docs.brightdata.com/api-reference/marketplace-dataset-api/search-dataset";
const CONTRACT_VERSION = 1 as const;

export const LINKEDIN_PEOPLE_CONTACT_MODES = Object.freeze([
  Object.freeze({
    code: "standard" as const,
    displayOrder: 1 as const,
    customerMeaning: "Standard LinkedIn profile data without a contact-data promise.",
    previewState: "available" as const,
    fulfillmentState: "not_enabled" as const,
  }),
  Object.freeze({
    code: "enriched_when_available" as const,
    displayOrder: 2 as const,
    customerMeaning: "Standard profiles plus available business contact information.",
    previewState: "not_enabled" as const,
    fulfillmentState: "not_enabled" as const,
  }),
  Object.freeze({
    code: "contacts_only" as const,
    displayOrder: 3 as const,
    customerMeaning: "Only profiles satisfying the provider's unproven contact-presence semantics.",
    previewState: "not_enabled" as const,
    fulfillmentState: "not_enabled" as const,
  }),
] satisfies readonly MarketplaceContactModeContract[]);

export const LINKEDIN_PEOPLE_CONTACT_OPEN_GATES = Object.freeze([
  "post_purchase_fulfillment_endpoint",
  "post_purchase_request_schema",
  "post_purchase_response_schema",
  "account_entitlement",
  "contact_presence_semantics",
  "profile_omission_behavior",
  "rights_and_masking_scope",
  "independent_qualification",
  "protected_mapping",
] as const);

export type MarketplaceContactContractErrorCode =
  | "MARKETPLACE_CONTACT_CONTRACT_CONFIGURATION_INVALID"
  | "MARKETPLACE_CONTACT_CONTRACT_CONFIRMATION_REQUIRED"
  | "MARKETPLACE_CONTACT_CONTRACT_INPUT_INVALID"
  | "MARKETPLACE_CONTACT_CONTRACT_EVIDENCE_INVALID"
  | "MARKETPLACE_CONTACT_CONTRACT_CONFLICT"
  | "MARKETPLACE_CONTACT_CONTRACT_STORAGE_FAILURE"
  | "MARKETPLACE_CONTACT_CONTRACT_DATABASE_FAILURE";

export class MarketplaceContactContractError extends Error {
  public constructor(
    public readonly code: MarketplaceContactContractErrorCode,
    cause?: unknown,
  ) {
    super("LinkedIn People contact-contract evidence failed",
      cause === undefined ? undefined : { cause });
    this.name = "MarketplaceContactContractError";
  }
}

interface EvidenceDocument {
  readonly sourceUri: string;
  readonly bytes: Buffer;
}

interface Dependencies {
  readonly repository: MarketplaceContactContractRepository;
  readonly evidenceStore: QualificationEvidenceStore;
  readonly protector: ProviderReferenceProtector;
  readonly evidenceMaxBytes: number;
  readonly uuid?: () => string;
  readonly now?: () => Date;
}

function sha256(bytes: Buffer): Buffer {
  return createHash("sha256").update(bytes).digest();
}

function text(bytes: Buffer, maximum: number): string {
  if (bytes.byteLength < 2 || bytes.byteLength > maximum) {
    throw new MarketplaceContactContractError("MARKETPLACE_CONTACT_CONTRACT_EVIDENCE_INVALID");
  }
  const value = bytes.toString("utf8");
  if (!Buffer.from(value, "utf8").equals(bytes)) {
    throw new MarketplaceContactContractError("MARKETPLACE_CONTACT_CONTRACT_EVIDENCE_INVALID");
  }
  return value;
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[*`“”"]/g, "").replace(/\s+/g, " ").trim();
}

function requirePhrases(value: string, phrases: readonly string[]): void {
  if (phrases.some((phrase) => !value.includes(phrase))) {
    throw new MarketplaceContactContractError("MARKETPLACE_CONTACT_CONTRACT_EVIDENCE_INVALID");
  }
}

function contactDatasetId(searchSource: string): string {
  const matchingLines = searchSource.split(/\r?\n/)
    .filter((line) => normalized(line).includes("linkedin people profiles, contact-enriched"));
  const identifiers = [...new Set(matchingLines.flatMap((line) => line.match(DATASET_ID) ?? []))];
  if (identifiers.length !== 1) {
    throw new MarketplaceContactContractError("MARKETPLACE_CONTACT_CONTRACT_EVIDENCE_INVALID");
  }
  return identifiers[0] as string;
}

function validateInput(input: {
  readonly standardPeopleCandidateId: string;
  readonly actor: string;
  readonly restrictedReference: string;
  readonly faq: EvidenceDocument;
  readonly search: EvidenceDocument;
}): void {
  if (
    !UUID.test(input.standardPeopleCandidateId) ||
    !ACTOR.test(input.actor) ||
    input.restrictedReference.trim() !== input.restrictedReference ||
    input.restrictedReference.length < 8 ||
    input.restrictedReference.length > 1024 ||
    input.faq.sourceUri !== FAQ_SOURCE_URI ||
    input.search.sourceUri !== SEARCH_SOURCE_URI
  ) {
    throw new MarketplaceContactContractError("MARKETPLACE_CONTACT_CONTRACT_INPUT_INVALID");
  }
}

function context(environment: "local" | "test"): Buffer {
  return Buffer.from(
    `dhumi:marketplace-contact-contract:v1:${environment}:linkedin.people.contact-enriched`,
    "utf8",
  );
}

function same(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && left.equals(right);
}

function failure(error: unknown): MarketplaceContactContractError {
  if (error instanceof MarketplaceContactContractError) return error;
  return new MarketplaceContactContractError(
    "MARKETPLACE_CONTACT_CONTRACT_DATABASE_FAILURE",
    error,
  );
}

export function createMarketplaceContactContractService(dependencies: Dependencies) {
  if (!Number.isSafeInteger(dependencies.evidenceMaxBytes) || dependencies.evidenceMaxBytes < 2) {
    throw new MarketplaceContactContractError(
      "MARKETPLACE_CONTACT_CONTRACT_CONFIGURATION_INVALID",
    );
  }
  const uuid = dependencies.uuid ?? randomUUID;
  const now = dependencies.now ?? (() => new Date());

  return Object.freeze({
    async register(input: {
      readonly standardPeopleCandidateId: string;
      readonly actor: string;
      readonly restrictedReference: string;
      readonly faq: EvidenceDocument;
      readonly search: EvidenceDocument;
      readonly confirmedOfflineEvidence?: true;
    }) {
      if (input.confirmedOfflineEvidence !== true) {
        throw new MarketplaceContactContractError(
          "MARKETPLACE_CONTACT_CONTRACT_CONFIRMATION_REQUIRED",
        );
      }
      validateInput(input);
      try {
        const faqText = normalized(text(input.faq.bytes, dependencies.evidenceMaxBytes));
        requirePhrases(faqText, [
          "linkedin people profiles",
          "standard linkedin profile data: no contact info",
          "standard profiles + enriched with business contact info",
          "only profiles with business contact info",
          "contact data coverage may vary",
          "business emails and phone numbers",
          "revenuebase",
        ]);
        const searchText = text(input.search.bytes, dependencies.evidenceMaxBytes);
        const normalizedSearch = normalized(searchText);
        requirePhrases(normalizedSearch, [
          "post request",
          "/datasets/search/:dataset_id",
          "linkedin people profiles, contact-enriched",
          "search returns the records inline",
          "hits",
          "total_hits",
        ]);

        const providerDatasetId = contactDatasetId(searchText);
        const candidate = await dependencies.repository.resolveStandardPeopleCandidate(
          input.standardPeopleCandidateId,
        );
        const protectedReference = await dependencies.protector.protect(
          providerDatasetId,
          context(candidate.environment),
        );
        const faqChecksum = sha256(input.faq.bytes);
        const searchChecksum = sha256(input.search.bytes);
        const existing = await dependencies.repository.findContract({
          templateVersionId: candidate.templateVersionId,
          contractVersion: CONTRACT_VERSION,
        });
        if (existing !== undefined) {
          if (
            !same(existing.faqChecksum, faqChecksum) ||
            !same(existing.searchChecksum, searchChecksum) ||
            !same(existing.providerResourceFingerprint, protectedReference.fingerprint)
          ) {
            throw new MarketplaceContactContractError(
              "MARKETPLACE_CONTACT_CONTRACT_CONFLICT",
            );
          }
          return Object.freeze({
            packetId: existing.packetId,
            contractVersion: existing.contractVersion,
            governanceState: existing.governanceState,
            fulfillmentState: existing.fulfillmentState,
            openGates: LINKEDIN_PEOPLE_CONTACT_OPEN_GATES,
            providerCalls: 0 as const,
            disposition: "existing" as const,
          });
        }

        const packetId = uuid();
        const observedAt = now();
        if (!UUID.test(packetId) || Number.isNaN(observedAt.valueOf())) {
          throw new MarketplaceContactContractError(
            "MARKETPLACE_CONTACT_CONTRACT_CONFIGURATION_INVALID",
          );
        }
        const sourceObservedOn = observedAt.toISOString().slice(0, 10);
        const manifestBytes = Buffer.from(JSON.stringify({
          contract_version: CONTRACT_VERSION,
          subject: "linkedin.people.contact_enriched",
          source_observed_on: sourceObservedOn,
          sources: [
            { kind: "official_marketplace_faq", uri: FAQ_SOURCE_URI,
              sha256: faqChecksum.toString("hex") },
            { kind: "official_search_contract", uri: SEARCH_SOURCE_URI,
              sha256: searchChecksum.toString("hex") },
          ],
          established_claims: [
            "three_contact_choices_documented",
            "standard_excludes_contact_information",
            "business_email_phone_available_when_provided",
            "contact_coverage_varies",
            "separate_contact_enriched_search_dataset_documented",
          ],
          modes: LINKEDIN_PEOPLE_CONTACT_MODES.map((mode) => ({
            code: mode.code,
            display_order: mode.displayOrder,
            customer_meaning: mode.customerMeaning,
            preview_state: mode.previewState,
            fulfillment_state: mode.fulfillmentState,
          })),
          open_gates: LINKEDIN_PEOPLE_CONTACT_OPEN_GATES,
          provider_calls: 0,
        }), "utf8");
        const objectKey = `qualification/contact-contracts/${packetId}/source-manifest.json`;
        const faqObjectKey = `qualification/contact-contracts/${packetId}/marketplace-faq.md`;
        const searchObjectKey = `qualification/contact-contracts/${packetId}/search-contract.md`;
        let receipt;
        try {
          const [faqReceipt, searchReceipt, manifestReceipt] = await Promise.all([
            dependencies.evidenceStore.putImmutable({
              objectKey: faqObjectKey,
              bytes: input.faq.bytes,
              contentType: "text/markdown",
              maxBytes: dependencies.evidenceMaxBytes,
            }),
            dependencies.evidenceStore.putImmutable({
              objectKey: searchObjectKey,
              bytes: input.search.bytes,
              contentType: "text/markdown",
              maxBytes: dependencies.evidenceMaxBytes,
            }),
            dependencies.evidenceStore.putImmutable({
              objectKey,
              bytes: manifestBytes,
              contentType: "application/json",
              maxBytes: dependencies.evidenceMaxBytes,
            }),
          ]);
          if (
            faqReceipt.checksumHex !== faqChecksum.toString("hex") ||
            faqReceipt.byteCount !== input.faq.bytes.byteLength ||
            searchReceipt.checksumHex !== searchChecksum.toString("hex") ||
            searchReceipt.byteCount !== input.search.bytes.byteLength
          ) {
            throw new Error("Retained contact source evidence did not verify");
          }
          receipt = manifestReceipt;
        } catch (error) {
          throw new MarketplaceContactContractError(
            "MARKETPLACE_CONTACT_CONTRACT_STORAGE_FAILURE",
            error,
          );
        }
        if (!/^[0-9a-f]{64}$/.test(receipt.checksumHex)) {
          throw new MarketplaceContactContractError(
            "MARKETPLACE_CONTACT_CONTRACT_STORAGE_FAILURE",
          );
        }
        const recorded = await dependencies.repository.recordContract({
          packetId,
          candidateId: candidate.candidateId,
          templateVersionId: candidate.templateVersionId,
          contractVersion: CONTRACT_VERSION,
          evidenceObjectKey: objectKey,
          evidenceChecksum: Buffer.from(receipt.checksumHex, "hex"),
          evidenceByteCount: receipt.byteCount,
          faqEvidenceObjectKey: faqObjectKey,
          searchEvidenceObjectKey: searchObjectKey,
          providerResourceCiphertext: protectedReference.ciphertext,
          providerResourceFingerprint: protectedReference.fingerprint,
          faqSourceUri: FAQ_SOURCE_URI,
          faqChecksum,
          searchSourceUri: SEARCH_SOURCE_URI,
          searchChecksum,
          sourceObservedOn,
          restrictedReference: input.restrictedReference,
          contactModes: LINKEDIN_PEOPLE_CONTACT_MODES,
          governanceState: "fulfillment_evidence_pending",
          fulfillmentState: "not_enabled",
          providerCalls: 0,
          actor: input.actor,
        });
        return Object.freeze({
          packetId: recorded.packetId,
          contractVersion: recorded.contractVersion,
          governanceState: recorded.governanceState,
          fulfillmentState: recorded.fulfillmentState,
          openGates: LINKEDIN_PEOPLE_CONTACT_OPEN_GATES,
          providerCalls: 0 as const,
          disposition: recorded.disposition,
        });
      } catch (error) {
        throw failure(error);
      }
    },
  });
}
