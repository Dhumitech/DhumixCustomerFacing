import { createHash, randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import type { QualificationEvidenceReader } from
  "../qualification/qualificationEvidenceReader.js";
import type { MarketplaceSampleStore } from
  "../marketplaceSample/marketplaceSampleStore.js";
import type {
  LinkedInPeopleFieldDictionaryEntry,
  MarketplacePeopleSampleRepository,
} from "./marketplacePeopleSampleRepository.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$/;
const FIELD_NAME = /^[a-z][a-z0-9_]{0,127}$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export const LINKEDIN_PEOPLE_METADATA_SHA256 =
  "9b3b7be895b1e063363e46e205c1f9e46864011e6ee76e666ac8a27e0d7a86eb";
export const LINKEDIN_PEOPLE_METADATA_BYTE_COUNT = 32_401;
export const LINKEDIN_PEOPLE_METADATA_FIELD_COUNT = 46;
export const LINKEDIN_PEOPLE_ACTIVE_FIELD_COUNT = 42;
export const LINKEDIN_PEOPLE_MASKED_FIELD_COUNT = 12;
export const LINKEDIN_PEOPLE_SAMPLE_RECORD_COUNT = 5;
export const LINKEDIN_PEOPLE_SAMPLE_MASKING_POLICY_VERSION =
  "linkedin-people-provider-metadata-pii-mask-v1";
export const LINKEDIN_PEOPLE_SAMPLE_RETENTION_POLICY_VERSION =
  "linkedin-people-sample-30d-v1";

type FieldType = LinkedInPeopleFieldDictionaryEntry["type"];
type Operator = "=" | "!=" | "in" | "not_in" | "includes" | "not_includes" |
  "is_null" | "is_not_null";

const EXPECTED_FIELDS: Readonly<Record<string, FieldType>> = Object.freeze({
  id: "text",
  name: "text",
  city: "text",
  country_code: "text",
  position: "text",
  about: "text",
  posts: "array",
  groups: "array",
  current_company: "object",
  experience: "array",
  url: "url",
  people_also_viewed: "array",
  educations_details: "text",
  education: "array",
  recommendations_count: "number",
  avatar: "url",
  courses: "array",
  languages: "array",
  certifications: "array",
  recommendations: "array",
  volunteer_experience: "array",
  followers: "number",
  connections: "number",
  current_company_company_id: "text",
  current_company_name: "text",
  publications: "array",
  patents: "array",
  projects: "array",
  organizations: "array",
  location: "text",
  input_url: "url",
  linkedin_id: "text",
  activity: "array",
  linkedin_num_id: "text",
  banner_image: "url",
  honors_and_awards: "array",
  similar_profiles: "array",
  default_avatar: "boolean",
  memorialized_account: "boolean",
  bio_links: "array",
  first_name: "text",
  last_name: "text",
  urn_id: "text",
  urn: "text",
  influencer: "boolean",
  fsd_profile_id: "text",
});

const INACTIVE_FIELDS = new Set(["groups", "urn_id", "urn", "fsd_profile_id"]);
const REQUIRED_ACTIVE_FIELDS = new Set(["url", "linkedin_num_id"]);
export const LINKEDIN_PEOPLE_MASKED_FIELDS = Object.freeze([
  "about",
  "activity",
  "first_name",
  "id",
  "input_url",
  "last_name",
  "linkedin_id",
  "name",
  "people_also_viewed",
  "recommendations",
  "similar_profiles",
  "url",
] as const);
const MASKED_FIELDS = new Set<string>(LINKEDIN_PEOPLE_MASKED_FIELDS);

export type MarketplacePeopleSampleErrorCode =
  | "MARKETPLACE_PEOPLE_SAMPLE_CONFIGURATION_INVALID"
  | "MARKETPLACE_PEOPLE_SAMPLE_INPUT_INVALID"
  | "MARKETPLACE_PEOPLE_SAMPLE_SOURCE_INVALID"
  | "MARKETPLACE_PEOPLE_SAMPLE_METADATA_INVALID"
  | "MARKETPLACE_PEOPLE_SAMPLE_DATA_INVALID"
  | "MARKETPLACE_PEOPLE_SAMPLE_STORAGE_FAILURE"
  | "MARKETPLACE_PEOPLE_SAMPLE_STORAGE_INTEGRITY_FAILURE"
  | "MARKETPLACE_PEOPLE_SAMPLE_DATABASE_FAILURE";

export class MarketplacePeopleSampleError extends Error {
  public constructor(public readonly code: MarketplacePeopleSampleErrorCode, cause?: unknown) {
    super("LinkedIn People synthetic sample ingestion failed",
      cause === undefined ? undefined : { cause });
    this.name = "MarketplacePeopleSampleError";
  }
}

interface Dependencies {
  readonly repository: MarketplacePeopleSampleRepository;
  readonly evidenceReader: QualificationEvidenceReader;
  readonly sampleStore: MarketplaceSampleStore;
  readonly maxBytes: number;
  readonly uuid?: () => string;
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MarketplacePeopleSampleError("MARKETPLACE_PEOPLE_SAMPLE_METADATA_INVALID");
  }
  return value as Readonly<Record<string, unknown>>;
}

