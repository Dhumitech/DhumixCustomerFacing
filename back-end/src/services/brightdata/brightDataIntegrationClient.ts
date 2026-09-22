import { Readable, Transform } from "node:stream";

const PROVIDER_ORIGIN = "https://api.brightdata.com";
const DATASET_ID_PATTERN = /^gd_[a-z0-9]{8,128}$/;
// Bright Data currently emits both legacy/documentation `s_...` references
// and live Scrapers Library `sd_...` references. Keep the accepted grammar
// narrow because this value is later interpolated into fixed provider paths.
const SNAPSHOT_REFERENCE_PATTERN = /^s(?:d)?_[a-z0-9]{3,128}$/;
const DISCOVERY_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const CONTROL_MEDIA_TYPE = "application/json";
const RESULT_MEDIA_TYPES = new Set(["application/json", "text/plain"]);
const PROGRESS_STATES = new Set(["starting", "running", "ready", "failed", "canceled"]);

export type BrightDataFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type BrightDataBoundaryErrorCode =
  | "PROVIDER_CONFIGURATION_INVALID"
  | "PROVIDER_CREDENTIAL_UNAVAILABLE"
  | "PROVIDER_PAYMENT_REQUIRED"
  | "PROVIDER_REQUEST_REJECTED"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_SUBMISSION_UNCERTAIN"
  | "PROVIDER_RESPONSE_INVALID"
  | "PROVIDER_UNAVAILABLE";

export type BrightDataBoundarySafeReason =
  | "PROVIDER_HTTP_400"
  | "PROVIDER_HTTP_402"
  | "PROVIDER_HTTP_404"
  | "PROVIDER_SNAPSHOT_NOT_READY"
  | "PROVIDER_STATUS_UNKNOWN"
  | "PROVIDER_HTTP_422"
  | "PROVIDER_RESPONSE_SHAPE_INVALID"
  | "PROVIDER_SNAPSHOT_REFERENCE_MISSING"
  | "PROVIDER_SNAPSHOT_REFERENCE_INVALID"
  | "PROVIDER_RESULT_MEDIA_TYPE_INVALID"
  | "PROVIDER_RESULT_BODY_MISSING"
  | "PROVIDER_RESULT_ENCODING_INVALID"
  | "PROVIDER_RESULT_LENGTH_INVALID"
  | "PROVIDER_RESULT_TOO_LARGE"
  | "PROVIDER_CONTROL_MEDIA_TYPE_INVALID"
  | "PROVIDER_CONTROL_BODY_MISSING"
  | "PROVIDER_CONTROL_LENGTH_INVALID"
  | "PROVIDER_CONTROL_TOO_LARGE"
  | "PROVIDER_CONTROL_JSON_INVALID";

export class BrightDataBoundaryError extends Error {
  public readonly code: BrightDataBoundaryErrorCode;
  public readonly submissionOutcome: "known_failed" | "uncertain" | "not_applicable";
  public readonly retryable: boolean;
  public readonly safeReason?: BrightDataBoundarySafeReason;
  public readonly observedByteCount?: number;
  public readonly maximumByteCount?: number;
  public readonly retryAfterMs?: number;

