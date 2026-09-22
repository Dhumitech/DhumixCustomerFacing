import { createHash, randomUUID } from "node:crypto";
import type {
  MarketplaceDatasetCatalogueClient,
  MarketplaceDatasetListItem,
} from "../brightdata/marketplace/marketplaceDatasetCatalogueClient.js";
import { MarketplaceCatalogueBoundaryError } from
  "../brightdata/marketplace/marketplaceDatasetCatalogueClient.js";
import type { ProviderReferenceProtector } from "../brightdata/providerReferenceProtector.js";
import type { SecretProvider } from "../secrets/secretProvider.js";
import type {
  QualificationEvidenceReceipt,
  QualificationEvidenceStore,
} from "../qualification/qualificationEvidenceStore.js";
import type {
  MarketplaceCatalogueRepository,
  MarketplaceOfferCode,
} from "./marketplaceCatalogueRepository.js";

const ACTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const OFFER_DEFINITIONS = Object.freeze([
  Object.freeze({
    offerCode: "linkedin.posts" as const,
    providerName: "LinkedIn posts",
    evidenceFileName: "linkedin-posts.json",
  }),
  Object.freeze({
    offerCode: "linkedin.people.standard" as const,
    providerName: "LinkedIn people profiles",
    evidenceFileName: "linkedin-people-standard.json",
  }),
]);

export type MarketplaceCatalogueErrorCode =
  | "MARKETPLACE_CATALOGUE_CONFIGURATION_INVALID"
  | "MARKETPLACE_CATALOGUE_READ_CONFIRMATION_REQUIRED"
  | "MARKETPLACE_CATALOGUE_REQUIRED_OFFER_MISSING"
  | "MARKETPLACE_CATALOGUE_REQUIRED_OFFER_DUPLICATED"
  | "MARKETPLACE_CATALOGUE_PROVIDER_FAILURE"
  | "MARKETPLACE_CATALOGUE_STORAGE_FAILURE"
  | "MARKETPLACE_CATALOGUE_DATABASE_FAILURE"
  | "MARKETPLACE_CATALOGUE_INPUT_INVALID";

export class MarketplaceCatalogueError extends Error {
  public readonly code: MarketplaceCatalogueErrorCode;

  public constructor(code: MarketplaceCatalogueErrorCode, cause?: unknown) {
    super(
      "Marketplace catalogue operation failed",
      cause === undefined ? undefined : { cause },
    );
    this.name = "MarketplaceCatalogueError";
    this.code = code;
  }
}

interface Dependencies {
  readonly repository: MarketplaceCatalogueRepository;
  readonly evidenceStore: QualificationEvidenceStore;
  readonly client: MarketplaceDatasetCatalogueClient;
  readonly secretProvider: SecretProvider;
  readonly protector: ProviderReferenceProtector;
  readonly evidenceMaxBytes: number;
  readonly now?: () => Date;
  readonly uuid?: () => string;
}

