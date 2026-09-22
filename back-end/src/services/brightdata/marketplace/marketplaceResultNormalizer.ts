import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import Ajv2020Module, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

const JSON_MEDIA_TYPE = "application/json";
const MAX_SELECTED_FIELDS = 100;
const MAX_CONTRACT_FIELDS = 10_000;

export type MarketplaceOutputSchemaDocument = Readonly<Record<string, unknown>>;

export interface MarketplaceNormalizedOutputContract {
  readonly templateSlug: string;
  readonly templateVersion: number;
  readonly normalizerCode: string;
  readonly normalizerVersion: number;
  readonly schemaVersion: string;
  readonly fieldSchemas: Readonly<Record<string, MarketplaceOutputSchemaDocument>>;
}

export class MarketplaceOutputContractError extends Error {
  public constructor(cause?: unknown) {
    super(
      "Marketplace normalized-output contract was invalid",
      cause === undefined ? undefined : { cause },
    );
    this.name = "MarketplaceOutputContractError";
  }
}

export class MarketplaceResultNormalizationError extends Error {
  public constructor(cause?: unknown) {
    super(
      "Marketplace provider result did not satisfy the pinned output contract",
      cause === undefined ? undefined : { cause },
    );
    this.name = "MarketplaceResultNormalizationError";
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function schemaObject(value: unknown): value is MarketplaceOutputSchemaDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createAjv(): {
  compile(document: object): ValidateFunction;
} {
  const Ajv2020 = Ajv2020Module as unknown as new (
    options: Readonly<Record<string, unknown>>,
  ) => { compile(document: object): ValidateFunction };
  const addFormats = addFormatsModule as unknown as (
    compiler: { compile(document: object): ValidateFunction },
  ) => void;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv;
}

function projectedSchema(
  contract: MarketplaceNormalizedOutputContract,
  selectedFields: readonly string[],
): MarketplaceOutputSchemaDocument {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `urn:dhumi:schema:${contract.schemaVersion}:projection`,
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: selectedFields,
      properties: Object.fromEntries(
        selectedFields.map((name) => [name, contract.fieldSchemas[name]]),
      ),
    },
  };
}

export function createMarketplaceNormalizedOutputContract(
  input: MarketplaceNormalizedOutputContract,
): MarketplaceNormalizedOutputContract {
  const fields = Object.entries(input.fieldSchemas);
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.templateSlug) ||
    !Number.isSafeInteger(input.templateVersion) ||
    input.templateVersion < 1 ||
    input.normalizerCode.trim() !== input.normalizerCode ||
    input.normalizerCode.length < 1 ||
    input.normalizerCode.length > 128 ||
    !Number.isSafeInteger(input.normalizerVersion) ||
    input.normalizerVersion < 1 ||
    input.schemaVersion.trim() !== input.schemaVersion ||
    input.schemaVersion.length < 1 ||
    input.schemaVersion.length > 128 ||
    fields.length < 1 ||
    fields.length > MAX_CONTRACT_FIELDS
  ) {
    throw new MarketplaceOutputContractError();
  }

  const copiedFields: Record<string, MarketplaceOutputSchemaDocument> =
    Object.create(null) as Record<string, MarketplaceOutputSchemaDocument>;
  const ajv = createAjv();
  for (const [name, schema] of fields) {
    if (name.length < 1 || name.length > 256 || !schemaObject(schema)) {
      throw new MarketplaceOutputContractError();
    }
    try {
      ajv.compile(schema);
    } catch (cause) {
      throw new MarketplaceOutputContractError(cause);
    }
    copiedFields[name] = structuredClone(schema);
  }

  return deepFreeze({
    templateSlug: input.templateSlug,
    templateVersion: input.templateVersion,
    normalizerCode: input.normalizerCode,
    normalizerVersion: input.normalizerVersion,
    schemaVersion: input.schemaVersion,
    fieldSchemas: copiedFields,
  });
}