  public constructor(input: {
    readonly code: BrightDataBoundaryErrorCode;
    readonly submissionOutcome: "known_failed" | "uncertain" | "not_applicable";
    readonly retryable: boolean;
    readonly safeReason?: BrightDataBoundarySafeReason;
    readonly observedByteCount?: number;
    readonly maximumByteCount?: number;
    readonly retryAfterMs?: number;
    readonly cause?: unknown;
  }) {
    super(
      "Private provider operation failed",
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.name = "BrightDataBoundaryError";
    this.code = input.code;
    this.submissionOutcome = input.submissionOutcome;
    this.retryable = input.retryable;
    if (input.safeReason !== undefined) this.safeReason = input.safeReason;
    if (input.observedByteCount !== undefined) this.observedByteCount = input.observedByteCount;
    if (input.maximumByteCount !== undefined) this.maximumByteCount = input.maximumByteCount;
    if (input.retryAfterMs !== undefined) this.retryAfterMs = input.retryAfterMs;
  }
}

interface InlineProviderResult {
  readonly kind: "inline";
  readonly bytes: Readable;
  readonly contentType: string;
  readonly contentEncoding: string | null;
}

interface SnapshotProviderResult {
  readonly kind: "snapshot";
  readonly snapshotReference: string;
  readonly retryAfterMs?: number;
}

export type BrightDataSubmissionResult = InlineProviderResult | SnapshotProviderResult;
export type BrightDataExecutionMode = "scrape" | "trigger";

export interface BrightDataIntegrationClient {
  listScrapers(input: {
    readonly apiKey: string;
    readonly signal: AbortSignal;
  }): Promise<readonly { readonly id: string; readonly name: string }[]>;
  submit(input: {
    readonly apiKey: string;
    readonly datasetId: string;
    readonly targets: readonly Readonly<Record<string, unknown>>[];
    readonly fixedQuery:
      | { readonly mode: "collect" }
      | { readonly mode: "discover"; readonly discoverBy: string };
    readonly limitPerInput?: number | null;
    readonly signal: AbortSignal;
  }): Promise<BrightDataSubmissionResult>;
  trigger(input: {
    readonly apiKey: string;
    readonly datasetId: string;
    readonly targets: readonly Readonly<Record<string, unknown>>[];
    readonly fixedQuery:
      | { readonly mode: "collect" }
      | { readonly mode: "discover"; readonly discoverBy: string };
    readonly limitPerInput?: number | null;
    readonly signal: AbortSignal;
  }): Promise<{ readonly snapshotReference: string; readonly retryAfterMs?: number }>;
  getProgress(input: {
    readonly apiKey: string;
    readonly snapshotReference: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly status: "starting" | "running" | "ready" | "failed" | "canceled" }>;
  getParts(input: {
    readonly apiKey: string;
    readonly snapshotReference: string;
    readonly format: "json";
    readonly batchSize?: number;
    readonly signal: AbortSignal;
  }): Promise<{ readonly parts: number }>;
  download(input: {
    readonly apiKey: string;
    readonly snapshotReference: string;
    readonly format: "json";
    readonly batchSize?: number;
    readonly part?: number;
    readonly signal: AbortSignal;
  }): Promise<InlineProviderResult>;
  cancel(input: {
    readonly apiKey: string;
    readonly snapshotReference: string;
    readonly signal: AbortSignal;
  }): Promise<void>;
}

interface Dependencies {
  readonly requestTimeoutMs: number;
  readonly controlResponseMaxBytes: number;
  readonly catalogueResponseMaxBytes: number;
  readonly resultMaxBytes: number;
  readonly fetch?: BrightDataFetch;
}

function mediaType(response: Response): string {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function configurationError(): BrightDataBoundaryError {
  return new BrightDataBoundaryError({
    code: "PROVIDER_CONFIGURATION_INVALID",
    submissionOutcome: "not_applicable",
    retryable: false,
  });
}

function responseError(
  safeReason: BrightDataBoundarySafeReason = "PROVIDER_RESPONSE_SHAPE_INVALID",
  byteBoundary?: Readonly<{
    observedByteCount: number;
    maximumByteCount: number;
  }>,
): BrightDataBoundaryError {
  return new BrightDataBoundaryError({
    code: "PROVIDER_RESPONSE_INVALID",
    submissionOutcome: "not_applicable",
    retryable: false,
    safeReason,
    ...(byteBoundary ?? {}),
  });
}

function validateApiKey(value: string): void {
  if (value.trim() !== value || value.length < 8 || value.length > 4096) {
    throw configurationError();
  }
}

function validateDatasetId(value: string): void {
  if (!DATASET_ID_PATTERN.test(value)) throw configurationError();
}

function validateSnapshotReference(value: string): void {
  if (!SNAPSHOT_REFERENCE_PATTERN.test(value)) throw configurationError();
}

function validateTargets(value: readonly Readonly<Record<string, unknown>>[]): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) throw configurationError();
  for (const target of value) {
    if (typeof target !== "object" || target === null || Array.isArray(target)) {
      throw configurationError();
    }
  }
}

function applyFixedQuery(
  url: URL,
  fixedQuery:
    | { readonly mode: "collect" }
    | { readonly mode: "discover"; readonly discoverBy: string },
): void {
  if (fixedQuery.mode === "discover") {
    if (!DISCOVERY_CODE_PATTERN.test(fixedQuery.discoverBy)) throw configurationError();
    url.searchParams.set("type", "discover_new");
    url.searchParams.set("discover_by", fixedQuery.discoverBy);
  }
}

function requestBody(
  targets: readonly Readonly<Record<string, unknown>>[],
  limitPerInput: number | null | undefined,
): Readonly<Record<string, unknown>> {
  validateLimitPerInput(limitPerInput);
  return {
    input: targets,
    ...(limitPerInput === undefined ? {} : { limit_per_input: limitPerInput }),
  };
}

function validateLimitPerInput(value: number | null | undefined): void {
  if (
    value !== undefined &&
    value !== null &&
    (!Number.isSafeInteger(value) || value < 1)
  ) {
    throw configurationError();
  }
}

function applyLimitPerInputQuery(url: URL, value: number | null | undefined): void {
  validateLimitPerInput(value);
  if (value !== undefined && value !== null) {
    url.searchParams.set("limit_per_input", String(value));
  }
}

function validateOptionalPositiveInteger(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
    throw configurationError();
  }
}

