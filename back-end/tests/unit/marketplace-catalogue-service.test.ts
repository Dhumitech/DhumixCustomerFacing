import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { ProviderReferenceProtector } from "../../src/services/brightdata/providerReferenceProtector.js";
import {
  createFixtureMarketplaceDatasetCatalogueClient,
} from "../../src/services/brightdata/marketplace/marketplaceDatasetCatalogueClient.js";
import type { SecretProvider } from "../../src/services/secrets/secretProvider.js";
import type {
  MarketplaceCatalogueRepository,
  MarketplaceImportCandidate,
} from "../../src/services/marketplaceCatalogue/marketplaceCatalogueRepository.js";
import {
  MarketplaceCatalogueError,
  createMarketplaceCatalogueService,
} from "../../src/services/marketplaceCatalogue/marketplaceCatalogueService.js";
import type {
  QualificationEvidenceStore,
} from "../../src/services/qualification/qualificationEvidenceStore.js";

const fixtureRoot = new URL("../fixtures/marketplace-catalogue/", import.meta.url);

async function fixtureClient() {
  return createFixtureMarketplaceDatasetCatalogueClient({
    listBytes: await readFile(new URL("dataset-list.json", fixtureRoot)),
    metadataBytesByDatasetName: new Map([
      ["linkedin posts", await readFile(new URL("linkedin-posts-metadata.json", fixtureRoot))],
      ["linkedin people profiles", await readFile(new URL("linkedin-people-metadata.json", fixtureRoot))],
    ]),
  });
}

function receipt(objectKey: string, bytes: Buffer) {
  return {
    objectKey,
    checksumHex: createHash("sha256").update(bytes).digest("hex"),
    byteCount: bytes.byteLength,
    contentType: "application/json",
    eTag: "fixture-etag",
  };
}

function dependencies() {
  const repository: MarketplaceCatalogueRepository = {
    beginImport: vi.fn(async () => undefined),
    completeImport: vi.fn(async (
      input: Parameters<MarketplaceCatalogueRepository["completeImport"]>[0],
    ) => input.candidates.map((candidate: MarketplaceImportCandidate) => ({
      candidateId: candidate.id,
      offerCode: candidate.offerCode,
      disposition: "created" as const,
    }))),
    failImport: vi.fn(async () => undefined),
    reviewCandidate: vi.fn(async () => ({
      candidateId: "75000000-0000-4000-8000-000000000001",
      reviewState: "approved" as const,
      templateSlug: "linkedin-posts",
      templateVersion: 1,
    })),
  };
  const evidenceStore: QualificationEvidenceStore = {
    putImmutable: vi.fn(async (input) => receipt(input.objectKey, input.bytes)),
  };
  const protector: ProviderReferenceProtector = {
    protect: vi.fn(async (plaintext, context) => ({
      ciphertext: Buffer.from(`protected:${plaintext}`),
      fingerprint: createHash("sha256").update(context).update(plaintext).digest(),
    })),
    reveal: vi.fn(async () => "never-used"),
  };
  const secretProvider: SecretProvider = {
    getSecret: vi.fn(async () => "provider-secret-never-returned"),
  };
  return { repository, evidenceStore, protector, secretProvider };
}

