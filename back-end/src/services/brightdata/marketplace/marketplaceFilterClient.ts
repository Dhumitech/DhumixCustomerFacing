import { Readable, Transform } from "node:stream";
import {
  isMarketplaceProviderIdentifier,
  type MarketplaceFilterRequest,
} from "./marketplaceFilterRequest.js";

const PROVIDER_ORIGIN = "https://api.brightdata.com";
const JSON_MEDIA_TYPE = "application/json";

export type MarketplaceFilterFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type MarketplaceFilterBoundaryErrorCode =
  | "MARKETPLACE_FILTER_CONFIGURATION_INVALID"
  | "MARKETPLACE_FILTER_CREDENTIAL_REJECTED"
  | "MARKETPLACE_FILTER_PAYMENT_REQUIRED"
  | "MARKETPLACE_FILTER_RATE_LIMITED"
  | "MARKETPLACE_FILTER_REQUEST_REJECTED"
  | "MARKETPLACE_FILTER_RESPONSE_INVALID"
  | "MARKETPLACE_FILTER_SNAPSHOT_FAILED"
  | "MARKETPLACE_FILTER_SNAPSHOT_NOT_FOUND"
  | "MARKETPLACE_FILTER_SNAPSHOT_NOT_READY"
  | "MARKETPLACE_FILTER_SUBMISSION_UNCERTAIN"
  | "MARKETPLACE_FILTER_UNAVAILABLE"
  | "MARKETPLACE_FILTER_ZERO_MATCHES";

export type MarketplaceSubmissionOutcome = "known_failed" | "not_applicable" | "uncertain";

export class MarketplaceFilterBoundaryError extends Error {
  public readonly code: MarketplaceFilterBoundaryErrorCode;
  public readonly retryable: boolean;
  public readonly submissionOutcome: MarketplaceSubmissionOutcome;
  public readonly retryAfterMs?: number;

  public constructor(input: {
    readonly code: MarketplaceFilterBoundaryErrorCode;
    readonly retryable: boolean;
    readonly submissionOutcome: MarketplaceSubmissionOutcome;
    readonly retryAfterMs?: number;
    readonly cause?: unknown;
  }) {
    super(
      "Private Marketplace Filter operation failed",
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.name = "MarketplaceFilterBoundaryError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.submissionOutcome = input.submissionOutcome;
    if (input.retryAfterMs !== undefined) this.retryAfterMs = input.retryAfterMs;
  }
}

export interface MarketplaceSnapshotMetadata {
  readonly id: string;
  readonly status: "scheduled" | "building" | "ready" | "failed";
  readonly datasetId: string | null;
  readonly datasetSize: number | null;
  readonly fileSize: number | null;
  readonly cost: number | null;
}

export interface MarketplaceFilterClient {
  readonly transport: "fixture" | "provider";
  submit(input: {
    readonly apiKey: string;
    readonly request: MarketplaceFilterRequest;
    readonly signal: AbortSignal;
  }): Promise<{ readonly snapshotReference: string }>;
  getSnapshotMetadata(input: {
    readonly apiKey: string;
    readonly snapshotReference: string;
    readonly signal: AbortSignal;
  }): Promise<MarketplaceSnapshotMetadata>;
  downloadSnapshot(input: {
    readonly apiKey: string;
    readonly snapshotReference: string;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly bytes: Readable;
    readonly contentType: typeof JSON_MEDIA_TYPE;
    readonly contentEncoding: null;
  }>;
}

interface Dependencies {
  readonly requestTimeoutMs: number;
  readonly controlResponseMaxBytes: number;
  readonly resultMaxBytes: number;
  readonly fetch: MarketplaceFilterFetch;
}

function error(input: ConstructorParameters<typeof MarketplaceFilterBoundaryError>[0]): MarketplaceFilterBoundaryError {
  return new MarketplaceFilterBoundaryError(input);
}

function validateApiKey(value: string): void {
  if (value.trim() !== value || value.length < 8 || value.length > 4096) {
    throw error({ code: "MARKETPLACE_FILTER_CONFIGURATION_INVALID", retryable: false, submissionOutcome: "not_applicable" });
  }
}

function validateSnapshotReference(value: string): void {
  if (!isMarketplaceProviderIdentifier(value)) {
    throw error({ code: "MARKETPLACE_FILTER_CONFIGURATION_INVALID", retryable: false, submissionOutcome: "not_applicable" });
  }
}

function mediaType(response: Response): string {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

async function discard(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* Provider error bodies remain private. */ }
}

async function readBoundedJson(response: Response, maximum: number): Promise<unknown> {
  if (mediaType(response) !== JSON_MEDIA_TYPE || response.body === null) {
    await discard(response);
    throw error({ code: "MARKETPLACE_FILTER_RESPONSE_INVALID", retryable: false, submissionOutcome: "not_applicable" });
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw error({ code: "MARKETPLACE_FILTER_RESPONSE_INVALID", retryable: false, submissionOutcome: "not_applicable" });
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown;
  } catch (cause) {
    throw error({ code: "MARKETPLACE_FILTER_RESPONSE_INVALID", retryable: false, submissionOutcome: "not_applicable", cause });
  }
}

function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (value === null) return undefined;
  const parsed = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function submissionStatus(status: number, headers: Headers): MarketplaceFilterBoundaryError {
  if (status === 401 || status === 403) return error({ code: "MARKETPLACE_FILTER_CREDENTIAL_REJECTED", retryable: false, submissionOutcome: "known_failed" });
  if (status === 402) return error({ code: "MARKETPLACE_FILTER_PAYMENT_REQUIRED", retryable: false, submissionOutcome: "known_failed" });
  if (status === 422) return error({ code: "MARKETPLACE_FILTER_ZERO_MATCHES", retryable: false, submissionOutcome: "known_failed" });
  if (status === 429) {
    const retryDelay = retryAfterMs(headers);
    return error({
      code: "MARKETPLACE_FILTER_RATE_LIMITED",
      retryable: false,
      submissionOutcome: "known_failed",
      ...(retryDelay === undefined ? {} : { retryAfterMs: retryDelay }),
    });
  }
  if (status === 400 || status === 404) return error({ code: "MARKETPLACE_FILTER_REQUEST_REJECTED", retryable: false, submissionOutcome: "known_failed" });
  return error({ code: "MARKETPLACE_FILTER_SUBMISSION_UNCERTAIN", retryable: false, submissionOutcome: "uncertain" });
}

function integerOrNull(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw error({ code: "MARKETPLACE_FILTER_RESPONSE_INVALID", retryable: false, submissionOutcome: "not_applicable" });
  }
  return value as number;
}

function numberOrNull(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw error({ code: "MARKETPLACE_FILTER_RESPONSE_INVALID", retryable: false, submissionOutcome: "not_applicable" });
  }
  return value;
}

