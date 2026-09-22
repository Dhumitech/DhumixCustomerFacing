import type { Readable } from "node:stream";
import Ajv2020Module, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import {
  AMAZON_PRECISE_OUTPUT_CONTRACTS,
  getAmazonPreciseOutputContract,
} from "./amazonOutputContracts.js";

const ACCEPTED_MEDIA_TYPES = new Set(["application/json", "text/plain"]);

export class AmazonResultNormalizationError extends Error {
  public constructor(cause?: unknown) {
    super(
      "Pinned Amazon result contract was invalid",
      cause === undefined ? undefined : { cause },
    );
    this.name = "AmazonResultNormalizationError";
  }
}

export class AmazonResultContractUnavailableError extends Error {
  public constructor() {
    super("Precise Amazon output contract was unavailable");
    this.name = "AmazonResultContractUnavailableError";
  }
}

async function boundedBytes(bytes: Readable, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new AmazonResultNormalizationError();
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of bytes) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += part.byteLength;
      if (total > maxBytes) {
        bytes.destroy();
        throw new AmazonResultNormalizationError();
      }
      chunks.push(part);
    }
  } catch (error) {
    if (error instanceof AmazonResultNormalizationError) throw error;
    throw new AmazonResultNormalizationError(error);
  }
  return Buffer.concat(chunks, total);
}

function parseObservedArray(bytes: Buffer): readonly Readonly<Record<string, unknown>>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new AmazonResultNormalizationError(error);
  }
  if (!Array.isArray(parsed)) throw new AmazonResultNormalizationError();
  for (const item of parsed) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new AmazonResultNormalizationError();
    }
  }
  return parsed as readonly Readonly<Record<string, unknown>>[];
}

function hasProviderError(record: Readonly<Record<string, unknown>>): boolean {
  return Object.prototype.hasOwnProperty.call(record, "error") ||
    Object.prototype.hasOwnProperty.call(record, "error_code");
}

function createValidators(): ReadonlyMap<string, ValidateFunction> {
  const Ajv2020 = Ajv2020Module as unknown as new (
    options: Readonly<Record<string, unknown>>,
  ) => { compile(document: object): ValidateFunction };
  const addFormats = addFormatsModule as unknown as (
    compiler: { compile(document: object): ValidateFunction },
  ) => void;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return new Map(
    AMAZON_PRECISE_OUTPUT_CONTRACTS.map((contract) => [
      contract.operationCode,
      ajv.compile(contract.outputSchema),
    ]),
  );
}

const validators = createValidators();

function validateEnvelope(input: {
  readonly contentType: string;
  readonly contentEncoding: string | null;
  readonly bytes: Readable;
}): void {
  if (
    !ACCEPTED_MEDIA_TYPES.has(input.contentType.toLowerCase()) ||
    input.contentEncoding !== null
  ) {
    input.bytes.destroy();
    throw new AmazonResultNormalizationError();
  }
}

export async function inspectAmazonProviderResult(input: {
  readonly bytes: Readable;
  readonly contentType: string;
  readonly contentEncoding: string | null;
  readonly maxBytes: number;
}): Promise<Readonly<{ recordCount: number; providerErrorCount: number }>> {
  validateEnvelope(input);
  const raw = await boundedBytes(input.bytes, input.maxBytes);
  const records = parseObservedArray(raw);
  return Object.freeze({
    recordCount: records.length,
    providerErrorCount: records.filter(hasProviderError).length,
  });
}

export async function normalizeAmazonProviderResult(input: {
  readonly operationCode: string;
  readonly bytes: Readable;
  readonly contentType: string;
  readonly contentEncoding: string | null;
  readonly maxBytes: number;
}): Promise<Readonly<{
  bytes: Buffer;
  contentType: "application/json";
  contentEncoding: null;
  schemaVersion: string;
  recordCount: number;
}>> {
  const contract = getAmazonPreciseOutputContract(input.operationCode);
  if (contract === undefined) {
    input.bytes.destroy();
    throw new AmazonResultContractUnavailableError();
  }

  validateEnvelope(input);
  const raw = await boundedBytes(input.bytes, input.maxBytes);
  const records = parseObservedArray(raw);
  if (records.some(hasProviderError)) throw new AmazonResultNormalizationError();
  const projected = contract.projectedFields.length === 0
    ? records
    : records.map((record) => Object.fromEntries(
        contract.projectedFields.map((field) => [field, record[field]]),
      ));
  const validate = validators.get(input.operationCode);
  if (validate === undefined || !validate(projected)) {
    throw new AmazonResultNormalizationError();
  }
  return Object.freeze({
    bytes: Buffer.from(JSON.stringify(projected), "utf8"),
    contentType: "application/json" as const,
    contentEncoding: null,
    schemaVersion: contract.schemaVersion,
    recordCount: projected.length,
  });
}