export interface MarketplaceCatalogueService {
  importCatalogue(input: {
    readonly source: "fixture" | "provider";
    readonly confirmedReadOnlyRequest?: true;
    readonly environment: "local" | "test";
    readonly actor: string;
    readonly restrictedReference: string;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly importId: string;
    readonly candidateCount: number;
    readonly candidates: readonly {
      readonly candidateId: string;
      readonly offerCode: MarketplaceOfferCode;
      readonly providerName: string;
      readonly recordCount: number | null;
      readonly disposition: "created" | "existing";
    }[];
    readonly evidenceObjectKey: string;
    readonly evidenceChecksum: string;
  }>;
  reviewCandidate(input: {
    readonly candidateId: string;
    readonly decision: "approve" | "reject";
    readonly actor: string;
  }): ReturnType<MarketplaceCatalogueRepository["reviewCandidate"]>;
}

export async function reviewMarketplaceCatalogueCandidate(
  repository: MarketplaceCatalogueRepository,
  input: Parameters<MarketplaceCatalogueRepository["reviewCandidate"]>[0],
): ReturnType<MarketplaceCatalogueRepository["reviewCandidate"]> {
  if (!UUID_PATTERN.test(input.candidateId)) {
    throw new MarketplaceCatalogueError("MARKETPLACE_CATALOGUE_INPUT_INVALID");
  }
  validateActor(input.actor);
  if (input.decision !== "approve" && input.decision !== "reject") {
    throw new MarketplaceCatalogueError("MARKETPLACE_CATALOGUE_INPUT_INVALID");
  }
  return repository.reviewCandidate(input);
}

function validateActor(actor: string): void {
  if (!ACTOR_PATTERN.test(actor)) {
    throw new MarketplaceCatalogueError("MARKETPLACE_CATALOGUE_INPUT_INVALID");
  }
}

function validateReference(reference: string): void {
  if (reference.length < 8 || reference.length > 1024 || reference.trim() !== reference) {
    throw new MarketplaceCatalogueError("MARKETPLACE_CATALOGUE_INPUT_INVALID");
  }
}

function checksum(receipt: { readonly checksumHex: string }): Buffer {
  if (!/^[0-9a-f]{64}$/.test(receipt.checksumHex)) {
    throw new MarketplaceCatalogueError("MARKETPLACE_CATALOGUE_STORAGE_FAILURE");
  }
  return Buffer.from(receipt.checksumHex, "hex");
}

async function retainEvidence(
  store: QualificationEvidenceStore,
  input: Parameters<QualificationEvidenceStore["putImmutable"]>[0],
): Promise<QualificationEvidenceReceipt> {
  try {
    return await store.putImmutable(input);
  } catch (error) {
    throw new MarketplaceCatalogueError("MARKETPLACE_CATALOGUE_STORAGE_FAILURE", error);
  }
}

function catalogueEntryChecksum(dataset: MarketplaceDatasetListItem): Buffer {
  return createHash("sha256")
    .update(JSON.stringify({ id: dataset.id, name: dataset.name, size: dataset.size }))
    .digest();
}

function candidateContext(environment: "local" | "test", offerCode: MarketplaceOfferCode): Buffer {
  return Buffer.from(`dhumi:marketplace-catalogue:v1:${environment}:${offerCode}`, "utf8");
}

function requiredOffer(
  datasets: readonly MarketplaceDatasetListItem[],
  providerName: string,
): MarketplaceDatasetListItem {
  const expected = providerName.toLowerCase();
  const matches = datasets.filter((item) => item.name.toLowerCase() === expected);
  if (matches.length === 0) {
    throw new MarketplaceCatalogueError("MARKETPLACE_CATALOGUE_REQUIRED_OFFER_MISSING");
  }
  if (matches.length !== 1) {
    throw new MarketplaceCatalogueError("MARKETPLACE_CATALOGUE_REQUIRED_OFFER_DUPLICATED");
  }
  return matches[0] as MarketplaceDatasetListItem;
}

function safeFailure(error: unknown): MarketplaceCatalogueError {
  if (error instanceof MarketplaceCatalogueError) return error;
  if (error instanceof MarketplaceCatalogueBoundaryError) {
    return new MarketplaceCatalogueError("MARKETPLACE_CATALOGUE_PROVIDER_FAILURE", error);
  }
  return new MarketplaceCatalogueError("MARKETPLACE_CATALOGUE_DATABASE_FAILURE", error);
}

export function createMarketplaceCatalogueService(
  dependencies: Dependencies,
): MarketplaceCatalogueService {
  if (!Number.isSafeInteger(dependencies.evidenceMaxBytes) || dependencies.evidenceMaxBytes < 2) {
    throw new MarketplaceCatalogueError("MARKETPLACE_CATALOGUE_CONFIGURATION_INVALID");
  }
  const now = dependencies.now ?? (() => new Date());
  const uuid = dependencies.uuid ?? randomUUID;

  return Object.freeze({
    async importCatalogue(input: Parameters<MarketplaceCatalogueService["importCatalogue"]>[0]) {
      if (input.source === "provider" && input.confirmedReadOnlyRequest !== true) {
        throw new MarketplaceCatalogueError(
          "MARKETPLACE_CATALOGUE_READ_CONFIRMATION_REQUIRED",
        );
      }
      validateActor(input.actor);
      validateReference(input.restrictedReference);
      const importId = uuid();
      await dependencies.repository.beginImport({
        importId,
        environment: input.environment,
        actor: input.actor,
        restrictedReference: input.restrictedReference,
      });
      try {
        const apiKey = input.source === "provider"
          ? await dependencies.secretProvider.getSecret("BRIGHTDATA_API_KEY")
          : "fixture-source-no-provider-call";
        const listDocument = await dependencies.client.listDatasets({
          apiKey,
          signal: input.signal,
        });
        const listObjectKey = `qualification/catalog-imports/${importId}/marketplace-dataset-list.json`;
        const listReceipt = await retainEvidence(dependencies.evidenceStore, {
          objectKey: listObjectKey,
          bytes: listDocument.bytes,
          contentType: listDocument.contentType,
          maxBytes: dependencies.evidenceMaxBytes,
        });
        const observedAt = now();
        if (Number.isNaN(observedAt.valueOf())) {
          throw new MarketplaceCatalogueError("MARKETPLACE_CATALOGUE_CONFIGURATION_INVALID");
        }
        const candidates = [];
        const safeCandidates = [];
        for (const definition of OFFER_DEFINITIONS) {
          const dataset = requiredOffer(listDocument.value, definition.providerName);
          const candidateId = uuid();
          const metadataDocument = await dependencies.client.getDatasetMetadata({
            apiKey,
            datasetId: dataset.id,
            signal: input.signal,
          });
          const metadataObjectKey =
            `qualification/catalog-imports/${importId}/metadata/${definition.evidenceFileName}`;
          const metadataReceipt = await retainEvidence(dependencies.evidenceStore, {
            objectKey: metadataObjectKey,
            bytes: metadataDocument.bytes,
            contentType: metadataDocument.contentType,
            maxBytes: dependencies.evidenceMaxBytes,
          });
          const protectedReference = await dependencies.protector.protect(
            dataset.id,
            candidateContext(input.environment, definition.offerCode),
          );
          candidates.push({
            id: candidateId,
            offerCode: definition.offerCode,
            providerName: dataset.name,
            recordCount: dataset.size,
            catalogueEntryChecksum: catalogueEntryChecksum(dataset),
            ciphertext: protectedReference.ciphertext,
            fingerprint: protectedReference.fingerprint,
            metadataObjectKey,
            metadataChecksum: checksum(metadataReceipt),
            metadataObservedAt: observedAt,
          });
          safeCandidates.push({
            generatedCandidateId: candidateId,
            offerCode: definition.offerCode,
            providerName: dataset.name,
            recordCount: dataset.size,
          });
        }
        const recorded = await dependencies.repository.completeImport({
          importId,
          candidates,
          evidenceObjectKey: listObjectKey,
          evidenceChecksum: checksum(listReceipt),
          actor: input.actor,
        });
        const byOffer = new Map(recorded.map((item) => [item.offerCode, item]));
        const responseCandidates = safeCandidates.map((candidate) => {
          const result = byOffer.get(candidate.offerCode);
          if (result === undefined) {
            throw new MarketplaceCatalogueError("MARKETPLACE_CATALOGUE_DATABASE_FAILURE");
          }
          return Object.freeze({
            candidateId: result.candidateId,
            offerCode: candidate.offerCode,
            providerName: candidate.providerName,
            recordCount: candidate.recordCount,
            disposition: result.disposition,
          });
        });
        return Object.freeze({
          importId,
          candidateCount: responseCandidates.length,
          candidates: Object.freeze(responseCandidates),
          evidenceObjectKey: listObjectKey,
          evidenceChecksum: listReceipt.checksumHex,
        });
      } catch (error) {
        const failure = safeFailure(error);
        try {
          await dependencies.repository.failImport({
            importId,
            safeErrorCode: failure.code,
            actor: input.actor,
          });
        } catch (recordError) {
          throw new AggregateError(
            [failure, recordError],
            "Marketplace import and failure recording failed",
          );
        }
        throw failure;
      }
    },

    async reviewCandidate(input: Parameters<MarketplaceCatalogueService["reviewCandidate"]>[0]) {
      return reviewMarketplaceCatalogueCandidate(dependencies.repository, input);
    },
  });
}
