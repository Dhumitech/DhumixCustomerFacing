const PROVIDER_ORIGIN = "https://api.brightdata.com";
const DATASET_ID_PATTERN = /^gd_[a-z0-9]{8,128}$/;
const JSON_MEDIA_TYPE = "application/json";
const MAX_DATASETS = 10_000;
const MAX_FIELDS = 10_000;

export type MarketplaceCatalogueFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type MarketplaceCatalogueBoundaryErrorCode =
  | "MARKETPLACE_CATALOGUE_CONFIGURATION_INVALID"
  | "MARKETPLACE_CATALOGUE_CREDENTIAL_REJECTED"
  | "MARKETPLACE_CATALOGUE_RESOURCE_NOT_FOUND"
  | "MARKETPLACE_CATALOGUE_RATE_LIMITED"
  | "MARKETPLACE_CATALOGUE_RESPONSE_INVALID"
  | "MARKETPLACE_CATALOGUE_UNAVAILABLE";

export class MarketplaceCatalogueBoundaryError extends Error {
  public readonly code: MarketplaceCatalogueBoundaryErrorCode;
  public readonly retryable: boolean;

  public constructor(input: {
    readonly code: MarketplaceCatalogueBoundaryErrorCode;
    readonly retryable: boolean;
    readonly cause?: unknown;
  }) {
    super(
      "Private Marketplace catalogue operation failed",
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.name = "MarketplaceCatalogueBoundaryError";
    this.code = input.code;
    this.retryable = input.retryable;
  }
}

export interface MarketplaceDatasetListItem {
  readonly id: string;
  readonly name: string;
  readonly size: number | null;
}

export interface MarketplaceDatasetFieldMetadata {
  readonly type: string;
  readonly active?: boolean;
  readonly required?: boolean;
  readonly description?: string;
}

export interface MarketplaceDatasetMetadata {
  readonly id: string;
  readonly fields: Readonly<Record<string, MarketplaceDatasetFieldMetadata>>;
}

export interface MarketplaceCatalogueDocument<T> {
  readonly value: T;
  readonly bytes: Buffer;
  readonly contentType: typeof JSON_MEDIA_TYPE;
}

export interface MarketplaceDatasetCatalogueClient {
  listDatasets(input: {
    readonly apiKey: string;
    readonly signal: AbortSignal;
  }): Promise<MarketplaceCatalogueDocument<readonly MarketplaceDatasetListItem[]>>;
  getDatasetMetadata(input: {
    readonly apiKey: string;
    readonly datasetId: string;
    readonly signal: AbortSignal;
  }): Promise<MarketplaceCatalogueDocument<MarketplaceDatasetMetadata>>;
}

interface Dependencies {
  readonly requestTimeoutMs: number;
  readonly responseMaxBytes: number;
  readonly fetch?: MarketplaceCatalogueFetch;
}

function boundaryError(
  code: MarketplaceCatalogueBoundaryErrorCode,
  retryable = false,
  cause?: unknown,
): MarketplaceCatalogueBoundaryError {
  return new MarketplaceCatalogueBoundaryError({
    code,
    retryable,
    ...(cause === undefined ? {} : { cause }),
  });
}

function validateApiKey(value: string): void {
  if (value.trim() !== value || value.length < 8 || value.length > 4096) {
    throw boundaryError("MARKETPLACE_CATALOGUE_CONFIGURATION_INVALID");
  }
}

function validateDatasetId(value: string): void {
  if (!DATASET_ID_PATTERN.test(value)) {
    throw boundaryError("MARKETPLACE_CATALOGUE_CONFIGURATION_INVALID");
  }
}

function classifyStatus(status: number): MarketplaceCatalogueBoundaryError {
  if (status === 401 || status === 403) {
    return boundaryError("MARKETPLACE_CATALOGUE_CREDENTIAL_REJECTED");
  }
  if (status === 404) {
    return boundaryError("MARKETPLACE_CATALOGUE_RESOURCE_NOT_FOUND");
  }
  if (status === 429) {
    return boundaryError("MARKETPLACE_CATALOGUE_RATE_LIMITED", true);
  }
  return boundaryError("MARKETPLACE_CATALOGUE_UNAVAILABLE", status >= 500);
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The provider body is intentionally discarded and never added to logs.
  }
}

