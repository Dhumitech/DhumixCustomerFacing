import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import type { ProviderReferenceProtector } from
  "../brightdata/providerReferenceProtector.js";
import type { QualificationEvidenceReader } from
  "../qualification/qualificationEvidenceReader.js";
import type { MarketplaceProviderSampleRepository } from
  "./marketplaceSampleRepository.js";
import type { MarketplaceSampleStore } from "./marketplaceSampleStore.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$/;
const FIELD_NAME = /^[a-z][a-z0-9_]{0,127}$/;
const EXPECTED_PACKET_ID = "2e1560c3-ca8b-40a0-b578-c9e71ecf27cd";
const EXPECTED_RAW_SHA256 =
  "d5a9c6c3403959349925d0574195e12e511ab2e861d421938e53b4a6738f6c95";
const EXPECTED_METADATA_SHA256 =
  "039685f485ab09f0a6f9503517a2aa34957920c0f2faf827684c0b600512499b";
const EXPECTED_RECORD_COUNT = 5;
const EXPECTED_FIELD_COUNT = 37;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export const LINKEDIN_POSTS_PROVIDER_SAMPLE_DECISION_REFERENCE =
  "decision://product-owner/2026-09-13/linkedin-posts-real-sample-local-demo-formal-agreement-pending";
export const LINKEDIN_POSTS_PROVIDER_SAMPLE_MASKING_POLICY_VERSION =
  "linkedin-posts-provider-metadata-pii-mask-v1";

type ProviderFieldType = "text" | "url" | "date" | "number" | "array" | "object";
type Operator = "=" | "!=" | "in" | "not_in" | "includes" | "not_includes" |
  "is_null" | "is_not_null";

interface FieldDictionaryEntry extends Readonly<Record<string, unknown>> {
  readonly name: string;
  readonly type: ProviderFieldType;
  readonly active: true;
  readonly required: boolean;
  readonly description: string;
  readonly sample_visibility: "visible" | "masked";
  readonly allowed_operators: readonly Operator[];
  readonly post_purchase_visibility: "visible";
}

export type MarketplaceProviderSampleErrorCode =
  | "MARKETPLACE_PROVIDER_SAMPLE_CONFIGURATION_INVALID"
  | "MARKETPLACE_PROVIDER_SAMPLE_INPUT_INVALID"
  | "MARKETPLACE_PROVIDER_SAMPLE_SOURCE_INVALID"
  | "MARKETPLACE_PROVIDER_SAMPLE_METADATA_INVALID"
  | "MARKETPLACE_PROVIDER_SAMPLE_DATA_INVALID"
  | "MARKETPLACE_PROVIDER_SAMPLE_STORAGE_FAILURE"
  | "MARKETPLACE_PROVIDER_SAMPLE_STORAGE_INTEGRITY_FAILURE"
  | "MARKETPLACE_PROVIDER_SAMPLE_DATABASE_FAILURE";

export class MarketplaceProviderSampleError extends Error {
  public readonly code: MarketplaceProviderSampleErrorCode;

  public constructor(code: MarketplaceProviderSampleErrorCode, cause?: unknown) {
    super(
      "Marketplace provider sample promotion failed",
      cause === undefined ? undefined : { cause },
    );
    this.name = "MarketplaceProviderSampleError";
    this.code = code;
  }
}

interface Dependencies {
  readonly repository: MarketplaceProviderSampleRepository;
  readonly qualificationStore: QualificationEvidenceReader;
  readonly sampleStore: MarketplaceSampleStore;
  readonly protector: ProviderReferenceProtector;
  readonly maxBytes: number;
  readonly uuid?: () => string;
}