function snapshotReferenceFrom(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw responseError();
  }
  const reference = (value as Record<string, unknown>).snapshot_id;
  if (reference === undefined) {
    throw responseError("PROVIDER_SNAPSHOT_REFERENCE_MISSING");
  }
  if (typeof reference !== "string" || !SNAPSHOT_REFERENCE_PATTERN.test(reference)) {
    throw responseError("PROVIDER_SNAPSHOT_REFERENCE_INVALID");
  }
  return reference;
}

function resultStream(response: Response, maximum: number): InlineProviderResult {
  const contentType = mediaType(response);
  const contentEncoding = response.headers.get("content-encoding");
  if (!RESULT_MEDIA_TYPES.has(contentType)) {
    throw responseError("PROVIDER_RESULT_MEDIA_TYPE_INVALID");
  }
  if (response.body === null) throw responseError("PROVIDER_RESULT_BODY_MISSING");
  if (contentEncoding !== null && contentEncoding.toLowerCase() !== "identity") {
    throw responseError("PROVIDER_RESULT_ENCODING_INVALID");
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    throw responseError("PROVIDER_RESULT_LENGTH_INVALID");
  }
  let seen = 0;
  const limiter = new Transform({
    transform(chunk: Buffer | Uint8Array, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      seen += bytes.byteLength;
      if (seen > maximum) {
        callback(responseError("PROVIDER_RESULT_TOO_LARGE"));
        return;
      }
      callback(null, bytes);
    },
  });
  const source = Readable.fromWeb(response.body);
  source.on("error", (error) => limiter.destroy(error));
  source.pipe(limiter);
  return {
    kind: "inline",
    bytes: limiter,
    contentType,
    contentEncoding: null,
  };
}

async function readControlJson(response: Response, maximum: number): Promise<unknown> {
  if (mediaType(response) !== CONTROL_MEDIA_TYPE) {
    await discard(response);
    throw responseError("PROVIDER_CONTROL_MEDIA_TYPE_INVALID");
  }
  if (response.body === null) throw responseError("PROVIDER_CONTROL_BODY_MISSING");
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      await discard(response);
      throw responseError("PROVIDER_CONTROL_LENGTH_INVALID");
    }
    const declaredByteCount = Number(declared);
    if (!Number.isSafeInteger(declaredByteCount)) {
      await discard(response);
      throw responseError("PROVIDER_CONTROL_LENGTH_INVALID");
    }
    if (declaredByteCount > maximum) {
      await discard(response);
      throw responseError("PROVIDER_CONTROL_TOO_LARGE", {
        observedByteCount: declaredByteCount,
        maximumByteCount: maximum,
      });
    }
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      throw responseError("PROVIDER_CONTROL_TOO_LARGE", {
        observedByteCount: total,
        maximumByteCount: maximum,
      });
    }
    chunks.push(next.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8"));
  } catch (error) {
    throw new BrightDataBoundaryError({
      code: "PROVIDER_RESPONSE_INVALID",
      submissionOutcome: "not_applicable",
      retryable: false,
      safeReason: "PROVIDER_CONTROL_JSON_INVALID",
      cause: error,
    });
  }
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Provider error bodies are deliberately discarded.
  }
}