describe("Marketplace catalogue import service", () => {
  it("imports only LinkedIn Posts and standard People from evidence-backed fixtures", async () => {
    const deps = dependencies();
    const service = createMarketplaceCatalogueService({
      ...deps,
      client: await fixtureClient(),
      evidenceMaxBytes: 1024 * 1024,
      now: () => new Date("2026-09-11T10:00:00.000Z"),
      uuid: (() => {
        const values = [
          "75000000-0000-4000-8000-000000000000",
          "75000000-0000-4000-8000-000000000001",
          "75000000-0000-4000-8000-000000000002",
        ];
        return () => values.shift() as string;
      })(),
    });

    const result = await service.importCatalogue({
      source: "fixture",
      environment: "test",
      actor: "m2.fixture.test",
      restrictedReference: "checkpoint://dataset-market/m2/fixture",
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      importId: "75000000-0000-4000-8000-000000000000",
      candidateCount: 2,
      candidates: [
        { offerCode: "linkedin.posts", providerName: "LinkedIn posts" },
        { offerCode: "linkedin.people.standard", providerName: "LinkedIn people profiles" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("gd_");
    expect(deps.secretProvider.getSecret).not.toHaveBeenCalled();
    expect(deps.repository.completeImport).toHaveBeenCalledOnce();
    const completed = vi.mocked(deps.repository.completeImport).mock.calls[0]?.[0];
    expect(completed?.candidates).toHaveLength(2);
    expect(completed?.candidates.map((candidate) => candidate.offerCode)).toEqual([
      "linkedin.posts",
      "linkedin.people.standard",
    ]);
    expect(completed?.candidates.every((candidate) => candidate.metadataChecksum.length === 32)).toBe(true);
    expect(deps.evidenceStore.putImmutable).toHaveBeenCalledTimes(3);
  });

  it("requires explicit confirmation before any provider read", async () => {
    const deps = dependencies();
    const fixture = await fixtureClient();
    const list = vi.fn(fixture.listDatasets);
    const client = {
      listDatasets: list,
      getDatasetMetadata: vi.fn(fixture.getDatasetMetadata),
    };
    const service = createMarketplaceCatalogueService({
      ...deps,
      client,
      evidenceMaxBytes: 1024 * 1024,
    });

    await expect(service.importCatalogue({
      source: "provider",
      environment: "local",
      actor: "m2.live.test",
      restrictedReference: "checkpoint://dataset-market/m2/live",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "MARKETPLACE_CATALOGUE_READ_CONFIRMATION_REQUIRED" });
    expect(list).not.toHaveBeenCalled();
    expect(deps.secretProvider.getSecret).not.toHaveBeenCalled();
    expect(deps.repository.beginImport).not.toHaveBeenCalled();
  });

  it("performs exactly one list and two metadata reads after provider confirmation", async () => {
    const deps = dependencies();
    const fixture = await fixtureClient();
    const listDatasets = vi.fn(fixture.listDatasets);
    const getDatasetMetadata = vi.fn(fixture.getDatasetMetadata);
    const service = createMarketplaceCatalogueService({
      ...deps,
      client: { listDatasets, getDatasetMetadata },
      evidenceMaxBytes: 1024 * 1024,
    });

    const result = await service.importCatalogue({
      source: "provider",
      confirmedReadOnlyRequest: true,
      environment: "test",
      actor: "m2.provider.test",
      restrictedReference: "checkpoint://dataset-market/m2/provider-read",
      signal: new AbortController().signal,
    });

    expect(listDatasets).toHaveBeenCalledOnce();
    expect(getDatasetMetadata).toHaveBeenCalledTimes(2);
    expect(deps.secretProvider.getSecret).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("gd_");
    const completed = vi.mocked(deps.repository.completeImport).mock.calls[0]?.[0];
    expect(completed?.candidates.every(
      (candidate) => candidate.catalogueEntryChecksum.byteLength === 32,
    )).toBe(true);
  });

  it("fails closed when an accepted LinkedIn offer is missing or duplicated", async () => {
    const base = dependencies();
    for (const listBytes of [
      Buffer.from(JSON.stringify([{ id: "gd_lyy3tktm25m4avu764", name: "LinkedIn posts", size: 1 }])),
      Buffer.from(JSON.stringify([
        { id: "gd_lyy3tktm25m4avu764", name: "LinkedIn posts", size: 1 },
        { id: "gd_aaaaaaaaaaaaaaaa", name: "LinkedIn posts", size: 1 },
        { id: "gd_l1viktl72bvl7bjuj0", name: "LinkedIn people profiles", size: 1 },
      ])),
    ]) {
      const client = createFixtureMarketplaceDatasetCatalogueClient({
        listBytes,
        metadataBytesByDatasetName: new Map(),
      });
      const service = createMarketplaceCatalogueService({
        ...base,
        client,
        evidenceMaxBytes: 1024 * 1024,
      });
      await expect(service.importCatalogue({
        source: "fixture",
        environment: "test",
        actor: "m2.fixture.test",
        restrictedReference: "checkpoint://dataset-market/m2/fixture",
        signal: new AbortController().signal,
      })).rejects.toBeInstanceOf(MarketplaceCatalogueError);
    }
  });

  it("records an import failure using only a safe error code", async () => {
    const deps = dependencies();
    const service = createMarketplaceCatalogueService({
      ...deps,
      client: createFixtureMarketplaceDatasetCatalogueClient({
        listBytes: Buffer.from("[]"),
        metadataBytesByDatasetName: new Map(),
      }),
      evidenceMaxBytes: 1024 * 1024,
      uuid: () => "75000000-0000-4000-8000-000000000000",
    });

    await expect(service.importCatalogue({
      source: "fixture",
      environment: "test",
      actor: "m2.fixture.test",
      restrictedReference: "checkpoint://dataset-market/m2/fixture",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "MARKETPLACE_CATALOGUE_REQUIRED_OFFER_MISSING" });
    expect(deps.repository.failImport).toHaveBeenCalledWith({
      importId: "75000000-0000-4000-8000-000000000000",
      safeErrorCode: "MARKETPLACE_CATALOGUE_REQUIRED_OFFER_MISSING",
      actor: "m2.fixture.test",
    });
  });

  it("classifies immutable evidence-store failures separately from database failures", async () => {
    const deps = dependencies();
    vi.mocked(deps.evidenceStore.putImmutable).mockRejectedValueOnce(
      new Error("private storage detail"),
    );
    const service = createMarketplaceCatalogueService({
      ...deps,
      client: await fixtureClient(),
      evidenceMaxBytes: 1024 * 1024,
      uuid: () => "75000000-0000-4000-8000-000000000000",
    });

    await expect(service.importCatalogue({
      source: "fixture",
      environment: "test",
      actor: "m2.fixture.test",
      restrictedReference: "checkpoint://dataset-market/m2/fixture",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "MARKETPLACE_CATALOGUE_STORAGE_FAILURE" });
    expect(deps.repository.failImport).toHaveBeenCalledWith({
      importId: "75000000-0000-4000-8000-000000000000",
      safeErrorCode: "MARKETPLACE_CATALOGUE_STORAGE_FAILURE",
      actor: "m2.fixture.test",
    });
  });
});