export interface MarketplaceProviderSampleService {
  promote(input: {
    readonly packetId: string;
    readonly sampleVersion: number;
    readonly actor: string;
  }): Promise<{
    readonly sample_id: string;
    readonly sample_version: number;
    readonly source_kind: "provider_qualification";
    readonly state: "validated_provider_sample";
    readonly governance_state: "formal_agreement_pending_local_demo";
    readonly record_count: number;
    readonly field_count: number;
    readonly masked_field_count: number;
    readonly byte_count: number;
    readonly checksum: string;
    readonly metadata_checksum: string;
    readonly expires_at: string;
    readonly disposition: "created" | "existing";
    readonly provider_calls: 0;
  }>;
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MarketplaceProviderSampleError("MARKETPLACE_PROVIDER_SAMPLE_METADATA_INVALID");
  }
  return value as Readonly<Record<string, unknown>>;
}

function containsPiiMarker(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return value.some(containsPiiMarker);
  const row = value as Readonly<Record<string, unknown>>;
  return row.pii === true || Object.values(row).some(containsPiiMarker);
}

function operators(type: ProviderFieldType, masked: boolean): readonly Operator[] {
  if (masked) return Object.freeze([]);
  if (type === "array" || type === "object") {
    return Object.freeze(["is_null", "is_not_null"]);
  }
  if (type === "number") {
    return Object.freeze(["=", "!=", "in", "not_in", "is_null", "is_not_null"]);
  }
  return Object.freeze([
    "=", "!=", "in", "not_in", "includes", "not_includes", "is_null", "is_not_null",
  ]);
}

function parseMetadata(bytes: Buffer, expectedDatasetId: string): readonly FieldDictionaryEntry[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(UTF8_DECODER.decode(bytes));
  } catch (cause) {
    throw new MarketplaceProviderSampleError("MARKETPLACE_PROVIDER_SAMPLE_METADATA_INVALID", cause);
  }
  const metadata = object(decoded);
  if (metadata.id !== expectedDatasetId) {
    throw new MarketplaceProviderSampleError("MARKETPLACE_PROVIDER_SAMPLE_METADATA_INVALID");
  }
  const fields = object(metadata.fields);
  const dictionary = Object.entries(fields).map(([name, raw]): FieldDictionaryEntry => {
    const field = object(raw);
    if (
      !FIELD_NAME.test(name) ||
      !["text", "url", "date", "number", "array", "object"].includes(String(field.type)) ||
      field.active !== true ||
      (field.required !== undefined && typeof field.required !== "boolean") ||
      typeof field.description !== "string" ||
      field.description.length < 1 ||
      field.description.length > 4000
    ) {
      throw new MarketplaceProviderSampleError("MARKETPLACE_PROVIDER_SAMPLE_METADATA_INVALID");
    }
    const type = field.type as ProviderFieldType;
    const masked = containsPiiMarker(field);
    return Object.freeze({
      name,
      type,
      active: true,
      required: field.required === true,
      description: field.description,
      sample_visibility: masked ? "masked" : "visible",
      allowed_operators: operators(type, masked),
      post_purchase_visibility: "visible",
    });
  });
  if (dictionary.length !== EXPECTED_FIELD_COUNT) {
    throw new MarketplaceProviderSampleError("MARKETPLACE_PROVIDER_SAMPLE_METADATA_INVALID");
  }
  return Object.freeze(dictionary);
}

function validHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function validValue(value: unknown, type: ProviderFieldType): boolean {
  if (value === null) return true;
  if (type === "text") return typeof value === "string";
  if (type === "url") return typeof value === "string" && validHttpUrl(value);
  if (type === "date") return typeof value === "string" && !Number.isNaN(Date.parse(value));
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "array") return Array.isArray(value);
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateRecords(
  bytes: Buffer,
  dictionary: readonly FieldDictionaryEntry[],
): readonly Readonly<Record<string, unknown>>[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(UTF8_DECODER.decode(bytes));
  } catch (cause) {
    throw new MarketplaceProviderSampleError("MARKETPLACE_PROVIDER_SAMPLE_DATA_INVALID", cause);
  }
  if (!Array.isArray(decoded) || decoded.length !== EXPECTED_RECORD_COUNT) {
    throw new MarketplaceProviderSampleError("MARKETPLACE_PROVIDER_SAMPLE_DATA_INVALID");
  }
  const fields = new Map(dictionary.map((field) => [field.name, field]));
  for (const rawRecord of decoded) {
    if (typeof rawRecord !== "object" || rawRecord === null || Array.isArray(rawRecord)) {
      throw new MarketplaceProviderSampleError("MARKETPLACE_PROVIDER_SAMPLE_DATA_INVALID");
    }
    const record = rawRecord as Readonly<Record<string, unknown>>;
    if (Object.keys(record).some((name) => !fields.has(name))) {
      throw new MarketplaceProviderSampleError("MARKETPLACE_PROVIDER_SAMPLE_DATA_INVALID");
    }
    for (const field of dictionary) {
      const present = Object.hasOwn(record, field.name);
      const value = record[field.name];
      if ((field.required && (!present || value === null)) || (present && !validValue(value, field.type))) {
        throw new MarketplaceProviderSampleError("MARKETPLACE_PROVIDER_SAMPLE_DATA_INVALID");
      }
    }
  }
  return decoded as readonly Readonly<Record<string, unknown>>[];
}

function catalogueAad(environment: "local" | "test"): Buffer {
  return Buffer.from(`dhumi:marketplace-catalogue:v1:${environment}:linkedin.posts`, "utf8");
}