function containsPiiMarker(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return value.some(containsPiiMarker);
  const row = value as Readonly<Record<string, unknown>>;
  return row.pii === true || Object.values(row).some(containsPiiMarker);
}

function operators(type: FieldType, masked: boolean): readonly Operator[] {
  if (masked) return Object.freeze([]);
  if (type === "array" || type === "object") {
    return Object.freeze(["is_null", "is_not_null"]);
  }
  if (type === "number" || type === "boolean") {
    return Object.freeze(["=", "!=", "in", "not_in", "is_null", "is_not_null"]);
  }
  return Object.freeze([
    "=", "!=", "in", "not_in", "includes", "not_includes", "is_null", "is_not_null",
  ]);
}

function parseMetadata(bytes: Buffer): readonly LinkedInPeopleFieldDictionaryEntry[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(UTF8_DECODER.decode(bytes));
  } catch (cause) {
    throw new MarketplacePeopleSampleError("MARKETPLACE_PEOPLE_SAMPLE_METADATA_INVALID", cause);
  }
  const metadata = object(decoded);
  if (typeof metadata.id !== "string" || metadata.id.length < 1) {
    throw new MarketplacePeopleSampleError("MARKETPLACE_PEOPLE_SAMPLE_METADATA_INVALID");
  }
  const fields = object(metadata.fields);
  if (
    Object.keys(fields).length !== LINKEDIN_PEOPLE_METADATA_FIELD_COUNT ||
    Object.keys(EXPECTED_FIELDS).some((name) => !(name in fields)) ||
    Object.keys(fields).some((name) => !(name in EXPECTED_FIELDS))
  ) {
    throw new MarketplacePeopleSampleError("MARKETPLACE_PEOPLE_SAMPLE_METADATA_INVALID");
  }

  const dictionary: LinkedInPeopleFieldDictionaryEntry[] = [];
  for (const [name, raw] of Object.entries(fields)) {
    const field = object(raw);
    const expectedType = EXPECTED_FIELDS[name];
    const expectedActive = !INACTIVE_FIELDS.has(name);
    const expectedRequired = REQUIRED_ACTIVE_FIELDS.has(name);
    if (
      !FIELD_NAME.test(name) ||
      expectedType === undefined ||
      field.type !== expectedType ||
      field.active !== expectedActive ||
      (field.required === true) !== expectedRequired ||
      (field.required !== undefined && typeof field.required !== "boolean") ||
      typeof field.description !== "string" ||
      field.description.length < 1 ||
      field.description.length > 4000 ||
      containsPiiMarker(field) !== MASKED_FIELDS.has(name)
    ) {
      throw new MarketplacePeopleSampleError("MARKETPLACE_PEOPLE_SAMPLE_METADATA_INVALID");
    }
    if (!expectedActive) continue;
    const masked = MASKED_FIELDS.has(name);
    dictionary.push(Object.freeze({
      name,
      type: expectedType,
      active: true,
      required: expectedRequired,
      description: field.description,
      sample_visibility: masked ? "masked" : "visible",
      allowed_operators: operators(expectedType, masked),
      post_purchase_visibility: "visible",
    }));
  }
  if (
    dictionary.length !== LINKEDIN_PEOPLE_ACTIVE_FIELD_COUNT ||
    dictionary.filter((field) => field.sample_visibility === "masked").length !==
      LINKEDIN_PEOPLE_MASKED_FIELD_COUNT
  ) {
    throw new MarketplacePeopleSampleError("MARKETPLACE_PEOPLE_SAMPLE_METADATA_INVALID");
  }
  return Object.freeze(dictionary);
}

function validHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function validValue(value: unknown, type: FieldType): boolean {
  if (value === null) return true;
  if (type === "text") return typeof value === "string";
  if (type === "url") return typeof value === "string" && validHttpUrl(value);
  if (type === "date") return typeof value === "string" && !Number.isNaN(Date.parse(value));
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "array") return Array.isArray(value);
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateSample(
  bytes: Buffer,
  dictionary: readonly LinkedInPeopleFieldDictionaryEntry[],
): readonly Readonly<Record<string, unknown>>[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(UTF8_DECODER.decode(bytes));
  } catch (cause) {
    throw new MarketplacePeopleSampleError("MARKETPLACE_PEOPLE_SAMPLE_DATA_INVALID", cause);
  }
  if (!Array.isArray(decoded) || decoded.length !== LINKEDIN_PEOPLE_SAMPLE_RECORD_COUNT) {
    throw new MarketplacePeopleSampleError("MARKETPLACE_PEOPLE_SAMPLE_DATA_INVALID");
  }
  const fields = new Map(dictionary.map((field) => [field.name, field]));
  const represented = new Set<string>();
  for (const rawRecord of decoded) {
    if (typeof rawRecord !== "object" || rawRecord === null || Array.isArray(rawRecord)) {
      throw new MarketplacePeopleSampleError("MARKETPLACE_PEOPLE_SAMPLE_DATA_INVALID");
    }
    const record = rawRecord as Readonly<Record<string, unknown>>;
    if (Object.keys(record).some((name) => !fields.has(name))) {
      throw new MarketplacePeopleSampleError("MARKETPLACE_PEOPLE_SAMPLE_DATA_INVALID");
    }
    for (const field of dictionary) {
      const present = Object.hasOwn(record, field.name);
      const value = record[field.name];
      if ((field.required && (!present || value === null)) ||
          (present && !validValue(value, field.type))) {
        throw new MarketplacePeopleSampleError("MARKETPLACE_PEOPLE_SAMPLE_DATA_INVALID");
      }
      if (present) represented.add(field.name);
    }
  }
  if (represented.size !== LINKEDIN_PEOPLE_ACTIVE_FIELD_COUNT) {
    throw new MarketplacePeopleSampleError("MARKETPLACE_PEOPLE_SAMPLE_DATA_INVALID");
  }
  return decoded as readonly Readonly<Record<string, unknown>>[];
}

