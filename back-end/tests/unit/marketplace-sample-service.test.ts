import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type {
  MarketplaceSampleRepository,
} from "../../src/services/marketplaceSample/marketplaceSampleRepository.js";
import {
  LINKEDIN_POSTS_SAMPLE_MASKING_POLICY_VERSION,
  MarketplaceSampleError,
  createMarketplaceSampleService,
} from "../../src/services/marketplaceSample/marketplaceSampleService.js";
import type {
  MarketplaceSampleStore,
} from "../../src/services/marketplaceSample/marketplaceSampleStore.js";

const catalogueFixtures = new URL("../fixtures/marketplace-catalogue/", import.meta.url);
const sampleFixtures = new URL("../fixtures/marketplace-samples/", import.meta.url);

async function fixtureBytes() {
  return {
    metadataBytes: await readFile(new URL("linkedin-posts-metadata.json", catalogueFixtures)),
    sampleBytes: await readFile(new URL("linkedin-posts-v1.json", sampleFixtures)),
  };
}

function dependencies(metadataChecksum: Buffer) {
  const sampleChecksum = createHash("sha256")
    .update(Buffer.from('[{"url":"https://www.linkedin.com/posts/synthetic","text":"***"}]'))
    .digest();
  const repository: MarketplaceSampleRepository = {
    resolveTarget: vi.fn(async () => ({
      templateVersionId: "76000000-0000-4000-8000-000000000001",
      templateSlug: "linkedin-posts" as const,
      templateVersion: 1,
      metadataChecksum,
    })),
    recordFixture: vi.fn(async (input) => ({
      sampleId: input.sampleId,
      disposition: "created" as const,
    })),
    resolveFixture: vi.fn(async () => ({
      sampleId: "76000000-0000-4000-8000-000000000002",
      objectKey:
        `marketplace/samples/76000000-0000-4000-8000-000000000001/1/${sampleChecksum.toString("hex")}.json`,
      contentType: "application/json" as const,
      recordCount: 1,
      byteCount: 70,
      checksum: sampleChecksum,
      metadataChecksum,
      schemaVersion: 1,
      maskingPolicyVersion: "linkedin-posts-provider-mask-preservation-v1",
      retentionPolicyVersion: "linkedin-posts-sample-30d-v1",
      provenanceEvidenceReference: "fixture://marketplace-samples/linkedin-posts-v1",
      collectedAt: new Date("2026-09-11T09:00:00.000Z"),
      expiresAt: new Date("2026-10-11T09:00:00.000Z"),
    })),
    listExpiredFixtures: vi.fn(async () => []),
    recordFixtureDeletion: vi.fn(async (input) => ({
      sampleId: input.sampleId,
      disposition: "created" as const,
    })),
  };
  const retained = new Map<string, Buffer>();
  const store: MarketplaceSampleStore = {
    putImmutable: vi.fn(async (input) => {
      retained.set(input.objectKey, Buffer.from(input.bytes));
      return {
        objectKey: input.objectKey,
        contentType: input.contentType,
        byteCount: input.bytes.byteLength,
        checksumHex: createHash("sha256").update(input.bytes).digest("hex"),
        eTag: "fixture-etag",
      };
    }),
    open: vi.fn(async (objectKey) => ({
      receipt: {
        objectKey,
        contentType: "application/json",
        byteCount: retained.get(objectKey)?.byteLength ?? 0,
        checksumHex: createHash("sha256").update(retained.get(objectKey) ?? Buffer.alloc(0)).digest("hex"),
        eTag: "fixture-etag",
      },
      bytes: Buffer.from(retained.get(objectKey) ?? Buffer.alloc(0)),
    })),
    deleteAndVerify: vi.fn(async () => ({ disposition: "deleted" as const })),
  };
  return { repository, store };
}