function statusError(status: number, isSubmission: boolean, headers?: Headers): BrightDataBoundaryError {
  if (status === 401 || status === 403) {
    return new BrightDataBoundaryError({
      code: "PROVIDER_CREDENTIAL_UNAVAILABLE",
      submissionOutcome: isSubmission ? "known_failed" : "not_applicable",
      retryable: false,
    });
  }
  if (status === 402) {
    return new BrightDataBoundaryError({
      code: "PROVIDER_PAYMENT_REQUIRED",
      submissionOutcome: isSubmission ? "known_failed" : "not_applicable",
      retryable: false,
      safeReason: "PROVIDER_HTTP_402",
    });
  }
  if (status === 400 || status === 404 || status === 422) {
    return new BrightDataBoundaryError({
      code: "PROVIDER_REQUEST_REJECTED",
      submissionOutcome: isSubmission ? "known_failed" : "not_applicable",
      retryable: !isSubmission && status === 404,
      safeReason: `PROVIDER_HTTP_${status}` as Extract<
        BrightDataBoundarySafeReason,
        "PROVIDER_HTTP_400" | "PROVIDER_HTTP_404" | "PROVIDER_HTTP_422"
      >,
    });
  }
  if (status === 429) {
    const retryDelay = retryAfterMs(headers);
    return new BrightDataBoundaryError({
      code: "PROVIDER_RATE_LIMITED",
      submissionOutcome: isSubmission ? "known_failed" : "not_applicable",
      retryable: !isSubmission,
      ...(retryDelay === undefined ? {} : { retryAfterMs: retryDelay }),
    });
  }
  return new BrightDataBoundaryError({
    code: isSubmission ? "PROVIDER_SUBMISSION_UNCERTAIN" : "PROVIDER_UNAVAILABLE",
    submissionOutcome: isSubmission ? "uncertain" : "not_applicable",
    retryable: !isSubmission,
  });
}

function retryAfterMs(headers?: Headers): number | undefined {
  const value = headers?.get("retry-after");
  if (!value) return undefined;
  const milliseconds = /^\d+$/.test(value)
    ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? milliseconds : undefined;
}

async function submissionReference(response: Response, maximum: number): Promise<string> {
  try {
    return snapshotReferenceFrom(await readControlJson(response, maximum));
  } catch (error) {
    throw new BrightDataBoundaryError({
      code: error instanceof BrightDataBoundaryError ? error.code : "PROVIDER_SUBMISSION_UNCERTAIN",
      submissionOutcome: "uncertain", retryable: false,
      ...(error instanceof BrightDataBoundaryError && error.safeReason !== undefined
        ? { safeReason: error.safeReason } : {}),
      ...(error instanceof BrightDataBoundaryError && error.maximumByteCount !== undefined
        ? { maximumByteCount: error.maximumByteCount } : {}),
      ...(error instanceof BrightDataBoundaryError && error.observedByteCount !== undefined
        ? { observedByteCount: error.observedByteCount } : {}),
      cause: error,
    });
  }
}

