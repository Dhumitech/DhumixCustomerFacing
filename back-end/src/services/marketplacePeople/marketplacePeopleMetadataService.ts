import { randomUUID } from "node:crypto";
import type { MarketplaceDatasetCatalogueClient } from
  "../brightdata/marketplace/marketplaceDatasetCatalogueClient.js";
import { MarketplaceCatalogueBoundaryError } from
  "../brightdata/marketplace/marketplaceDatasetCatalogueClient.js";
import type { ProviderReferenceProtector } from
  "../brightdata/providerReferenceProtector.js";
import type { QualificationEvidenceStore } from
  "../qualification/qualificationEvidenceStore.js";
import type { SecretProvider } from "../secrets/secretProvider.js";
import type { MarketplacePeopleMetadataRepository } from
  "./marketplacePeopleMetadataRepository.js";

const ACTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type MarketplacePeopleMetadataErrorCode =
  | "MARKETPLACE_PEOPLE_METADATA_CONFIGURATION_INVALID"
  | "MARKETPLACE_PEOPLE_METADATA_CONFIRMATION_REQUIRED"
  | "MARKETPLACE_PEOPLE_METADATA_INPUT_INVALID"
  | "MARKETPLACE_PEOPLE_METADATA_PROVIDER_FAILURE"
  | "MARKETPLACE_PEOPLE_METADATA_STORAGE_FAILURE"
  | "MARKETPLACE_PEOPLE_METADATA_DATABASE_FAILURE";

export class MarketplacePeopleMetadataError extends Error {
  public constructor(public readonly code: MarketplacePeopleMetadataErrorCode, cause?: unknown) {
    super("LinkedIn People metadata capture failed", cause === undefined ? undefined : { cause });
    this.name = "MarketplacePeopleMetadataError";
  }
}

interface Dependencies {
  readonly repository: MarketplacePeopleMetadataRepository;
  readonly evidenceStore: QualificationEvidenceStore;
  readonly client: MarketplaceDatasetCatalogueClient;
  readonly secretProvider: SecretProvider;
  readonly protector: ProviderReferenceProtector;
  readonly evidenceMaxBytes: number;
  readonly uuid?: () => string;
}

function context(environment: "local" | "test"): Buffer {
  return Buffer.from(
    `dhumi:marketplace-catalogue:v1:${environment}:linkedin.people.standard`,
    "utf8",
  );
}

function validateInput(input: {
  readonly candidateId: string;
  readonly actor: string;
  readonly restrictedReference: string;
}): void {
  if (
    !UUID_PATTERN.test(input.candidateId) ||
    !ACTOR_PATTERN.test(input.actor) ||
    input.restrictedReference.trim() !== input.restrictedReference ||
    input.restrictedReference.length < 8 ||
    input.restrictedReference.length > 1024
  ) {
    throw new MarketplacePeopleMetadataError("MARKETPLACE_PEOPLE_METADATA_INPUT_INVALID");
  }
}

function failure(error: unknown): MarketplacePeopleMetadataError {
  if (error instanceof MarketplacePeopleMetadataError) return error;
  if (error instanceof MarketplaceCatalogueBoundaryError) {
    return new MarketplacePeopleMetadataError(
      "MARKETPLACE_PEOPLE_METADATA_PROVIDER_FAILURE",
      error,
    );
  }
  return new MarketplacePeopleMetadataError("MARKETPLACE_PEOPLE_METADATA_DATABASE_FAILURE", error);
}

export function createMarketplacePeopleMetadataService(dependencies: Dependencies) {
  if (!Number.isSafeInteger(dependencies.evidenceMaxBytes) || dependencies.evidenceMaxBytes < 2) {
    throw new MarketplacePeopleMetadataError(
      "MARKETPLACE_PEOPLE_METADATA_CONFIGURATION_INVALID",
    );
  }
  const uuid = dependencies.uuid ?? randomUUID;
  return Object.freeze({
    async capture(input: {
      readonly candidateId: string;
      readonly actor: string;
      readonly restrictedReference: string;
      readonly confirmedReadOnlyRequest?: true;
      readonly signal: AbortSignal;
    }) {
      if (input.confirmedReadOnlyRequest !== true) {
        throw new MarketplacePeopleMetadataError(
          "MARKETPLACE_PEOPLE_METADATA_CONFIRMATION_REQUIRED",
        );
      }
      validateInput(input);
      try {
        const candidate = await dependencies.repository.resolveApprovedCandidate(
          input.candidateId,
        );
        const datasetId = await dependencies.protector.reveal(
          candidate.ciphertext,
          candidate.fingerprint,
          context(candidate.environment),
        );
        const apiKey = await dependencies.secretProvider.getSecret("BRIGHTDATA_API_KEY");
        const document = await dependencies.client.getDatasetMetadata({
          apiKey,
          datasetId,
          signal: input.signal,
        });
        const observationId = uuid();
        if (!UUID_PATTERN.test(observationId)) {
          throw new MarketplacePeopleMetadataError(
            "MARKETPLACE_PEOPLE_METADATA_CONFIGURATION_INVALID",
          );
        }
        const evidenceObjectKey =
          `qualification/catalog-imports/${observationId}/metadata/linkedin-people-standard.json`;
        let receipt;
        try {
          receipt = await dependencies.evidenceStore.putImmutable({
            objectKey: evidenceObjectKey,
            bytes: document.bytes,
            contentType: document.contentType,
            maxBytes: dependencies.evidenceMaxBytes,
          });
        } catch (error) {
          throw new MarketplacePeopleMetadataError(
            "MARKETPLACE_PEOPLE_METADATA_STORAGE_FAILURE",
            error,
          );
        }
        if (!/^[0-9a-f]{64}$/.test(receipt.checksumHex)) {
          throw new MarketplacePeopleMetadataError(
            "MARKETPLACE_PEOPLE_METADATA_STORAGE_FAILURE",
          );
        }
        const recorded = await dependencies.repository.recordObservation({
          observationId,
          candidateId: candidate.candidateId,
          evidenceObjectKey,
          checksum: Buffer.from(receipt.checksumHex, "hex"),
          byteCount: receipt.byteCount,
          fieldCount: Object.keys(document.value.fields).length,
          contentType: "application/json",
          restrictedReference: input.restrictedReference,
          actor: input.actor,
        });
        return Object.freeze({
          observationId: recorded.observationId,
          candidateId: recorded.candidateId,
          fieldCount: recorded.fieldCount,
          byteCount: recorded.byteCount,
          checksum: recorded.checksum.toString("hex"),
          observedAt: recorded.observedAt.toISOString(),
          disposition: recorded.disposition,
          providerCalls: 1,
          providerMethod: "GET" as const,
        });
      } catch (error) {
        throw failure(error);
      }
    },
  });
}