function input(bytes: Awaited<ReturnType<typeof fixtureBytes>>) {
  return {
    templateSlug: "linkedin-posts" as const,
    templateVersion: 1,
    sampleVersion: 1,
    sampleBytes: bytes.sampleBytes,
    metadataBytes: bytes.metadataBytes,
    collectedAt: new Date("2026-09-11T09:00:00.000Z"),
    expiresAt: new Date("2026-10-11T09:00:00.000Z"),
    schemaVersion: 1,
    maskingPolicyVersion: LINKEDIN_POSTS_SAMPLE_MASKING_POLICY_VERSION,
    retentionPolicyVersion: "linkedin-posts-sample-30d-v1",
    provenanceEvidenceReference: "fixture://marketplace-samples/linkedin-posts-v1",
    actor: "m3.fixture.test",
  };
}

describe("M3 Marketplace fixture sample ingestion", () => {
  it("validates, stores, reads back, and records one immutable LinkedIn Posts fixture", async () => {
    const bytes = await fixtureBytes();
    const deps = dependencies(createHash("sha256").update(bytes.metadataBytes).digest());
    const service = createMarketplaceSampleService({
      ...deps,
      maxBytes: 1024 * 1024,
      uuid: () => "76000000-0000-4000-8000-000000000002",
    });

    const result = await service.ingestFixture(input(bytes));

    expect(result).toEqual({
      sampleId: "76000000-0000-4000-8000-000000000002",
      templateSlug: "linkedin-posts",
      templateVersion: 1,
      sampleVersion: 1,
      state: "validated_fixture",
      recordCount: 2,
      byteCount: bytes.sampleBytes.byteLength,
      checksum: createHash("sha256").update(bytes.sampleBytes).digest("hex"),
      expiresAt: "2026-10-11T09:00:00.000Z",
      disposition: "created",
    });
    expect(JSON.stringify(result)).not.toContain("objectKey");
    expect(JSON.stringify(result)).not.toContain("gd_");
    expect(deps.store.putImmutable).toHaveBeenCalledOnce();
    expect(deps.store.open).toHaveBeenCalledOnce();
    expect(deps.repository.recordFixture).toHaveBeenCalledWith(expect.objectContaining({
      sampleId: "76000000-0000-4000-8000-000000000002",
      templateVersionId: "76000000-0000-4000-8000-000000000001",
      sampleVersion: 1,
      recordCount: 2,
      rightsEvidenceReference: null,
      publishedAt: null,
      sourceKind: "synthetic_fixture",
      state: "validated_fixture",
    }));
  });

  it.each([
    ["missing required URL", [{ text: "synthetic" }]],
    ["unknown field", [{ url: "https://www.linkedin.com/posts/synthetic", author: "blocked" }]],
    ["invalid URL scheme", [{ url: "file:///private/path", text: "blocked" }]],
    ["invalid text type", [{ url: "https://www.linkedin.com/posts/synthetic", text: 7 }]],
  ])("rejects %s before storage", async (_label, records) => {
    const bytes = await fixtureBytes();
    const deps = dependencies(createHash("sha256").update(bytes.metadataBytes).digest());
    const service = createMarketplaceSampleService({ ...deps, maxBytes: 1024 * 1024 });

    await expect(service.ingestFixture({
      ...input(bytes),
      sampleBytes: Buffer.from(JSON.stringify(records)),
    })).rejects.toBeInstanceOf(MarketplaceSampleError);
    expect(deps.store.putImmutable).not.toHaveBeenCalled();
    expect(deps.repository.recordFixture).not.toHaveBeenCalled();
  });

  it("rejects metadata drift before storage", async () => {
    const bytes = await fixtureBytes();
    const deps = dependencies(Buffer.alloc(32, 0xff));
    const service = createMarketplaceSampleService({ ...deps, maxBytes: 1024 * 1024 });

    await expect(service.ingestFixture(input(bytes))).rejects.toMatchObject({
      code: "MARKETPLACE_SAMPLE_METADATA_MISMATCH",
    });
    expect(deps.store.putImmutable).not.toHaveBeenCalled();
  });

  it("rejects a different approved metadata shape before uploading a legacy fixture", async () => {
    const bytes = await fixtureBytes();
    const changedMetadata = Buffer.from(JSON.stringify({
      id: "gd_synthetic",
      fields: {
        url: { type: "url", active: true, required: true },
        text: { type: "text", active: true, required: false },
        author: { type: "text", active: true, required: false },
      },
    }));
    const deps = dependencies(createHash("sha256").update(changedMetadata).digest());
    const service = createMarketplaceSampleService({ ...deps, maxBytes: 1024 * 1024 });

    await expect(service.ingestFixture({
      ...input(bytes),
      metadataBytes: changedMetadata,
    })).rejects.toMatchObject({ code: "MARKETPLACE_SAMPLE_METADATA_INVALID" });
    expect(deps.repository.resolveTarget).not.toHaveBeenCalled();
    expect(deps.store.putImmutable).not.toHaveBeenCalled();
  });

  it("rejects invalid UTF-8 before storage", async () => {
    const bytes = await fixtureBytes();
    const deps = dependencies(createHash("sha256").update(bytes.metadataBytes).digest());
    const service = createMarketplaceSampleService({ ...deps, maxBytes: 1024 * 1024 });

    await expect(service.ingestFixture({
      ...input(bytes),
      sampleBytes: Buffer.from([0x5b, 0x22, 0xff, 0x22, 0x5d]),
    })).rejects.toMatchObject({ code: "MARKETPLACE_SAMPLE_SCHEMA_INVALID" });
    expect(deps.store.putImmutable).not.toHaveBeenCalled();
  });

  it.each([
    { maskingPolicyVersion: "" },
    { retentionPolicyVersion: "pending decision" },
    { retentionPolicyVersion: "fixture-explicit-expiry-v1" },
    { provenanceEvidenceReference: "provider://unapproved-real-sample" },
    { expiresAt: new Date("2026-09-11T08:59:59.000Z") },
    { expiresAt: new Date("2026-10-10T09:00:00.000Z") },
    { expiresAt: new Date("2026-10-12T09:00:00.000Z") },
  ])("fails closed on invalid fixture governance metadata: %o", async (change) => {
    const bytes = await fixtureBytes();
    const deps = dependencies(createHash("sha256").update(bytes.metadataBytes).digest());
    const service = createMarketplaceSampleService({ ...deps, maxBytes: 1024 * 1024 });

    await expect(service.ingestFixture({ ...input(bytes), ...change })).rejects.toMatchObject({
      code: "MARKETPLACE_SAMPLE_INPUT_INVALID",
    });
    expect(deps.store.putImmutable).not.toHaveBeenCalled();
  });

  it("rejects a post-write read-back mismatch and never records the sample", async () => {
    const bytes = await fixtureBytes();
    const deps = dependencies(createHash("sha256").update(bytes.metadataBytes).digest());
    vi.mocked(deps.store.open).mockResolvedValueOnce({
      receipt: {
        objectKey: "marketplace/samples/tampered/sample.json",
        contentType: "application/json",
        byteCount: 8,
        checksumHex: createHash("sha256").update("tampered").digest("hex"),
        eTag: "tampered-etag",
      },
      bytes: Buffer.from("tampered"),
    });
    const service = createMarketplaceSampleService({ ...deps, maxBytes: 1024 * 1024 });

    await expect(service.ingestFixture(input(bytes))).rejects.toMatchObject({
      code: "MARKETPLACE_SAMPLE_STORAGE_INTEGRITY_FAILURE",
    });
    expect(deps.repository.recordFixture).not.toHaveBeenCalled();
  });

  it("rejects an invalid immutable-write receipt before read-back or database recording", async () => {
    const bytes = await fixtureBytes();
    const deps = dependencies(createHash("sha256").update(bytes.metadataBytes).digest());
    vi.mocked(deps.store.putImmutable).mockResolvedValueOnce({
      objectKey: "marketplace/samples/tampered/sample.json",
      contentType: "application/json",
      byteCount: 8,
      checksumHex: createHash("sha256").update("tampered").digest("hex"),
      eTag: "tampered-etag",
    });
    const service = createMarketplaceSampleService({ ...deps, maxBytes: 1024 * 1024 });

    await expect(service.ingestFixture(input(bytes))).rejects.toMatchObject({
      code: "MARKETPLACE_SAMPLE_STORAGE_INTEGRITY_FAILURE",
    });
    expect(deps.store.open).not.toHaveBeenCalled();
    expect(deps.repository.recordFixture).not.toHaveBeenCalled();
  });

  it("retrieves an unexpired fixture internally and preserves provider-style masking", async () => {
    const bytes = await fixtureBytes();
    const deps = dependencies(createHash("sha256").update(bytes.metadataBytes).digest());
    const sampleBytes = Buffer.from(
      '[{"url":"https://www.linkedin.com/posts/synthetic","text":"Synt***post"}]',
    );
    const checksum = createHash("sha256").update(sampleBytes).digest();
    vi.mocked(deps.repository.resolveFixture).mockResolvedValueOnce({
      ...(await deps.repository.resolveFixture({
        templateSlug: "linkedin-posts",
        templateVersion: 1,
        sampleVersion: 1,
        asOf: new Date("2026-09-12T09:00:00.000Z"),
      })),
      byteCount: sampleBytes.byteLength,
      checksum,
      objectKey:
        `marketplace/samples/76000000-0000-4000-8000-000000000001/1/${checksum.toString("hex")}.json`,
    });
    vi.mocked(deps.store.open).mockResolvedValueOnce({
      receipt: {
        objectKey:
          `marketplace/samples/76000000-0000-4000-8000-000000000001/1/${checksum.toString("hex")}.json`,
        contentType: "application/json",
        byteCount: sampleBytes.byteLength,
        checksumHex: checksum.toString("hex"),
        eTag: "fixture-etag",
      },
      bytes: sampleBytes,
    });
    const service = createMarketplaceSampleService({ ...deps, maxBytes: 1024 * 1024 });

    const result = await service.inspectFixture({
      templateSlug: "linkedin-posts",
      templateVersion: 1,
      sampleVersion: 1,
      metadataBytes: bytes.metadataBytes,
      asOf: new Date("2026-09-12T09:00:00.000Z"),
    });

    expect(result.records).toEqual([
      { url: "https://www.linkedin.com/posts/synthetic", text: "Synt***post" },
    ]);
    expect(result.maskedFields).toEqual(["text"]);
    expect(JSON.stringify(result)).not.toContain("objectKey");
  });

  it("deletes expired fixture objects before recording immutable deletion evidence", async () => {
    const bytes = await fixtureBytes();
    const deps = dependencies(createHash("sha256").update(bytes.metadataBytes).digest());
    vi.mocked(deps.repository.listExpiredFixtures).mockResolvedValueOnce([{
      sampleId: "76000000-0000-4000-8000-000000000002",
      objectKey:
        `marketplace/samples/76000000-0000-4000-8000-000000000001/1/${"61".repeat(32)}.json`,
    }]);
    const service = createMarketplaceSampleService({ ...deps, maxBytes: 1024 * 1024 });

    const result = await service.expireFixtures({
      asOf: new Date("2026-10-11T09:00:00.000Z"),
      limit: 25,
      actor: "m3.expiry.test",
    });

    expect(result).toEqual({ examined: 1, deleted: 1, alreadyAbsent: 0 });
    expect(deps.store.deleteAndVerify).toHaveBeenCalledOnce();
    expect(deps.repository.recordFixtureDeletion).toHaveBeenCalledWith({
      sampleId: "76000000-0000-4000-8000-000000000002",
      deletedAt: new Date("2026-10-11T09:00:00.000Z"),
      storageDisposition: "deleted",
      actor: "m3.expiry.test",
    });
    expect(
      vi.mocked(deps.store.deleteAndVerify).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(deps.repository.recordFixtureDeletion).mock.invocationCallOrder[0] ?? 0,
    );
  });
});