export function createBrightDataIntegrationClient(
  dependencies: Dependencies,
): BrightDataIntegrationClient {
  if (
    !Number.isSafeInteger(dependencies.requestTimeoutMs) ||
    dependencies.requestTimeoutMs < 100 ||
    !Number.isSafeInteger(dependencies.controlResponseMaxBytes) ||
    dependencies.controlResponseMaxBytes < 128 ||
    !Number.isSafeInteger(dependencies.catalogueResponseMaxBytes) ||
    dependencies.catalogueResponseMaxBytes < dependencies.controlResponseMaxBytes ||
    dependencies.catalogueResponseMaxBytes > dependencies.resultMaxBytes ||
    !Number.isSafeInteger(dependencies.resultMaxBytes) ||
    dependencies.resultMaxBytes < 1
  ) {
    throw configurationError();
  }
  const providerFetch = dependencies.fetch ?? fetch;

  async function request(
    path: string,
    apiKey: string,
    signal: AbortSignal,
    init: Omit<RequestInit, "signal" | "redirect" | "headers"> & {
      readonly headers?: Readonly<Record<string, string>>;
    },
    isSubmission: boolean,
  ): Promise<Response> {
    validateApiKey(apiKey);
    const combinedSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(dependencies.requestTimeoutMs),
    ]);
    let response: Response;
    try {
      response = await providerFetch(new URL(path, PROVIDER_ORIGIN).toString(), {
        ...init,
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: "application/json",
          ...init.headers,
        },
        redirect: "error",
        signal: combinedSignal,
      });
    } catch (error) {
      throw new BrightDataBoundaryError({
        code: isSubmission ? "PROVIDER_SUBMISSION_UNCERTAIN" : "PROVIDER_UNAVAILABLE",
        submissionOutcome: isSubmission ? "uncertain" : "not_applicable",
        retryable: !isSubmission,
        cause: error,
      });
    }
    return response;
  }

  return {
    async listScrapers(input) {
      const response = await request(
        "/datasets/v3/scrapers",
        input.apiKey,
        input.signal,
        { method: "GET" },
        false,
      );
      if (response.status !== 200) {
        await discard(response);
        throw statusError(response.status, false, response.headers);
      }
      const parsed = await readControlJson(response, dependencies.catalogueResponseMaxBytes);
      if (!Array.isArray(parsed) || parsed.length > 10_000) throw responseError();
      return Object.freeze(
        parsed.map((candidate) => {
          if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
            throw responseError();
          }
          const id = (candidate as Record<string, unknown>).id;
          const name = (candidate as Record<string, unknown>).name;
          const normalizedName = typeof name === "string" ? name.trim() : "";
          if (
            typeof id !== "string" ||
            !DATASET_ID_PATTERN.test(id) ||
            typeof name !== "string" ||
            normalizedName.length < 1 ||
            normalizedName.length > 256
          ) {
            throw responseError();
          }
          return Object.freeze({ id, name: normalizedName });
        }),
      );
    },

    async submit(input): Promise<BrightDataSubmissionResult> {
      validateDatasetId(input.datasetId);
      validateTargets(input.targets);
      const url = new URL("/datasets/v3/scrape", PROVIDER_ORIGIN);
      url.searchParams.set("dataset_id", input.datasetId);
      url.searchParams.set("format", "json");
      url.searchParams.set("notify", "false");
      url.searchParams.set("include_errors", "true");
      applyFixedQuery(url, input.fixedQuery);
      const body = requestBody(input.targets, input.limitPerInput);
      const response = await request(
        `${url.pathname}${url.search}`,
        input.apiKey,
        input.signal,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        true,
      );
      if (response.status === 200) return resultStream(response, dependencies.resultMaxBytes);
      if (response.status === 202) {
        const delay = retryAfterMs(response.headers);
        return { kind: "snapshot", snapshotReference: await submissionReference(response, dependencies.controlResponseMaxBytes),
          ...(delay === undefined ? {} : { retryAfterMs: delay }) };
      }
      await discard(response);
      throw statusError(response.status, true, response.headers);
    },

    async trigger(input) {
      validateDatasetId(input.datasetId);
      validateTargets(input.targets);
      const url = new URL("/datasets/v3/trigger", PROVIDER_ORIGIN);
      url.searchParams.set("dataset_id", input.datasetId);
      url.searchParams.set("format", "json");
      url.searchParams.set("notify", "false");
      url.searchParams.set("include_errors", "true");
      applyFixedQuery(url, input.fixedQuery);
      applyLimitPerInputQuery(url, input.limitPerInput);
      const response = await request(
        `${url.pathname}${url.search}`,
        input.apiKey,
        input.signal,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input.targets),
        },
        true,
      );
      if (response.status !== 200 && response.status !== 202) {
        await discard(response);
        throw statusError(response.status, true, response.headers);
      }
      const delay = retryAfterMs(response.headers);
      return { snapshotReference: await submissionReference(response, dependencies.controlResponseMaxBytes),
        ...(delay === undefined ? {} : { retryAfterMs: delay }) };
    },

    async getProgress(input) {
      validateSnapshotReference(input.snapshotReference);
      const response = await request(
        `/datasets/v3/progress/${encodeURIComponent(input.snapshotReference)}`,
        input.apiKey,
        input.signal,
        { method: "GET" },
        false,
      );
      if (response.status !== 200) {
        await discard(response);
        throw statusError(response.status, false, response.headers);
      }
      const parsed = await readControlJson(response, dependencies.controlResponseMaxBytes);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw responseError();
      }
      const status = (parsed as Record<string, unknown>).status;
      if (typeof status !== "string" || !PROGRESS_STATES.has(status)) {
        throw new BrightDataBoundaryError({
          code: "PROVIDER_RESPONSE_INVALID", submissionOutcome: "not_applicable",
          retryable: true, safeReason: "PROVIDER_STATUS_UNKNOWN",
        });
      }
      return { status: status as "starting" | "running" | "ready" | "failed" | "canceled" };
    },

    async getParts(input) {
      validateSnapshotReference(input.snapshotReference);
      validateOptionalPositiveInteger(input.batchSize);
      const url = new URL(
        `/datasets/v3/snapshot/${encodeURIComponent(input.snapshotReference)}/parts`,
        PROVIDER_ORIGIN,
      );
      url.searchParams.set("format", input.format);
      if (input.batchSize !== undefined) url.searchParams.set("batch_size", String(input.batchSize));
      const response = await request(
        `${url.pathname}${url.search}`,
        input.apiKey,
        input.signal,
        { method: "GET" },
        false,
      );
      if (response.status !== 200) {
        await discard(response);
        throw statusError(response.status, false, response.headers);
      }
      const parsed = await readControlJson(response, dependencies.controlResponseMaxBytes);
      const parts =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>).parts
          : undefined;
      if (!Number.isSafeInteger(parts) || (parts as number) < 1 || (parts as number) > 10_000) {
        throw responseError();
      }
      return { parts: parts as number };
    },

    async download(input) {
      validateSnapshotReference(input.snapshotReference);
      validateOptionalPositiveInteger(input.batchSize);
      validateOptionalPositiveInteger(input.part);
      const url = new URL(
        `/datasets/v3/snapshot/${encodeURIComponent(input.snapshotReference)}`,
        PROVIDER_ORIGIN,
      );
      url.searchParams.set("format", input.format);
      if (input.batchSize !== undefined) url.searchParams.set("batch_size", String(input.batchSize));
      if (input.part !== undefined) url.searchParams.set("part", String(input.part));
      const response = await request(
        `${url.pathname}${url.search}`,
        input.apiKey,
        input.signal,
        { method: "GET" },
        false,
      );
      if (response.status !== 200) {
        await discard(response);
        if (response.status === 202 || response.status === 409) {
          const retryDelay = retryAfterMs(response.headers);
          throw new BrightDataBoundaryError({
            code: "PROVIDER_UNAVAILABLE", submissionOutcome: "not_applicable", retryable: true,
            safeReason: "PROVIDER_SNAPSHOT_NOT_READY",
            ...(retryDelay === undefined ? {} : { retryAfterMs: retryDelay }),
          });
        }
        throw statusError(response.status, false, response.headers);
      }
      return resultStream(response, dependencies.resultMaxBytes);
    },

    async cancel(input): Promise<void> {
      validateSnapshotReference(input.snapshotReference);
      const response = await request(
        `/datasets/v3/snapshot/${encodeURIComponent(input.snapshotReference)}/cancel`,
        input.apiKey,
        input.signal,
        { method: "POST" },
        false,
      );
      if (response.status !== 200) {
        await discard(response);
        throw statusError(response.status, false, response.headers);
      }
      await discard(response);
    },
  };
}