export function createMarketplaceProviderSampleService(
  dependencies: Dependencies,
): MarketplaceProviderSampleService {
  if (!Number.isSafeInteger(dependencies.maxBytes) || dependencies.maxBytes < 2) {
    throw new MarketplaceProviderSampleError("MARKETPLACE_PROVIDER_SAMPLE_CONFIGURATION_INVALID");
  }
  const uuid = dependencies.uuid ?? randomUUID;
  return Object.freeze({
    async promote(input: Parameters<MarketplaceProviderSampleService["promote"]>[0]) {
      if (
        input.packetId !== EXPECTED_PACKET_ID ||
        !Number.isSafeInteger(input.sampleVersion) ||
        input.sampleVersion !== 3 ||
        !ACTOR.test(input.actor)
      ) {
        throw new MarketplaceProviderSampleError("MARKETPLACE_PROVIDER_SAMPLE_INPUT_INVALID");
      }
      let source;
      try {
        source = await dependencies.repository.resolveQualifiedSource({ packetId: input.packetId });
      } catch (cause) {
        throw new MarketplaceProviderSampleError("MARKETPLACE_PROVIDER_SAMPLE_DATABASE_FAILURE", cause);
      }
      if (
        source.packetId !== input.packetId ||
        source.templateSlug !== "linkedin-posts" ||
        source.templateVersion !== 1 ||
        source.rawRecordCount !== EXPECTED_RECORD_COUNT ||
        source.rawChecksum.toString("hex") !== EXPECTED_RAW_SHA256 ||
        source.rawObjectKey !== `qualification/operations/${input.packetId}/raw.json` ||
        Number.isNaN(source.completedAt.valueOf())
      ) {
        throw new MarketplaceProviderSampleError("MARKETPLACE_PROVIDER_SAMPLE_SOURCE_INVALID");
      }
      let datasetId: string;
      try {
        datasetId = await dependencies.protector.reveal(
          source.providerResourceCiphertext,
          source.providerResourceFingerprint,
          catalogueAad(source.environment),
        );
      } catch (cause) {
        throw new MarketplaceProviderSampleError("MARKETPLACE_PROVIDER_SAMPLE_SOURCE_INVALID", cause);
      }
      const metadataObjectKey =
        `qualification/operations/${input.packetId}/dataset-metadata.json`;
      let raw;
      let metadata;
      try {
        [raw, metadata] = await Promise.all([
          dependencies.qualificationStore.open({
            objectKey: source.rawObjectKey,
            maxBytes: dependencies.maxBytes,
          }),
          dependencies.qualificationStore.open({
            objectKey: metadataObjectKey,
            maxBytes: dependencies.maxBytes,
          }),
        ]);
      } catch (cause) {
        throw new MarketplaceProviderSampleError("MARKETPLACE_PROVIDER_SAMPLE_STORAGE_FAILURE", cause);
      }
      if (
        raw.contentType !== source.rawContentType ||
        raw.byteCount !== source.rawByteCount ||
        raw.checksumHex !== EXPECTED_RAW_SHA256 ||
        metadata.contentType !== "application/json" ||
        metadata.checksumHex !== EXPECTED_METADATA_SHA256
      ) {
        throw new MarketplaceProviderSampleError(
          "MARKETPLACE_PROVIDER_SAMPLE_STORAGE_INTEGRITY_FAILURE",
        );
      }
      const dictionary = parseMetadata(metadata.bytes, datasetId);
      const records = validateRecords(raw.bytes, dictionary);
      if (records.length !== source.rawRecordCount) {
        throw new MarketplaceProviderSampleError(
          "MARKETPLACE_PROVIDER_SAMPLE_STORAGE_INTEGRITY_FAILURE",
        );
      }
      const sampleId = uuid();
      if (!UUID.test(sampleId) || !UUID.test(source.templateVersionId)) {
        throw new MarketplaceProviderSampleError("MARKETPLACE_PROVIDER_SAMPLE_CONFIGURATION_INVALID");
      }
      const objectKey =
        `marketplace/samples/${source.templateVersionId}/${input.sampleVersion}/${raw.checksumHex}.json`;
      let receipt;
      try {
        receipt = await dependencies.sampleStore.putImmutable({
          objectKey,
          bytes: raw.bytes,
          contentType: "application/json",
          maxBytes: dependencies.maxBytes,
        });
      } catch (cause) {
        throw new MarketplaceProviderSampleError("MARKETPLACE_PROVIDER_SAMPLE_STORAGE_FAILURE", cause);
      }
      if (
        receipt.objectKey !== objectKey ||
        receipt.byteCount !== raw.byteCount ||
        receipt.checksumHex !== raw.checksumHex ||
        receipt.contentType !== "application/json"
      ) {
        throw new MarketplaceProviderSampleError(
          "MARKETPLACE_PROVIDER_SAMPLE_STORAGE_INTEGRITY_FAILURE",
        );
      }
      let recorded;
      try {
        recorded = await dependencies.repository.recordProviderSample({
          sampleId,
          packetId: source.packetId,
          templateVersionId: source.templateVersionId,
          sampleVersion: input.sampleVersion,
          objectKey,
          recordCount: source.rawRecordCount,
          byteCount: source.rawByteCount,
          checksum: source.rawChecksum,
          metadataChecksum: Buffer.from(metadata.checksumHex, "hex"),
          fieldDictionary: dictionary,
          interimDecisionReference: LINKEDIN_POSTS_PROVIDER_SAMPLE_DECISION_REFERENCE,
          actor: input.actor,
        });
      } catch (cause) {
        throw new MarketplaceProviderSampleError("MARKETPLACE_PROVIDER_SAMPLE_DATABASE_FAILURE", cause);
      }
      return Object.freeze({
        sample_id: recorded.sampleId,
        sample_version: input.sampleVersion,
        source_kind: "provider_qualification" as const,
        state: "validated_provider_sample" as const,
        governance_state: "formal_agreement_pending_local_demo" as const,
        record_count: source.rawRecordCount,
        field_count: dictionary.length,
        masked_field_count: dictionary.filter((field) => field.sample_visibility === "masked").length,
        byte_count: source.rawByteCount,
        checksum: source.rawChecksum.toString("hex"),
        metadata_checksum: metadata.checksumHex,
        expires_at: recorded.expiresAt.toISOString(),
        disposition: recorded.disposition,
        provider_calls: 0 as const,
      });
    },
  });
}