function resolveSelection(
  contract: MarketplaceNormalizedOutputContract,
  selectedFields: readonly string[],
): readonly string[] {
  if (
    selectedFields.length < 1 ||
    selectedFields.length > MAX_SELECTED_FIELDS ||
    new Set(selectedFields).size !== selectedFields.length
  ) {
    throw new MarketplaceOutputContractError();
  }
  for (const field of selectedFields) {
    if (
      typeof field !== "string" ||
      !Object.prototype.hasOwnProperty.call(contract.fieldSchemas, field)
    ) {
      throw new MarketplaceOutputContractError();
    }
  }
  return Object.freeze([...selectedFields]);
}

function projectionFingerprint(input: {
  readonly contract: MarketplaceNormalizedOutputContract;
  readonly selectedFields: readonly string[];
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      template_slug: input.contract.templateSlug,
      template_version: input.contract.templateVersion,
      schema_version: input.contract.schemaVersion,
      selected_fields: input.selectedFields,
    }), "utf8")
    .digest("hex");
}

async function boundedBytes(bytes: Readable, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 2) {
    bytes.destroy();
    throw new MarketplaceResultNormalizationError();
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of bytes) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += part.byteLength;
      if (total > maxBytes) {
        bytes.destroy();
        throw new MarketplaceResultNormalizationError();
      }
      chunks.push(part);
    }
  } catch (cause) {
    if (cause instanceof MarketplaceResultNormalizationError) throw cause;
    throw new MarketplaceResultNormalizationError(cause);
  }
  return Buffer.concat(chunks, total);
}

function records(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  const rows = Array.isArray(value) ? value : [value];
  if (rows.some((row) => !schemaObject(row))) {
    throw new MarketplaceResultNormalizationError();
  }
  return rows as readonly Readonly<Record<string, unknown>>[];
}

export async function normalizeMarketplaceProviderResult(input: {
  readonly contract: MarketplaceNormalizedOutputContract;
  readonly selectedFields: readonly string[];
  readonly bytes: Readable;
  readonly contentType: string;
  readonly contentEncoding: string | null;
  readonly maxBytes: number;
}): Promise<Readonly<{
  bytes: Buffer;
  contentType: typeof JSON_MEDIA_TYPE;
  contentEncoding: null;
  schemaVersion: string;
  projectionFingerprint: string;
  selectedFields: readonly string[];
  recordCount: number;
}>> {
  let selected: readonly string[];
  try {
    selected = resolveSelection(input.contract, input.selectedFields);
  } catch (cause) {
    input.bytes.destroy();
    throw cause;
  }
  if (
    input.contentType.toLowerCase() !== JSON_MEDIA_TYPE ||
    input.contentEncoding !== null
  ) {
    input.bytes.destroy();
    throw new MarketplaceResultNormalizationError();
  }

  const raw = await boundedBytes(input.bytes, input.maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (cause) {
    throw new MarketplaceResultNormalizationError(cause);
  }

  const projected = records(parsed).map((row) => Object.fromEntries(
    selected.map((field) => [field,
      Object.prototype.hasOwnProperty.call(row, field) ? row[field] : null]),
  ));

  let validate: ValidateFunction;
  try {
    validate = createAjv().compile(projectedSchema(input.contract, selected));
  } catch (cause) {
    throw new MarketplaceOutputContractError(cause);
  }
  if (!validate(projected)) {
    throw new MarketplaceResultNormalizationError();
  }

  return Object.freeze({
    bytes: Buffer.from(JSON.stringify(projected), "utf8"),
    contentType: JSON_MEDIA_TYPE,
    contentEncoding: null,
    schemaVersion: input.contract.schemaVersion,
    projectionFingerprint: projectionFingerprint({
      contract: input.contract,
      selectedFields: selected,
    }),
    selectedFields: selected,
    recordCount: projected.length,
  });
}
