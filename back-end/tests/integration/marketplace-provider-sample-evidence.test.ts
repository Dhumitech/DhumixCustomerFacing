import { randomUUID } from "node:crypto";
import { BlobServiceClient } from "@azure/storage-blob";
import { describe, expect, it, vi } from "vitest";
import type { ProviderReferenceProtector } from
  "../../src/services/brightdata/providerReferenceProtector.js";
import { createMarketplaceProviderSampleService } from
  "../../src/services/marketplaceSample/marketplaceProviderSampleService.js";
import type { MarketplaceProviderSampleRepository } from
  "../../src/services/marketplaceSample/marketplaceSampleRepository.js";
import type { MarketplaceSampleStore } from
  "../../src/services/marketplaceSample/marketplaceSampleStore.js";
import { createQualificationEvidenceReader } from
  "../../src/services/qualification/qualificationEvidenceReader.js";

const enabled = process.env.RUN_AZURITE_INTEGRATION_TESTS === "true";
const connectionString = process.env.RESULT_STORAGE_CONNECTION_STRING;
const containerName = process.env.RESULT_STORAGE_CONTAINER;
const packetId = "2e1560c3-ca8b-40a0-b578-c9e71ecf27cd";
const rawChecksum = "d5a9c6c3403959349925d0574195e12e511ab2e861d421938e53b4a6738f6c95";
const metadataChecksum = "039685f485ab09f0a6f9503517a2aa34957920c0f2faf827684c0b600512499b";

describe.skipIf(!enabled)("LinkedIn Posts provider sample against retained evidence", () => {
  it("validates all five exact records against the exact 37-field metadata without writing", async () => {
    if (connectionString === undefined || containerName === undefined) {
      throw new Error("Azurite evidence configuration is missing");
    }
    const container = BlobServiceClient.fromConnectionString(connectionString)
      .getContainerClient(containerName);
    const qualificationStore = createQualificationEvidenceReader(container);
    const templateVersionId = randomUUID();
    const completedAt = new Date("2026-09-13T06:00:00.000Z");
    let recordedDictionary: readonly Readonly<Record<string, unknown>>[] = [];
    const repository: MarketplaceProviderSampleRepository = {
      resolveQualifiedSource: vi.fn(async () => ({
        packetId,
        templateVersionId,
        templateSlug: "linkedin-posts" as const,
        templateVersion: 1,
        environment: "local" as const,
        providerResourceCiphertext: Buffer.alloc(30, 1),
        providerResourceFingerprint: Buffer.alloc(32, 2),
        rawObjectKey: `qualification/operations/${packetId}/raw.json`,
        rawContentType: "application/json" as const,
        rawRecordCount: 5,
        rawByteCount: 25_858,
        rawChecksum: Buffer.from(rawChecksum, "hex"),
        completedAt,
      })),
      recordProviderSample: vi.fn(async (input) => {
        recordedDictionary = input.fieldDictionary;
        return {
          sampleId: input.sampleId,
          disposition: "created" as const,
          collectedAt: completedAt,
          expiresAt: new Date(completedAt.valueOf() + 30 * 24 * 60 * 60 * 1000),
        };
      }),
    };
    const sampleStore: MarketplaceSampleStore = {
      putImmutable: vi.fn(async (input) => ({
        objectKey: input.objectKey,
        contentType: input.contentType,
        byteCount: input.bytes.byteLength,
        checksumHex: rawChecksum,
        eTag: "read-only-proof",
      })),
      open: vi.fn(async () => { throw new Error("not used"); }),
      deleteAndVerify: vi.fn(async () => ({ disposition: "deleted" as const })),
    };
    const protector: ProviderReferenceProtector = {
      protect: vi.fn(async () => { throw new Error("not used"); }),
      reveal: vi.fn(async () => "gd_lyy3tktm25m4avu764"),
    };
    const service = createMarketplaceProviderSampleService({
      repository,
      qualificationStore,
      sampleStore,
      protector,
      maxBytes: Number(process.env.RESULT_MAX_BYTES ?? 20_000_000),
    });

    const result = await service.promote({
      packetId,
      sampleVersion: 2,
      actor: "marketplace.provider-sample.evidence-proof",
    });

    expect(result).toMatchObject({
      record_count: 5,
      byte_count: 25_858,
      checksum: rawChecksum,
      metadata_checksum: metadataChecksum,
      field_count: 37,
      masked_field_count: 11,
      provider_calls: 0,
    });
    expect(recordedDictionary).toHaveLength(37);
    expect(recordedDictionary.filter((field) => field.sample_visibility === "masked"))
      .toHaveLength(11);
    expect(sampleStore.putImmutable).toHaveBeenCalledOnce();
    expect(repository.recordProviderSample).toHaveBeenCalledOnce();
  });
});