function resultStream(response: Response, maximum: number): Readable {
  if (mediaType(response) !== JSON_MEDIA_TYPE || response.body === null) {
    void discard(response);
    throw error({ code: "MARKETPLACE_FILTER_RESPONSE_INVALID", retryable: false, submissionOutcome: "not_applicable" });
  }
  const encoding = response.headers.get("content-encoding");
  if (encoding !== null && encoding.toLowerCase() !== "identity") {
    void discard(response);
    throw error({ code: "MARKETPLACE_FILTER_RESPONSE_INVALID", retryable: false, submissionOutcome: "not_applicable" });
  }
  let seen = 0;
  const limiter = new Transform({
    transform(chunk: Buffer | Uint8Array, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      seen += bytes.byteLength;
      callback(seen > maximum
        ? error({ code: "MARKETPLACE_FILTER_RESPONSE_INVALID", retryable: false, submissionOutcome: "not_applicable" })
        : null, bytes);
    },
  });
  const source = Readable.fromWeb(response.body);
  source.on("error", (cause) => limiter.destroy(cause));
  source.pipe(limiter);
  return limiter;
}

export function createMarketplaceFilterClient(dependencies: Dependencies): MarketplaceFilterClient {
  if (
    !Number.isSafeInteger(dependencies.requestTimeoutMs) || dependencies.requestTimeoutMs < 1 ||
    !Number.isSafeInteger(dependencies.controlResponseMaxBytes) || dependencies.controlResponseMaxBytes < 2 ||
    !Number.isSafeInteger(dependencies.resultMaxBytes) || dependencies.resultMaxBytes < 2
  ) {
    throw error({ code: "MARKETPLACE_FILTER_CONFIGURATION_INVALID", retryable: false, submissionOutcome: "not_applicable" });
  }

  async function request(path: string, apiKey: string, signal: AbortSignal, init: RequestInit, submission: boolean): Promise<Response> {
    validateApiKey(apiKey);
    try {
      return await dependencies.fetch(new URL(path, PROVIDER_ORIGIN).toString(), {
        ...init,
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: JSON_MEDIA_TYPE,
          ...(init.headers ?? {}),
        },
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(dependencies.requestTimeoutMs)]),
      });
    } catch (cause) {
      throw error({
        code: submission ? "MARKETPLACE_FILTER_SUBMISSION_UNCERTAIN" : "MARKETPLACE_FILTER_UNAVAILABLE",
        retryable: !submission,
        submissionOutcome: submission ? "uncertain" : "not_applicable",
        cause,
      });
    }
  }

  const client: MarketplaceFilterClient = {
    transport: "provider" as const,
    async submit(input) {
      const response = await request("/datasets/filter", input.apiKey, input.signal, {
        method: "POST",
        headers: { "content-type": JSON_MEDIA_TYPE },
        body: JSON.stringify(input.request),
      }, true);
      if (response.status !== 200) {
        await discard(response);
        throw submissionStatus(response.status, response.headers);
      }
      let parsed: unknown;
      try {
        parsed = await readBoundedJson(response, dependencies.controlResponseMaxBytes);
      } catch (cause) {
        throw error({ code: "MARKETPLACE_FILTER_SUBMISSION_UNCERTAIN", retryable: false, submissionOutcome: "uncertain", cause });
      }
      const snapshotReference = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).snapshot_id : undefined;
      if (!isMarketplaceProviderIdentifier(snapshotReference)) {
        throw error({ code: "MARKETPLACE_FILTER_SUBMISSION_UNCERTAIN", retryable: false, submissionOutcome: "uncertain" });
      }
      return { snapshotReference };
    },

    async getSnapshotMetadata(input) {
      validateSnapshotReference(input.snapshotReference);
      const response = await request(
        `/datasets/snapshots/${encodeURIComponent(input.snapshotReference)}`,
        input.apiKey,
        input.signal,
        { method: "GET" },
        false,
      );
      if (response.status !== 200) {
        await discard(response);
        if (response.status === 404) throw error({ code: "MARKETPLACE_FILTER_SNAPSHOT_NOT_FOUND", retryable: true, submissionOutcome: "not_applicable" });
        if (response.status === 401 || response.status === 403) throw error({ code: "MARKETPLACE_FILTER_CREDENTIAL_REJECTED", retryable: false, submissionOutcome: "not_applicable" });
        if (response.status === 429) {
          const retryDelay = retryAfterMs(response.headers);
          throw error({ code: "MARKETPLACE_FILTER_RATE_LIMITED", retryable: true, submissionOutcome: "not_applicable", ...(retryDelay === undefined ? {} : { retryAfterMs: retryDelay }) });
        }
        throw error({ code: "MARKETPLACE_FILTER_UNAVAILABLE", retryable: response.status >= 500, submissionOutcome: "not_applicable" });
      }
      const parsed = await readBoundedJson(response, dependencies.controlResponseMaxBytes);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw error({ code: "MARKETPLACE_FILTER_RESPONSE_INVALID", retryable: false, submissionOutcome: "not_applicable" });
      }
      const document = parsed as Record<string, unknown>;
      const id = document.id;
      const status = document.status;
      if (
        typeof id !== "string" || id !== input.snapshotReference ||
        typeof status !== "string" ||
        !["scheduled", "building", "ready", "failed"].includes(status)
      ) {
        throw error({ code: "MARKETPLACE_FILTER_RESPONSE_INVALID", retryable: false, submissionOutcome: "not_applicable" });
      }
      const datasetId = document.dataset_id;
      if (datasetId !== undefined && datasetId !== null && !isMarketplaceProviderIdentifier(datasetId)) {
        throw error({ code: "MARKETPLACE_FILTER_RESPONSE_INVALID", retryable: false, submissionOutcome: "not_applicable" });
      }
      return Object.freeze({
        id,
        status: status as MarketplaceSnapshotMetadata["status"],
        datasetId: typeof datasetId === "string" ? datasetId : null,
        datasetSize: integerOrNull(document.dataset_size),
        fileSize: integerOrNull(document.file_size),
        cost: numberOrNull(document.cost),
      });
    },

    async downloadSnapshot(input) {
      validateSnapshotReference(input.snapshotReference);
      const response = await request(
        `/datasets/snapshots/${encodeURIComponent(input.snapshotReference)}/download?format=json&compress=false`,
        input.apiKey,
        input.signal,
        { method: "GET" },
        false,
      );
      if (response.status !== 200) {
        await discard(response);
        if (response.status === 202 || response.status === 400) {
          const retryDelay = retryAfterMs(response.headers);
          throw error({ code: "MARKETPLACE_FILTER_SNAPSHOT_NOT_READY", retryable: true, submissionOutcome: "not_applicable", ...(retryDelay === undefined ? {} : { retryAfterMs: retryDelay }) });
        }
        if (response.status === 404) throw error({ code: "MARKETPLACE_FILTER_SNAPSHOT_NOT_FOUND", retryable: true, submissionOutcome: "not_applicable" });
        throw error({ code: "MARKETPLACE_FILTER_UNAVAILABLE", retryable: response.status === 429 || response.status >= 500, submissionOutcome: "not_applicable" });
      }
      return {
        bytes: resultStream(response, dependencies.resultMaxBytes),
        contentType: JSON_MEDIA_TYPE,
        contentEncoding: null,
      };
    },
  };
  return Object.freeze(client);
}
