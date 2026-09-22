import { createHash, randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import type {
  MarketplaceSampleRepository,
} from "./marketplaceSampleRepository.js";
import type { MarketplaceSampleStore } from "./marketplaceSampleStore.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$/;
const POLICY_VERSION_PATTERN = /^[a-z][a-z0-9._-]{2,127}$/;
const FIXTURE_PROVENANCE_PATTERN = /^fixture:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{6,1014}$/;
const MASKED_VALUE_PATTERN = /\*{3,}/;
const THIRTY_DAYS_IN_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;
// Exact SHA-256 of the reviewed two-field synthetic fixture metadata. A newer
// provider metadata snapshot must not be mislabeled with the legacy dictionary.
const LINKEDIN_POSTS_FIXTURE_METADATA_SHA256 =
  "c210bf596129141cee74e7d4b339fc70b12fd4117201c693116073bcdde7d3a4";

export const LINKEDIN_POSTS_SAMPLE_MASKING_POLICY_VERSION =
  "linkedin-posts-provider-mask-preservation-v1";
export const LINKEDIN_POSTS_SAMPLE_RETENTION_POLICY_VERSION =
  "linkedin-posts-sample-30d-v1";

export type MarketplaceSampleErrorCode =
  | "MARKETPLACE_SAMPLE_CONFIGURATION_INVALID"
  | "MARKETPLACE_SAMPLE_INPUT_INVALID"
  | "MARKETPLACE_SAMPLE_METADATA_INVALID"
  | "MARKETPLACE_SAMPLE_METADATA_MISMATCH"
  | "MARKETPLACE_SAMPLE_SCHEMA_INVALID"
  | "MARKETPLACE_SAMPLE_STORAGE_FAILURE"
  | "MARKETPLACE_SAMPLE_STORAGE_INTEGRITY_FAILURE"
  | "MARKETPLACE_SAMPLE_DATABASE_FAILURE";

export class MarketplaceSampleError extends Error {
  public readonly code: MarketplaceSampleErrorCode;

  public constructor(code: MarketplaceSampleErrorCode, cause?: unknown) {
    super(
      "Marketplace sample ingestion failed",
      cause === undefined ? undefined : { cause },
    );
    this.name = "MarketplaceSampleError";
    this.code = code;
  }
}

interface MetadataField {
  readonly type: "url" | "text";
  readonly active: true;
  readonly required: boolean;
}

interface Dependencies {
  readonly repository: MarketplaceSampleRepository;
  readonly store: MarketplaceSampleStore;
  readonly maxBytes: number;
  readonly uuid?: () => string;
}

export interface MarketplaceSampleService {
  ingestFixture(input: {
    readonly templateSlug: "linkedin-posts";
    readonly templateVersion: number;
    readonly sampleVersion: number;
    readonly sampleBytes: Buffer;
    readonly metadataBytes: Buffer;
    readonly collectedAt: Date;
    readonly expiresAt: Date;
    readonly schemaVersion: number;
    readonly maskingPolicyVersion: string;
    readonly retentionPolicyVersion: string;
    readonly provenanceEvidenceReference: string;
    readonly actor: string;
  }): Promise<{
    readonly sampleId: string;
    readonly templateSlug: "linkedin-posts";
    readonly templateVersion: number;
    readonly sampleVersion: number;
    readonly state: "validated_fixture";
    readonly recordCount: number;
    readonly byteCount: number;
    readonly checksum: string;
    readonly expiresAt: string;
    readonly disposition: "created" | "existing";
  }>;
  inspectFixture(input: {
    readonly templateSlug: "linkedin-posts";
    readonly templateVersion: number;
    readonly sampleVersion: number;
    readonly metadataBytes: Buffer;
    readonly asOf: Date;
  }): Promise<{
    readonly sampleId: string;
    readonly templateSlug: "linkedin-posts";
    readonly templateVersion: number;
    readonly sampleVersion: number;
    readonly records: readonly Readonly<Record<string, string>>[];
    readonly maskedFields: readonly string[];
    readonly recordCount: number;
    readonly byteCount: number;
    readonly checksum: string;
    readonly collectedAt: string;
    readonly expiresAt: string;
    readonly sourceKind: "synthetic_fixture";
  }>;
  expireFixtures(input: {
    readonly asOf: Date;
    readonly limit: number;
    readonly actor: string;
  }): Promise<{
    readonly examined: number;
    readonly deleted: number;
    readonly alreadyAbsent: number;
  }>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(bytes: Buffer, code: MarketplaceSampleErrorCode): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new MarketplaceSampleError(code, error);
  }
}

