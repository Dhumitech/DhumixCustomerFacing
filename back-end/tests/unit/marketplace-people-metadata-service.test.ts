import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MarketplaceDatasetCatalogueClient } from
  "../../src/services/brightdata/marketplace/marketplaceDatasetCatalogueClient.js";
import type { ProviderReferenceProtector } from
  "../../src/services/brightdata/providerReferenceProtector.js";
import type { MarketplacePeopleMetadataRepository } from
  "../../src/services/marketplacePeople/marketplacePeopleMetadataRepository.js";
import { createMarketplacePeopleMetadataService } from
  "../../src/services/marketplacePeople/marketplacePeopleMetadataService.js";

const candidateId = "f60af142-3f00-4b0f-b159-86b41ff74b7f";
const observationId = "8a000000-0000-4000-8000-000000000001";
const metadataBytes = Buffer.from(JSON.stringify({
  id: "gd_l1viktl72bvl7bjuj0",
  fields: {
    url: { type: "url", active: true, required: true },
    name: { type: "text", active: true },
  },
}));

function dependencies() {
  const repository: MarketplacePeopleMetadataRepository = {
    resolveApprovedCandidate: vi.fn(async () => ({
      candidateId,
      environment: "local" as const,
      resourceCode: "linkedin.people.standard" as const,
      ciphertext: Buffer.alloc(40, 1),
      fingerprint: Buffer.alloc(32, 2),
    })),
    recordObservation: vi.fn(async (
      input: Parameters<MarketplacePeopleMetadataRepository["recordObservation"]>[0],
    ) => ({
      observationId: input.observationId,
      candidateId: input.candidateId,
      fieldCount: input.fieldCount,
      byteCount: input.byteCount,
      checksum: input.checksum,
      observedAt: new Date("2026-09-13T12:00:00.000Z"),
      disposition: "created" as const,
    })),
  };
  const client: MarketplaceDatasetCatalogueClient = {
    listDatasets: vi.fn(async () => {
      throw new Error("dataset list must not be called");
    }),
    getDatasetMetadata: vi.fn(async () => ({
      value: {
        id: "gd_l1viktl72bvl7bjuj0",
        fields: {
          url: { type: "url", active: true, required: true },
          name: { type: "text", active: true },
        },
      },
      bytes: metadataBytes,
      contentType: "application/json" as const,
    })),
  };
  const protector: ProviderReferenceProtector = {
    protect: vi.fn(),
    reveal: vi.fn(async () => "gd_l1viktl72bvl7bjuj0"),
  };
  const evidenceStore = {
    putImmutable: vi.fn(async (input: { objectKey: string; bytes: Buffer; contentType: string }) => ({
      objectKey: input.objectKey,
      checksumHex: createHash("sha256").update(input.bytes).digest("hex"),
      byteCount: input.bytes.byteLength,
      contentType: input.contentType,
      eTag: "etag",
    })),
  };
  const secretProvider = {
    getSecret: vi.fn(async () => "provider-secret-value"),
  };
  return { repository, client, protector, evidenceStore, secretProvider };
}

describe("LinkedIn People metadata evidence service", () => {
  it("performs exactly one read-only metadata GET and records immutable private evidence", async () => {
    const deps = dependencies();
    const service = createMarketplacePeopleMetadataService({
      ...deps,
      evidenceMaxBytes: 1_000_000,
      uuid: () => observationId,
    });

    const result = await service.capture({
      candidateId,
      actor: "marketplace.people.metadata.local",
      restrictedReference: "checkpoint://dataset-market/linkedin-people/metadata-v1",
      confirmedReadOnlyRequest: true,
      signal: new AbortController().signal,
    });

    expect(deps.client.listDatasets).not.toHaveBeenCalled();
    expect(deps.client.getDatasetMetadata).toHaveBeenCalledTimes(1);
    expect(deps.client.getDatasetMetadata).toHaveBeenCalledWith(expect.objectContaining({
      datasetId: "gd_l1viktl72bvl7bjuj0",
    }));
    expect(deps.protector.reveal).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.any(Buffer),
      Buffer.from("dhumi:marketplace-catalogue:v1:local:linkedin.people.standard"),
    );
    expect(deps.evidenceStore.putImmutable).toHaveBeenCalledWith(expect.objectContaining({
      objectKey:
        `qualification/catalog-imports/${observationId}/metadata/linkedin-people-standard.json`,
      bytes: metadataBytes,
      contentType: "application/json",
    }));
    expect(deps.repository.recordObservation).toHaveBeenCalledWith(expect.objectContaining({
      observationId,
      candidateId,
      fieldCount: 2,
      byteCount: metadataBytes.byteLength,
      restrictedReference: "checkpoint://dataset-market/linkedin-people/metadata-v1",
    }));
    expect(JSON.stringify(result)).not.toContain("gd_l1viktl72bvl7bjuj0");
    expect(JSON.stringify(result)).not.toContain("qualification/catalog-imports");
  });

  it("fails closed when read-only provider confirmation is absent", async () => {
    const deps = dependencies();
    const service = createMarketplacePeopleMetadataService({
      ...deps,
      evidenceMaxBytes: 1_000_000,
      uuid: () => observationId,
    });

    await expect(service.capture({
      candidateId,
      actor: "marketplace.people.metadata.local",
      restrictedReference: "checkpoint://dataset-market/linkedin-people/metadata-v1",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "MARKETPLACE_PEOPLE_METADATA_CONFIRMATION_REQUIRED" });
    expect(deps.client.getDatasetMetadata).not.toHaveBeenCalled();
    expect(deps.evidenceStore.putImmutable).not.toHaveBeenCalled();
    expect(deps.repository.recordObservation).not.toHaveBeenCalled();
  });
});