function validateContentLength(response: Response, maximum: number): void {
  const raw = response.headers.get("content-length");
  if (raw === null) return;
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw boundaryError("MARKETPLACE_CATALOGUE_RESPONSE_INVALID");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw boundaryError("MARKETPLACE_CATALOGUE_RESPONSE_INVALID");
  }
}

async function readBoundedJson(response: Response, maximum: number): Promise<{
  readonly bytes: Buffer;
  readonly parsed: unknown;
}> {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== JSON_MEDIA_TYPE || response.body === null) {
    await discard(response);
    throw boundaryError("MARKETPLACE_CATALOGUE_RESPONSE_INVALID");
  }
  validateContentLength(response, maximum);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let byteCount = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      byteCount += result.value.byteLength;
      if (byteCount > maximum) {
        await reader.cancel();
        throw boundaryError("MARKETPLACE_CATALOGUE_RESPONSE_INVALID");
      }
      chunks.push(Buffer.from(result.value));
    }
  } finally {
    reader.releaseLock();
  }
  if (byteCount < 2) throw boundaryError("MARKETPLACE_CATALOGUE_RESPONSE_INVALID");
  const bytes = Buffer.concat(chunks, byteCount);
  try {
    return { bytes, parsed: JSON.parse(bytes.toString("utf8")) as unknown };
  } catch (error) {
    throw boundaryError("MARKETPLACE_CATALOGUE_RESPONSE_INVALID", false, error);
  }
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw boundaryError("MARKETPLACE_CATALOGUE_RESPONSE_INVALID");
  }
  return value as Readonly<Record<string, unknown>>;
}

function datasetList(value: unknown): readonly MarketplaceDatasetListItem[] {
  if (!Array.isArray(value) || value.length > MAX_DATASETS) {
    throw boundaryError("MARKETPLACE_CATALOGUE_RESPONSE_INVALID");
  }
  const ids = new Set<string>();
  return Object.freeze(value.map((item) => {
    const record = object(item);
    const id = record.id;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const suppliedSize = record.size;
    if (
      typeof id !== "string" ||
      !DATASET_ID_PATTERN.test(id) ||
      ids.has(id) ||
      name.length < 1 ||
      name.length > 256 ||
      (suppliedSize !== undefined && (
        typeof suppliedSize !== "number" ||
        !Number.isSafeInteger(suppliedSize) ||
        suppliedSize < 0
      ))
    ) {
      throw boundaryError("MARKETPLACE_CATALOGUE_RESPONSE_INVALID");
    }
    ids.add(id);
    return Object.freeze({
      id,
      name,
      size: typeof suppliedSize === "number" ? suppliedSize : null,
    });
  }));
}

function fieldMetadata(value: unknown): MarketplaceDatasetFieldMetadata {
  const record = object(value);
  const type = typeof record.type === "string" ? record.type.trim() : "";
  if (
    type.length < 1 ||
    type.length > 80 ||
    (record.active !== undefined && typeof record.active !== "boolean") ||
    (record.required !== undefined && typeof record.required !== "boolean") ||
    (record.description !== undefined && (
      typeof record.description !== "string" ||
      record.description.length > 4096
    ))
  ) {
    throw boundaryError("MARKETPLACE_CATALOGUE_RESPONSE_INVALID");
  }
  return Object.freeze({
    type,
    ...(typeof record.active === "boolean" ? { active: record.active } : {}),
    ...(typeof record.required === "boolean" ? { required: record.required } : {}),
    ...(typeof record.description === "string" ? { description: record.description } : {}),
  });
}

function datasetMetadata(value: unknown, requestedId: string): MarketplaceDatasetMetadata {
  const record = object(value);
  if (record.id !== requestedId) {
    throw boundaryError("MARKETPLACE_CATALOGUE_RESPONSE_INVALID");
  }
  const fieldsRecord = object(record.fields);
  const entries = Object.entries(fieldsRecord);
  if (entries.length > MAX_FIELDS) {
    throw boundaryError("MARKETPLACE_CATALOGUE_RESPONSE_INVALID");
  }
  const fields: Record<string, MarketplaceDatasetFieldMetadata> = {};
  for (const [name, metadata] of entries) {
    if (name.length < 1 || name.length > 256) {
      throw boundaryError("MARKETPLACE_CATALOGUE_RESPONSE_INVALID");
    }
    fields[name] = fieldMetadata(metadata);
  }
  return Object.freeze({ id: requestedId, fields: Object.freeze(fields) });
}

