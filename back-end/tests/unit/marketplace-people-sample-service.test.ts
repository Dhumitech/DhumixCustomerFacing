import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { MarketplacePeopleSampleRepository } from
  "../../src/services/marketplacePeople/marketplacePeopleSampleRepository.js";
import {
  LINKEDIN_PEOPLE_MASKED_FIELDS,
  LINKEDIN_PEOPLE_METADATA_BYTE_COUNT,
  LINKEDIN_PEOPLE_METADATA_SHA256,
  createMarketplacePeopleSampleService,
} from "../../src/services/marketplacePeople/marketplacePeopleSampleService.js";

const observationId = "8c000000-0000-4000-8000-000000000001";
const candidateId = "f60af142-3f00-4b0f-b159-86b41ff74b7f";
const templateVersionId = "8c000000-0000-4000-8000-000000000002";
const sampleId = "8c000000-0000-4000-8000-000000000003";
const observedAt = new Date("2026-09-13T17:05:35.686Z");

const fieldTypes = {
  id: "text", name: "text", city: "text", country_code: "text", position: "text",
  about: "text", posts: "array", groups: "array", current_company: "object",
  experience: "array", url: "url", people_also_viewed: "array",
  educations_details: "text", education: "array", recommendations_count: "number",
  avatar: "url", courses: "array", languages: "array", certifications: "array",
  recommendations: "array", volunteer_experience: "array", followers: "number",
  connections: "number", current_company_company_id: "text",
  current_company_name: "text", publications: "array", patents: "array",
  projects: "array", organizations: "array", location: "text", input_url: "url",
  linkedin_id: "text", activity: "array", linkedin_num_id: "text",
  banner_image: "url", honors_and_awards: "array", similar_profiles: "array",
  default_avatar: "boolean", memorialized_account: "boolean", bio_links: "array",
  first_name: "text", last_name: "text", urn_id: "text", urn: "text",
  influencer: "boolean", fsd_profile_id: "text",
} as const;
const inactive = new Set(["groups", "urn_id", "urn", "fsd_profile_id"]);
const masked = new Set<string>(LINKEDIN_PEOPLE_MASKED_FIELDS);
const required = new Set(["url", "linkedin_num_id"]);

function metadataBytes(): Buffer {
  return Buffer.from(JSON.stringify({
    id: "protected-standard-people-id",
    fields: Object.fromEntries(Object.entries(fieldTypes).map(([name, type]) => [name, {
      type,
      active: !inactive.has(name),
      required: required.has(name),
      description: `Verified ${name} field`,
      ...(masked.has(name) ? { pii: true } : {}),
    }])),
  }));
}

async function fixtureBytes(): Promise<Buffer> {
  return readFile(new URL(
    "../fixtures/marketplace-people/linkedin-people-synthetic-v1.json",
    import.meta.url,
  ));
}

function dependencies(metadata = metadataBytes()) {
  let capturedDictionary: readonly Readonly<Record<string, unknown>>[] = [];
  const repository: MarketplacePeopleSampleRepository = {
    resolveSource: vi.fn(async () => ({
      observationId,
      candidateId,
      templateVersionId,
      templateSlug: "linkedin-people" as const,
      templateVersion: 1 as const,
      evidenceObjectKey:
        `qualification/catalog-imports/${observationId}/metadata/linkedin-people-standard.json`,
      metadataChecksum: Buffer.from(LINKEDIN_PEOPLE_METADATA_SHA256, "hex"),
      metadataByteCount: LINKEDIN_PEOPLE_METADATA_BYTE_COUNT,
      metadataFieldCount: 46 as const,
      observedAt,
    })),
    recordSyntheticSample: vi.fn(async (input) => {
      capturedDictionary = input.fieldDictionary;
      return { sampleId: input.sampleId, disposition: "created" as const };
    }),
  };
  const evidenceReader = {
    open: vi.fn(async (input: { objectKey: string }) => ({
      objectKey: input.objectKey,
      bytes: metadata,
      contentType: "application/json",
      byteCount: LINKEDIN_PEOPLE_METADATA_BYTE_COUNT,
      checksumHex: LINKEDIN_PEOPLE_METADATA_SHA256,
    })),
  };
  const sampleStore = {
    putImmutable: vi.fn(async (input: {
      objectKey: string; bytes: Buffer; contentType: string;
    }) => ({
      objectKey: input.objectKey,
      contentType: input.contentType,
      byteCount: input.bytes.byteLength,
      checksumHex: createHash("sha256").update(input.bytes).digest("hex"),
      eTag: "etag",
    })),
    open: vi.fn(async (objectKey: string) => {
      const bytes = await fixtureBytes();
      return {
        receipt: {
          objectKey,
          contentType: "application/json",
          byteCount: bytes.byteLength,
          checksumHex: createHash("sha256").update(bytes).digest("hex"),
          eTag: "etag",
        },
        bytes,
      };
    }),
    deleteAndVerify: vi.fn(),
  };
  return {
    repository,
    evidenceReader,
    sampleStore,
    dictionary: () => capturedDictionary,
  };
}