function parseFields(metadataBytes: Buffer): ReadonlyMap<string, MetadataField> {
  const metadata = parseJson(metadataBytes, "MARKETPLACE_SAMPLE_METADATA_INVALID");
  if (!isObject(metadata) || !isObject(metadata.fields)) {
    throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_METADATA_INVALID");
  }
  const fields = new Map<string, MetadataField>();
  for (const [name, raw] of Object.entries(metadata.fields)) {
    if (
      !/^[a-z][a-z0-9_]{0,127}$/.test(name) ||
      !isObject(raw) ||
      (raw.type !== "url" && raw.type !== "text") ||
      raw.active !== true ||
      typeof raw.required !== "boolean"
    ) {
      throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_METADATA_INVALID");
    }
    fields.set(name, { type: raw.type, active: true, required: raw.required });
  }
  if (fields.size === 0) {
    throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_METADATA_INVALID");
  }
  return fields;
}

function validHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function validateRecords(
  sampleBytes: Buffer,
  fields: ReadonlyMap<string, MetadataField>,
): readonly Readonly<Record<string, string>>[] {
  const value = parseJson(sampleBytes, "MARKETPLACE_SAMPLE_SCHEMA_INVALID");
  if (!Array.isArray(value) || value.length === 0) {
    throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_SCHEMA_INVALID");
  }
  for (const record of value) {
    if (!isObject(record)) {
      throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_SCHEMA_INVALID");
    }
    for (const field of fields.keys()) {
      const definition = fields.get(field) as MetadataField;
      if (definition.required && !(field in record)) {
        throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_SCHEMA_INVALID");
      }
    }
    for (const [field, fieldValue] of Object.entries(record)) {
      const definition = fields.get(field);
      if (definition === undefined || typeof fieldValue !== "string") {
        throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_SCHEMA_INVALID");
      }
      if (definition.type === "url" && !validHttpUrl(fieldValue)) {
        throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_SCHEMA_INVALID");
      }
    }
  }
  return value as readonly Readonly<Record<string, string>>[];
}

function validateInput(
  input: Parameters<MarketplaceSampleService["ingestFixture"]>[0],
  maximumBytes: number,
): void {
  if (
    input.templateSlug !== "linkedin-posts" ||
    input.templateVersion !== 1 ||
    !Number.isSafeInteger(input.sampleVersion) ||
    input.sampleVersion < 1 ||
    !Number.isSafeInteger(input.schemaVersion) ||
    input.schemaVersion < 1 ||
    !Buffer.isBuffer(input.sampleBytes) ||
    input.sampleBytes.byteLength < 2 ||
    input.sampleBytes.byteLength > maximumBytes ||
    !Buffer.isBuffer(input.metadataBytes) ||
    input.metadataBytes.byteLength < 2 ||
    input.metadataBytes.byteLength > maximumBytes ||
    !ACTOR_PATTERN.test(input.actor) ||
    !POLICY_VERSION_PATTERN.test(input.maskingPolicyVersion) ||
    input.maskingPolicyVersion !== LINKEDIN_POSTS_SAMPLE_MASKING_POLICY_VERSION ||
    !POLICY_VERSION_PATTERN.test(input.retentionPolicyVersion) ||
    input.retentionPolicyVersion !== LINKEDIN_POSTS_SAMPLE_RETENTION_POLICY_VERSION ||
    !FIXTURE_PROVENANCE_PATTERN.test(input.provenanceEvidenceReference) ||
    Number.isNaN(input.collectedAt.valueOf()) ||
    Number.isNaN(input.expiresAt.valueOf()) ||
    input.expiresAt.valueOf() - input.collectedAt.valueOf() !==
      THIRTY_DAYS_IN_MILLISECONDS
  ) {
    throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_INPUT_INVALID");
  }
}

