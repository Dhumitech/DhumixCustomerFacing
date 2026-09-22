import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ProviderReferenceProtector } from
  "../../src/services/brightdata/providerReferenceProtector.js";
import {
  createMarketplaceProviderSampleService,
  LINKEDIN_POSTS_PROVIDER_SAMPLE_DECISION_REFERENCE,
} from "../../src/services/marketplaceSample/marketplaceProviderSampleService.js";
import type { MarketplaceProviderSampleRepository } from
  "../../src/services/marketplaceSample/marketplaceSampleRepository.js";
import type { MarketplaceSampleStore } from
  "../../src/services/marketplaceSample/marketplaceSampleStore.js";
import type { QualificationEvidenceReader } from
  "../../src/services/qualification/qualificationEvidenceReader.js";

const packetId = "2e1560c3-ca8b-40a0-b578-c9e71ecf27cd";
const rawChecksum = "d5a9c6c3403959349925d0574195e12e511ab2e861d421938e53b4a6738f6c95";
const metadataChecksum = "039685f485ab09f0a6f9503517a2aa34957920c0f2faf827684c0b600512499b";
const datasetId = "gd_lyy3tktm25m4avu764";

const definitions = [
  ["url", "url"], ["id", "text"], ["user_id", "text"], ["use_url", "url"],
  ["title", "text"], ["headline", "text"], ["post_text", "text"],
  ["date_posted", "date"], ["hashtags", "array"], ["embedded_links", "array"],
  ["images", "array"], ["videos", "array"], ["num_likes", "number"],
  ["num_comments", "number"], ["more_articles_by_user", "array"],
  ["more_relevant_posts", "array"], ["top_visible_comments", "array"],
  ["user_followers", "number"], ["user_posts", "number"],
  ["user_articles", "number"], ["post_type", "text"], ["account_type", "text"],
  ["post_text_html", "text"], ["repost", "object"], ["tagged_companies", "array"],
  ["tagged_people", "array"], ["user_title", "text"],
  ["author_profile_pic", "url"], ["num_connections", "number"],
  ["video_duration", "number"], ["external_link_data", "array"],
  ["video_thumbnail", "url"], ["document_cover_image", "url"],
  ["document_page_count", "number"], ["user_profile_pic", "url"],
  ["user_name", "text"], ["original_post_text", "text"],
] as const;

const directlyMasked = new Set([
  "user_id", "title", "headline", "user_title", "author_profile_pic",
  "user_profile_pic", "user_name",
]);
const nestedMasked = new Set([
  "top_visible_comments", "repost", "tagged_people", "external_link_data",
]);

function metadataBytes(): Buffer {
  return Buffer.from(JSON.stringify({
    id: datasetId,
    fields: Object.fromEntries(definitions.map(([name, type], index) => [name, {
      type,
      active: true,
      ...(index < 2 ? { required: true } : {}),
      description: `Provider description for ${name}`,
      ...(directlyMasked.has(name) ? { pii: true } : {}),
      ...(nestedMasked.has(name) ? { fields: { nested: { type: "text", pii: true } } } : {}),
    }])),
  }), "utf8");
}

function fieldValue(type: typeof definitions[number][1], index: number): unknown {
  if (type === "url") return `https://www.linkedin.com/example/${index}`;
  if (type === "date") return "2026-09-13T00:00:00.000Z";
  if (type === "number") return index;
  if (type === "array") return [];
  if (type === "object") return {};
  return `value-${index}`;
}

function rawBytes(): Buffer {
  return Buffer.from(JSON.stringify(Array.from({ length: 5 }, (_, recordIndex) =>
    Object.fromEntries(definitions.map(([name, type], fieldIndex) => [
      name,
      fieldValue(type, recordIndex + fieldIndex),
    ])))), "utf8");
}