describe("LinkedIn People synthetic sample service", () => {
  it("derives a 42-field preview with exact PII masking from retained metadata", async () => {
    const deps = dependencies();
    const service = createMarketplacePeopleSampleService({
      ...deps,
      maxBytes: 1_000_000,
      uuid: () => sampleId,
    });

    const result = await service.ingest({
      sampleBytes: await fixtureBytes(),
      sampleVersion: 1,
      actor: "marketplace.people.sample.local",
    });

    expect(result).toMatchObject({
      template_slug: "linkedin-people",
      sample_version: 1,
      record_count: 5,
      provider_metadata_field_count: 46,
      active_field_count: 42,
      masked_field_count: 12,
      inactive_field_count: 4,
      provider_calls: 0,
    });
    const dictionary = deps.dictionary();
    expect(dictionary).toHaveLength(42);
    expect(dictionary.filter((field) => field.sample_visibility === "masked")
      .map((field) => field.name).sort()).toEqual([...LINKEDIN_PEOPLE_MASKED_FIELDS].sort());
    expect(dictionary.find((field) => field.name === "influencer")).toMatchObject({
      type: "boolean",
      sample_visibility: "visible",
      allowed_operators: ["=", "!=", "in", "not_in", "is_null", "is_not_null"],
    });
    expect(dictionary.find((field) => field.name === "url")).toMatchObject({
      required: true,
      sample_visibility: "masked",
      allowed_operators: [],
    });
    expect(dictionary.some((field) => inactive.has(String(field.name)))).toBe(false);
    expect(deps.evidenceReader.open).toHaveBeenCalledTimes(1);
    expect(deps.sampleStore.putImmutable).toHaveBeenCalledTimes(1);
    expect(deps.repository.recordSyntheticSample).toHaveBeenCalledTimes(1);
  });

  it("fails closed before storage when the retained source checksum differs", async () => {
    const deps = dependencies();
    vi.mocked(deps.repository.resolveSource).mockResolvedValueOnce({
      ...(await deps.repository.resolveSource()),
      metadataChecksum: Buffer.alloc(32, 7),
    });
    const service = createMarketplacePeopleSampleService({
      ...deps,
      maxBytes: 1_000_000,
      uuid: () => sampleId,
    });

    await expect(service.ingest({
      sampleBytes: await fixtureBytes(),
      sampleVersion: 1,
      actor: "marketplace.people.sample.local",
    })).rejects.toMatchObject({ code: "MARKETPLACE_PEOPLE_SAMPLE_SOURCE_INVALID" });
    expect(deps.evidenceReader.open).not.toHaveBeenCalled();
    expect(deps.sampleStore.putImmutable).not.toHaveBeenCalled();
  });

  it("fails closed if the exact metadata no longer carries the expected PII marker", async () => {
    const decoded = JSON.parse(metadataBytes().toString("utf8")) as {
      fields: Record<string, Record<string, unknown>>;
    };
    delete decoded.fields.about?.pii;
    const deps = dependencies(Buffer.from(JSON.stringify(decoded)));
    const service = createMarketplacePeopleSampleService({
      ...deps,
      maxBytes: 1_000_000,
      uuid: () => sampleId,
    });

    await expect(service.ingest({
      sampleBytes: await fixtureBytes(),
      sampleVersion: 1,
      actor: "marketplace.people.sample.local",
    })).rejects.toMatchObject({ code: "MARKETPLACE_PEOPLE_SAMPLE_METADATA_INVALID" });
    expect(deps.sampleStore.putImmutable).not.toHaveBeenCalled();
    expect(deps.repository.recordSyntheticSample).not.toHaveBeenCalled();
  });
});