export function createMarketplacePeopleSampleService(dependencies: Dependencies) {
  if (!Number.isSafeInteger(dependencies.maxBytes) || dependencies.maxBytes < 2) {
    throw new MarketplacePeopleSampleError("MARKETPLACE_PEOPLE_SAMPLE_CONFIGURATION_INVALID");
  }
  const uuid = dependencies.uuid ?? randomUUID;
  return Object.freeze({
    async ingest(input: {
      readonly sampleBytes: Buffer;
      readonly sampleVersion: 1;
      readonly actor: string;
    }) {
      if (
        !Buffer.isBuffer(input.sampleBytes) ||
        input.sampleBytes.byteLength < 2 ||
        input.sampleBytes.byteLength > dependencies.maxBytes ||
        input.sampleVersion !== 1 ||
        !ACTOR.test(input.actor)
      ) {
        throw new MarketplacePeopleSampleError("MARKETPLACE_PEOPLE_SAMPLE_INPUT_INVALID");
      }

      let source;
      try {
        source = await dependencies.repository.resolveSource();
      } catch (cause) {
        throw new MarketplacePeopleSampleError("MARKETPLACE_PEOPLE_SAMPLE_DATABASE_FAILURE", cause);
      }
      if (
        source.metadataChecksum.toString("hex") !== LINKEDIN_PEOPLE_METADATA_SHA256 ||
        source.metadataByteCount !== LINKEDIN_PEOPLE_METADATA_BYTE_COUNT ||
        source.metadataFieldCount !== LINKEDIN_PEOPLE_METADATA_FIELD_COUNT
      ) {
        throw new MarketplacePeopleSampleError("MARKETPLACE_PEOPLE_SAMPLE_SOURCE_INVALID");
      }

      let metadata;
      try {
        metadata = await dependencies.evidenceReader.open({
          objectKey: source.evidenceObjectKey,
          maxBytes: dependencies.maxBytes,
        });
      } catch (cause) {
        throw new MarketplacePeopleSampleError("MARKETPLACE_PEOPLE_SAMPLE_STORAGE_FAILURE", cause);
      }
      if (
        metadata.contentType !== "application/json" ||
        metadata.byteCount !== LINKEDIN_PEOPLE_METADATA_BYTE_COUNT ||
        metadata.checksumHex !== LINKEDIN_PEOPLE_METADATA_SHA256 ||
        metadata.objectKey !== source.evidenceObjectKey
      ) {
        throw new MarketplacePeopleSampleError(
          "MARKETPLACE_PEOPLE_SAMPLE_STORAGE_INTEGRITY_FAILURE",
        );
      }

      const dictionary = parseMetadata(metadata.bytes);
      const records = validateSample(input.sampleBytes, dictionary);
      const sampleId = uuid();
      if (!UUID.test(sampleId) || !UUID.test(source.templateVersionId)) {
        throw new MarketplacePeopleSampleError("MARKETPLACE_PEOPLE_SAMPLE_CONFIGURATION_INVALID");
      }
      const checksum = createHash("sha256").update(input.sampleBytes).digest();
      const objectKey = `marketplace/samples/${source.templateVersionId}/1/${checksum.toString("hex")}.json`;
      let receipt;
      try {
        receipt = await dependencies.sampleStore.putImmutable({
          objectKey,
          bytes: input.sampleBytes,
          contentType: "application/json",
          maxBytes: dependencies.maxBytes,
        });
      } catch (cause) {
        throw new MarketplacePeopleSampleError("MARKETPLACE_PEOPLE_SAMPLE_STORAGE_FAILURE", cause);
      }
      if (
        receipt.objectKey !== objectKey ||
        receipt.contentType !== "application/json" ||
        receipt.byteCount !== input.sampleBytes.byteLength ||
        receipt.checksumHex !== checksum.toString("hex")
      ) {
        throw new MarketplacePeopleSampleError(
          "MARKETPLACE_PEOPLE_SAMPLE_STORAGE_INTEGRITY_FAILURE",
        );
      }
      try {
        const opened = await dependencies.sampleStore.open(objectKey, dependencies.maxBytes);
        if (!opened.bytes.equals(input.sampleBytes) ||
            opened.receipt.checksumHex !== receipt.checksumHex) {
          throw new MarketplacePeopleSampleError(
            "MARKETPLACE_PEOPLE_SAMPLE_STORAGE_INTEGRITY_FAILURE",
          );
        }
      } catch (cause) {
        if (cause instanceof MarketplacePeopleSampleError) throw cause;
        throw new MarketplacePeopleSampleError(
          "MARKETPLACE_PEOPLE_SAMPLE_STORAGE_INTEGRITY_FAILURE",
          cause,
        );
      }

      const collectedAt = source.observedAt;
      const expiresAt = new Date(collectedAt.valueOf() + THIRTY_DAYS_MS);
      let recorded;
      try {
        recorded = await dependencies.repository.recordSyntheticSample({
          sampleId,
          observationId: source.observationId,
          templateVersionId: source.templateVersionId,
          sampleVersion: 1,
          objectKey,
          recordCount: LINKEDIN_PEOPLE_SAMPLE_RECORD_COUNT,
          byteCount: receipt.byteCount,
          checksum,
          metadataChecksum: source.metadataChecksum,
          fieldDictionary: dictionary,
          actor: input.actor,
        });
      } catch (cause) {
        throw new MarketplacePeopleSampleError("MARKETPLACE_PEOPLE_SAMPLE_DATABASE_FAILURE", cause);
      }
      return Object.freeze({
        sample_id: recorded.sampleId,
        template_slug: "linkedin-people" as const,
        template_version: 1 as const,
        sample_version: 1 as const,
        source_kind: "synthetic_fixture" as const,
        state: "validated_fixture" as const,
        record_count: records.length,
        provider_metadata_field_count: LINKEDIN_PEOPLE_METADATA_FIELD_COUNT,
        active_field_count: dictionary.length,
        masked_field_count: dictionary.filter((field) =>
          field.sample_visibility === "masked").length,
        inactive_field_count: LINKEDIN_PEOPLE_METADATA_FIELD_COUNT - dictionary.length,
        byte_count: receipt.byteCount,
        checksum: receipt.checksumHex,
        metadata_checksum: metadata.checksumHex,
        expires_at: expiresAt.toISOString(),
        disposition: recorded.disposition,
        provider_calls: 0 as const,
      });
    },
  });
}