function dependencies() {
  const bytes = rawBytes();
  const metadata = metadataBytes();
  const templateVersionId = randomUUID();
  const completedAt = new Date("2026-09-13T06:00:00.000Z");
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
      rawByteCount: bytes.byteLength,
      rawChecksum: Buffer.from(rawChecksum, "hex"),
      completedAt,
    })),
    recordProviderSample: vi.fn(async (input) => ({
      sampleId: input.sampleId,
      disposition: "created" as const,
      collectedAt: completedAt,
      expiresAt: new Date(completedAt.valueOf() + 30 * 24 * 60 * 60 * 1000),
    })),
  };
  const qualificationStore: QualificationEvidenceReader = {
    open: vi.fn(async (input) => input.objectKey.endsWith("dataset-metadata.json")
      ? {
          objectKey: input.objectKey,
          bytes: metadata,
          contentType: "application/json",
          byteCount: metadata.byteLength,
          checksumHex: metadataChecksum,
        }
      : {
          objectKey: input.objectKey,
          bytes,
          contentType: "application/json",
          byteCount: bytes.byteLength,
          checksumHex: rawChecksum,
        }),
  };
  const sampleStore: MarketplaceSampleStore = {
    putImmutable: vi.fn(async (input) => ({
      objectKey: input.objectKey,
      contentType: input.contentType,
      byteCount: input.bytes.byteLength,
      checksumHex: rawChecksum,
      eTag: "provider-sample-etag",
    })),
    open: vi.fn(async () => { throw new Error("not used"); }),
    deleteAndVerify: vi.fn(async () => ({ disposition: "deleted" as const })),
  };
  const protector: ProviderReferenceProtector = {
    protect: vi.fn(async () => { throw new Error("not used"); }),
    reveal: vi.fn(async () => datasetId),
  };
  return { repository, qualificationStore, sampleStore, protector, completedAt };
}

describe("LinkedIn Posts qualified provider sample promotion", () => {
  it("copies the exact retained five-record evidence and freezes the masking policy", async () => {
    const deps = dependencies();
    const sampleId = randomUUID();
    const service = createMarketplaceProviderSampleService({
      ...deps,
      maxBytes: 1024 * 1024,
      uuid: () => sampleId,
    });

    const result = await service.promote({
      packetId,
      sampleVersion: 3,
      actor: "marketplace.provider-sample.local",
    });

    expect(result).toMatchObject({
      sample_id: sampleId,
      sample_version: 3,
      source_kind: "provider_qualification",
      state: "validated_provider_sample",
      governance_state: "formal_agreement_pending_local_demo",
      record_count: 5,
      field_count: 37,
      masked_field_count: 11,
      checksum: rawChecksum,
      metadata_checksum: metadataChecksum,
      provider_calls: 0,
    });
    expect(deps.qualificationStore.open).toHaveBeenCalledTimes(2);
    expect(deps.sampleStore.putImmutable).toHaveBeenCalledOnce();
    const recorded = vi.mocked(deps.repository.recordProviderSample).mock.calls[0]?.[0];
    expect(recorded?.interimDecisionReference).toBe(
      LINKEDIN_POSTS_PROVIDER_SAMPLE_DECISION_REFERENCE,
    );
    expect(result.expires_at).toBe("2026-10-13T06:00:00.000Z");
    const dictionary = recorded?.fieldDictionary ?? [];
    expect(dictionary.filter((field) => field.sample_visibility === "masked"))
      .toHaveLength(11);
    expect(dictionary.filter((field) => field.sample_visibility === "masked")
      .every((field) => Array.isArray(field.allowed_operators) &&
        field.allowed_operators.length === 0)).toBe(true);
    expect(dictionary.every((field) => field.post_purchase_visibility === "visible")).toBe(true);
  });

  it("fails before sample storage when retained metadata is not the pinned evidence", async () => {
    const deps = dependencies();
    vi.mocked(deps.qualificationStore.open).mockImplementation(async (input) => {
      const document = input.objectKey.endsWith("dataset-metadata.json")
        ? metadataBytes()
        : rawBytes();
      return {
        objectKey: input.objectKey,
        bytes: document,
        contentType: "application/json",
        byteCount: document.byteLength,
        checksumHex: "0".repeat(64),
      };
    });
    const service = createMarketplaceProviderSampleService({ ...deps, maxBytes: 1024 * 1024 });

    await expect(service.promote({
      packetId,
      sampleVersion: 3,
      actor: "marketplace.provider-sample.local",
    })).rejects.toMatchObject({
      code: "MARKETPLACE_PROVIDER_SAMPLE_STORAGE_INTEGRITY_FAILURE",
    });
    expect(deps.sampleStore.putImmutable).not.toHaveBeenCalled();
    expect(deps.repository.recordProviderSample).not.toHaveBeenCalled();
  });

  it("rejects every sample version except immutable version 3 before any side effect", async () => {
    const deps = dependencies();
    const service = createMarketplaceProviderSampleService({ ...deps, maxBytes: 1024 * 1024 });

    await expect(service.promote({
      packetId,
      sampleVersion: 2,
      actor: "marketplace.provider-sample.local",
    })).rejects.toMatchObject({
      code: "MARKETPLACE_PROVIDER_SAMPLE_INPUT_INVALID",
    });
    expect(deps.repository.resolveQualifiedSource).not.toHaveBeenCalled();
    expect(deps.qualificationStore.open).not.toHaveBeenCalled();
    expect(deps.sampleStore.putImmutable).not.toHaveBeenCalled();
    expect(deps.repository.recordProviderSample).not.toHaveBeenCalled();
  });
});