export function createMarketplaceDatasetCatalogueClient(
  dependencies: Dependencies,
): MarketplaceDatasetCatalogueClient {
  if (
    !Number.isSafeInteger(dependencies.requestTimeoutMs) ||
    dependencies.requestTimeoutMs < 1 ||
    !Number.isSafeInteger(dependencies.responseMaxBytes) ||
    dependencies.responseMaxBytes < 2
  ) {
    throw boundaryError("MARKETPLACE_CATALOGUE_CONFIGURATION_INVALID");
  }
  const providerFetch = dependencies.fetch ?? globalThis.fetch;

  async function request(path: string, apiKey: string, signal: AbortSignal): Promise<Response> {
    validateApiKey(apiKey);
    try {
      return await providerFetch(new URL(path, PROVIDER_ORIGIN).toString(), {
        method: "GET",
        headers: { authorization: `Bearer ${apiKey}`, accept: JSON_MEDIA_TYPE },
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(dependencies.requestTimeoutMs)]),
      });
    } catch (error) {
      throw boundaryError("MARKETPLACE_CATALOGUE_UNAVAILABLE", true, error);
    }
  }

  return Object.freeze({
    async listDatasets(input: {
      readonly apiKey: string;
      readonly signal: AbortSignal;
    }) {
      const response = await request("/datasets/list", input.apiKey, input.signal);
      if (response.status !== 200) {
        await discard(response);
        throw classifyStatus(response.status);
      }
      const document = await readBoundedJson(response, dependencies.responseMaxBytes);
      return Object.freeze({
        value: datasetList(document.parsed),
        bytes: document.bytes,
        contentType: JSON_MEDIA_TYPE,
      });
    },

    async getDatasetMetadata(input: {
      readonly apiKey: string;
      readonly datasetId: string;
      readonly signal: AbortSignal;
    }) {
      validateDatasetId(input.datasetId);
      const response = await request(
        `/datasets/${input.datasetId}/metadata`,
        input.apiKey,
        input.signal,
      );
      if (response.status !== 200) {
        await discard(response);
        throw classifyStatus(response.status);
      }
      const document = await readBoundedJson(response, dependencies.responseMaxBytes);
      return Object.freeze({
        value: datasetMetadata(document.parsed, input.datasetId),
        bytes: document.bytes,
        contentType: JSON_MEDIA_TYPE,
      });
    },
  });
}

export function createFixtureMarketplaceDatasetCatalogueClient(input: {
  readonly listBytes: Buffer;
  readonly metadataBytesByDatasetName: ReadonlyMap<string, Buffer>;
}): MarketplaceDatasetCatalogueClient {
  let parsedList: readonly MarketplaceDatasetListItem[];
  try {
    parsedList = datasetList(JSON.parse(input.listBytes.toString("utf8")) as unknown);
  } catch (error) {
    if (error instanceof MarketplaceCatalogueBoundaryError) throw error;
    throw boundaryError("MARKETPLACE_CATALOGUE_RESPONSE_INVALID", false, error);
  }
  const metadataById = new Map<string, MarketplaceCatalogueDocument<MarketplaceDatasetMetadata>>();
  for (const item of parsedList) {
    const bytes = input.metadataBytesByDatasetName.get(item.name.toLowerCase());
    if (bytes === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch (error) {
      throw boundaryError("MARKETPLACE_CATALOGUE_RESPONSE_INVALID", false, error);
    }
    metadataById.set(item.id, Object.freeze({
      value: datasetMetadata(parsed, item.id),
      bytes,
      contentType: JSON_MEDIA_TYPE,
    }));
  }
  return Object.freeze({
    async listDatasets() {
      return Object.freeze({
        value: parsedList,
        bytes: input.listBytes,
        contentType: JSON_MEDIA_TYPE,
      });
    },
    async getDatasetMetadata(request: {
      readonly apiKey: string;
      readonly datasetId: string;
      readonly signal: AbortSignal;
    }) {
      validateDatasetId(request.datasetId);
      const document = metadataById.get(request.datasetId);
      if (document === undefined) {
        throw boundaryError("MARKETPLACE_CATALOGUE_RESOURCE_NOT_FOUND");
      }
      return document;
    },
  });
}