export function createMarketplaceSampleService(
  dependencies: Dependencies,
): MarketplaceSampleService {
  if (!Number.isSafeInteger(dependencies.maxBytes) || dependencies.maxBytes < 2) {
    throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_CONFIGURATION_INVALID");
  }
  const uuid = dependencies.uuid ?? randomUUID;
  return Object.freeze({
    async ingestFixture(input: Parameters<MarketplaceSampleService["ingestFixture"]>[0]) {
      validateInput(input, dependencies.maxBytes);
      const metadataChecksum = createHash("sha256").update(input.metadataBytes).digest();
      if (metadataChecksum.toString("hex") !== LINKEDIN_POSTS_FIXTURE_METADATA_SHA256) {
        throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_METADATA_INVALID");
      }
      let target;
      try {
        target = await dependencies.repository.resolveTarget({
          templateSlug: input.templateSlug,
          templateVersion: input.templateVersion,
        });
      } catch (error) {
        throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_DATABASE_FAILURE", error);
      }
      if (!metadataChecksum.equals(target.metadataChecksum)) {
        throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_METADATA_MISMATCH");
      }
      const fields = parseFields(input.metadataBytes);
      const records = validateRecords(input.sampleBytes, fields);
      const recordCount = records.length;
      const checksum = createHash("sha256").update(input.sampleBytes).digest();
      const sampleId = uuid();
      if (!UUID_PATTERN.test(sampleId) || !UUID_PATTERN.test(target.templateVersionId)) {
        throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_CONFIGURATION_INVALID");
      }
      const objectKey =
        `marketplace/samples/${target.templateVersionId}/${input.sampleVersion}/${checksum.toString("hex")}.json`;
      let receipt;
      try {
        receipt = await dependencies.store.putImmutable({
          objectKey,
          bytes: input.sampleBytes,
          contentType: "application/json",
          maxBytes: dependencies.maxBytes,
        });
      } catch (error) {
        throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_STORAGE_FAILURE", error);
      }
      if (
        receipt.objectKey !== objectKey ||
        receipt.contentType !== "application/json" ||
        receipt.byteCount !== input.sampleBytes.byteLength ||
        receipt.checksumHex !== checksum.toString("hex")
      ) {
        throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_STORAGE_INTEGRITY_FAILURE");
      }
      try {
        const opened = await dependencies.store.open(objectKey, dependencies.maxBytes);
        if (
          opened.receipt.objectKey !== receipt.objectKey ||
          opened.receipt.byteCount !== input.sampleBytes.byteLength ||
          opened.receipt.checksumHex !== checksum.toString("hex") ||
          !opened.bytes.equals(input.sampleBytes)
        ) {
          throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_STORAGE_INTEGRITY_FAILURE");
        }
      } catch (error) {
        if (error instanceof MarketplaceSampleError) throw error;
        throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_STORAGE_INTEGRITY_FAILURE", error);
      }
      let recorded;
      try {
        recorded = await dependencies.repository.recordFixture({
          sampleId,
          templateVersionId: target.templateVersionId,
          sampleVersion: input.sampleVersion,
          objectKey,
          contentType: "application/json",
          recordCount,
          byteCount: receipt.byteCount,
          checksum,
          metadataChecksum,
          schemaVersion: input.schemaVersion,
          maskingPolicyVersion: input.maskingPolicyVersion,
          retentionPolicyVersion: input.retentionPolicyVersion,
          provenanceEvidenceReference: input.provenanceEvidenceReference,
          rightsEvidenceReference: null,
          collectedAt: input.collectedAt,
          publishedAt: null,
          expiresAt: input.expiresAt,
          sourceKind: "synthetic_fixture",
          state: "validated_fixture",
          actor: input.actor,
        });
      } catch (error) {
        throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_DATABASE_FAILURE", error);
      }
      return Object.freeze({
        sampleId: recorded.sampleId,
        templateSlug: target.templateSlug,
        templateVersion: target.templateVersion,
        sampleVersion: input.sampleVersion,
        state: "validated_fixture" as const,
        recordCount,
        byteCount: receipt.byteCount,
        checksum: checksum.toString("hex"),
        expiresAt: input.expiresAt.toISOString(),
        disposition: recorded.disposition,
      });
    },

    async inspectFixture(input: Parameters<MarketplaceSampleService["inspectFixture"]>[0]) {
      if (
        input.templateSlug !== "linkedin-posts" ||
        input.templateVersion !== 1 ||
        !Number.isSafeInteger(input.sampleVersion) ||
        input.sampleVersion < 1 ||
        !Buffer.isBuffer(input.metadataBytes) ||
        input.metadataBytes.byteLength < 2 ||
        input.metadataBytes.byteLength > dependencies.maxBytes ||
        Number.isNaN(input.asOf.valueOf())
      ) {
        throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_INPUT_INVALID");
      }
      const metadataChecksum = createHash("sha256").update(input.metadataBytes).digest();
      const fields = parseFields(input.metadataBytes);
      let fixture;
      try {
        fixture = await dependencies.repository.resolveFixture(input);
      } catch (error) {
        throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_DATABASE_FAILURE", error);
      }
      if (
        !metadataChecksum.equals(fixture.metadataChecksum) ||
        fixture.maskingPolicyVersion !== LINKEDIN_POSTS_SAMPLE_MASKING_POLICY_VERSION ||
        fixture.retentionPolicyVersion !== LINKEDIN_POSTS_SAMPLE_RETENTION_POLICY_VERSION ||
        fixture.expiresAt.valueOf() - fixture.collectedAt.valueOf() !==
          THIRTY_DAYS_IN_MILLISECONDS
      ) {
        throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_METADATA_MISMATCH");
      }
      let opened;
      try {
        opened = await dependencies.store.open(fixture.objectKey, dependencies.maxBytes);
      } catch (error) {
        throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_STORAGE_FAILURE", error);
      }
      if (
        opened.receipt.objectKey !== fixture.objectKey ||
        opened.receipt.contentType !== fixture.contentType ||
        opened.receipt.byteCount !== fixture.byteCount ||
        opened.receipt.checksumHex !== fixture.checksum.toString("hex") ||
        opened.bytes.byteLength !== fixture.byteCount ||
        !createHash("sha256").update(opened.bytes).digest().equals(fixture.checksum)
      ) {
        throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_STORAGE_INTEGRITY_FAILURE");
      }
      const records = validateRecords(opened.bytes, fields);
      if (records.length !== fixture.recordCount) {
        throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_STORAGE_INTEGRITY_FAILURE");
      }
      const maskedFields = [...new Set(
        records.flatMap((record) => Object.entries(record)
          .filter(([, value]) => MASKED_VALUE_PATTERN.test(value))
          .map(([field]) => field)),
      )].sort();
      return Object.freeze({
        sampleId: fixture.sampleId,
        templateSlug: input.templateSlug,
        templateVersion: input.templateVersion,
        sampleVersion: input.sampleVersion,
        records,
        maskedFields,
        recordCount: fixture.recordCount,
        byteCount: fixture.byteCount,
        checksum: fixture.checksum.toString("hex"),
        collectedAt: fixture.collectedAt.toISOString(),
        expiresAt: fixture.expiresAt.toISOString(),
        sourceKind: "synthetic_fixture" as const,
      });
    },

    async expireFixtures(input: Parameters<MarketplaceSampleService["expireFixtures"]>[0]) {
      if (
        Number.isNaN(input.asOf.valueOf()) ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 1000 ||
        !ACTOR_PATTERN.test(input.actor)
      ) {
        throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_INPUT_INVALID");
      }
      let fixtures;
      try {
        fixtures = await dependencies.repository.listExpiredFixtures({
          asOf: input.asOf,
          limit: input.limit,
        });
      } catch (error) {
        throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_DATABASE_FAILURE", error);
      }
      let deleted = 0;
      let alreadyAbsent = 0;
      for (const fixture of fixtures) {
        let storage;
        try {
          storage = await dependencies.store.deleteAndVerify(fixture.objectKey);
        } catch (error) {
          throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_STORAGE_FAILURE", error);
        }
        try {
          await dependencies.repository.recordFixtureDeletion({
            sampleId: fixture.sampleId,
            deletedAt: input.asOf,
            storageDisposition: storage.disposition,
            actor: input.actor,
          });
        } catch (error) {
          throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_DATABASE_FAILURE", error);
        }
        if (storage.disposition === "deleted") deleted += 1;
        else alreadyAbsent += 1;
      }
      return Object.freeze({ examined: fixtures.length, deleted, alreadyAbsent });
    },
  });
}
