import { Readable } from "node:stream";
import { setTimeout as waitFor } from "node:timers/promises";
import {
  type MarketplaceFilterClient,
  MarketplaceFilterBoundaryError,
} from "../brightdata/marketplace/marketplaceFilterClient.js";
import {
  type MarketplaceReviewedFilterField,
  serializeMarketplaceFilterRequest,
} from "../brightdata/marketplace/marketplaceFilterRequest.js";
import {
  createMarketplaceNormalizedOutputContract,
  normalizeMarketplaceProviderResult,
} from "../brightdata/marketplace/marketplaceResultNormalizer.js";
import type { ProviderReferenceProtector } from
  "../brightdata/providerReferenceProtector.js";
import type { SecretProvider } from "../secrets/secretProvider.js";
import type {
  QualificationEvidenceReceipt,
  QualificationEvidenceStore,
} from "../qualification/qualificationEvidenceStore.js";
import type {
  MarketplaceQualificationEvidenceReceipt,
  MarketplaceQualificationExecutionPlan,
  MarketplaceQualificationExecutionRepository,
} from "./marketplaceQualificationExecutionRepository.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_32 = /^[0-9a-f]{64}$/i;
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$/;
const MAX_PROVIDER_JOB_MS = 300_000;
const STRICT_MAXIMUM_RECORDS = 5;
const STRICT_UNIT_COST_MICROS = 2_500;
const JSON_MEDIA_TYPE = "application/json" as const;
const REVIEWED_FIELDS: Readonly<Record<string, MarketplaceReviewedFilterField>> =
  Object.freeze({
    url: Object.freeze({ types: Object.freeze(["string"] as const), format: "uri" }),
    text: Object.freeze({ types: Object.freeze(["string"] as const) }),
  });

export type MarketplaceQualificationExecutionErrorCode =
  | "MARKETPLACE_QUALIFICATION_CONFIGURATION_INVALID"
  | "MARKETPLACE_QUALIFICATION_CONFIRMATION_REQUIRED"
  | "MARKETPLACE_QUALIFICATION_INPUT_INVALID"
  | "MARKETPLACE_QUALIFICATION_SAFETY_LIMIT_EXCEEDED"
  | "MARKETPLACE_QUALIFICATION_SUBMISSION_UNCERTAIN"
  | "MARKETPLACE_QUALIFICATION_COST_UNAVAILABLE"
  | "MARKETPLACE_QUALIFICATION_COST_CEILING_EXCEEDED"
  | "MARKETPLACE_QUALIFICATION_RECORD_CEILING_EXCEEDED"
  | "MARKETPLACE_QUALIFICATION_POLL_TIMEOUT"
  | "MARKETPLACE_QUALIFICATION_POLL_FAILURES_EXHAUSTED"
  | "MARKETPLACE_QUALIFICATION_PROVIDER_FAILED"
  | "MARKETPLACE_QUALIFICATION_FAILED";

export class MarketplaceQualificationExecutionError extends Error {
  public readonly code: MarketplaceQualificationExecutionErrorCode;
  public readonly executionState: "failed" | "uncertain";

  public constructor(
    code: MarketplaceQualificationExecutionErrorCode,
    executionState: "failed" | "uncertain" = "failed",
    cause?: unknown,
  ) {
    super(
      "Marketplace qualification execution failed",
      cause === undefined ? undefined : { cause },
    );
    this.name = "MarketplaceQualificationExecutionError";
    this.code = code;
    this.executionState = executionState;
  }
}

interface Dependencies {
  readonly repository: MarketplaceQualificationExecutionRepository;
  readonly client: MarketplaceFilterClient;
  readonly protector: ProviderReferenceProtector;
  readonly secretProvider: SecretProvider;
  readonly evidenceStore: QualificationEvidenceStore;
  readonly evidenceMaxBytes: number;
  readonly pollIntervalMs: number;
  readonly maximumPollFailures: number;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

function qualificationDatasetAad(environment: "local" | "test"): Buffer {
  return Buffer.from(`dhumi:marketplace-catalogue:v1:${environment}:linkedin.posts`, "utf8");
}

function qualificationSnapshotAad(packetId: string): Buffer {
  return Buffer.from(`dhumi:marketplace-qualification-snapshot:v1:${packetId}`, "utf8");
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MarketplaceQualificationExecutionError("MARKETPLACE_QUALIFICATION_INPUT_INVALID");
  }
  return value as Readonly<Record<string, unknown>>;
}

function parsePlan(plan: MarketplaceQualificationExecutionPlan) {
  const request = object(plan.exactRequest);
  if (Object.keys(request).some((name) => !["records_limit", "selected_fields", "filter"].includes(name)) ||
      plan.operationCode !== "marketplace.dataset.filter" ||
      plan.currencyCode !== "USD" ||
      plan.pollDeadlineMs < 1 || plan.pollDeadlineMs > MAX_PROVIDER_JOB_MS ||
      !Number.isSafeInteger(request.records_limit) || (request.records_limit as number) < 1 ||
      !Array.isArray(request.selected_fields) || request.selected_fields.length < 1 ||
      request.selected_fields.some((field) => field !== "url" && field !== "text") ||
      new Set(request.selected_fields).size !== request.selected_fields.length) {
    throw new MarketplaceQualificationExecutionError("MARKETPLACE_QUALIFICATION_INPUT_INVALID");
  }
  const recordsLimit = request.records_limit as number;
  const packetMaximumCostMicros = recordsLimit * STRICT_UNIT_COST_MICROS;
  if (recordsLimit > STRICT_MAXIMUM_RECORDS ||
      !Number.isSafeInteger(plan.maximumEstimatedCostMicros) ||
      plan.maximumEstimatedCostMicros < 1 ||
      plan.maximumEstimatedCostMicros > packetMaximumCostMicros) {
    throw new MarketplaceQualificationExecutionError(
      "MARKETPLACE_QUALIFICATION_SAFETY_LIMIT_EXCEEDED",
    );
  }
  return Object.freeze({
    recordsLimit,
    selectedFields: Object.freeze([...request.selected_fields]) as readonly ("url" | "text")[],
    filter: request.filter,
  });
}

function evidence(receipt: QualificationEvidenceReceipt): MarketplaceQualificationEvidenceReceipt {
  if (!HEX_32.test(receipt.checksumHex) || !Number.isSafeInteger(receipt.byteCount) ||
      receipt.byteCount < 0 || receipt.contentType !== JSON_MEDIA_TYPE) {
    throw new MarketplaceQualificationExecutionError("MARKETPLACE_QUALIFICATION_FAILED");
  }
  return Object.freeze({
    objectKey: receipt.objectKey,
    checksum: Buffer.from(receipt.checksumHex, "hex"),
    contentType: JSON_MEDIA_TYPE,
    byteCount: receipt.byteCount,
  });
}

async function boundedBuffer(bytes: Readable, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of bytes) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += part.byteLength;
      if (total > maximum) {
        bytes.destroy();
        throw new MarketplaceQualificationExecutionError("MARKETPLACE_QUALIFICATION_FAILED");
      }
      chunks.push(part);
    }
  } catch (cause) {
    if (cause instanceof MarketplaceQualificationExecutionError) throw cause;
    throw new MarketplaceQualificationExecutionError("MARKETPLACE_QUALIFICATION_FAILED", "failed", cause);
  }
  return Buffer.concat(chunks, total);
}

function costMicros(value: number | null): number {
  if (value === null) {
    throw new MarketplaceQualificationExecutionError("MARKETPLACE_QUALIFICATION_COST_UNAVAILABLE");
  }
  // Never round provider-reported cost down at a financial boundary.
  const result = Math.ceil(value * 1_000_000);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new MarketplaceQualificationExecutionError("MARKETPLACE_QUALIFICATION_COST_UNAVAILABLE");
  }
  return result;
}

function safeFailure(cause: unknown): MarketplaceQualificationExecutionError {
  if (cause instanceof MarketplaceQualificationExecutionError) return cause;
  if (cause instanceof MarketplaceFilterBoundaryError && cause.submissionOutcome === "uncertain") {
    return new MarketplaceQualificationExecutionError(
      "MARKETPLACE_QUALIFICATION_SUBMISSION_UNCERTAIN",
      "uncertain",
      cause,
    );
  }
  if (cause instanceof MarketplaceFilterBoundaryError &&
      cause.code === "MARKETPLACE_FILTER_SNAPSHOT_FAILED") {
    return new MarketplaceQualificationExecutionError(
      "MARKETPLACE_QUALIFICATION_PROVIDER_FAILED",
      "failed",
      cause,
    );
  }
  return new MarketplaceQualificationExecutionError(
    "MARKETPLACE_QUALIFICATION_FAILED",
    "failed",
    cause,
  );
}

async function defaultWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  await waitFor(milliseconds, undefined, { signal });
}

export function createMarketplaceQualificationExecutionService(dependencies: Dependencies) {
  if (dependencies.client.transport !== "provider" ||
      !Number.isSafeInteger(dependencies.evidenceMaxBytes) || dependencies.evidenceMaxBytes < 2 ||
      !Number.isSafeInteger(dependencies.pollIntervalMs) || dependencies.pollIntervalMs < 1 ||
      !Number.isSafeInteger(dependencies.maximumPollFailures) ||
      dependencies.maximumPollFailures < 1 || dependencies.maximumPollFailures > 100) {
    throw new MarketplaceQualificationExecutionError("MARKETPLACE_QUALIFICATION_CONFIGURATION_INVALID");
  }
  const wait = dependencies.wait ?? defaultWait;
  const now = dependencies.now ?? Date.now;

  return Object.freeze({
    async execute(input: {
      readonly confirmedExactAuthorizedPacket: true;
      readonly packetId: string;
      readonly requestFingerprint: string;
      readonly actor: string;
      readonly signal: AbortSignal;
    }) {
      if (input.confirmedExactAuthorizedPacket !== true) {
        throw new MarketplaceQualificationExecutionError("MARKETPLACE_QUALIFICATION_CONFIRMATION_REQUIRED");
      }
      if (!UUID.test(input.packetId) || !HEX_32.test(input.requestFingerprint) ||
          !ACTOR.test(input.actor)) {
        throw new MarketplaceQualificationExecutionError("MARKETPLACE_QUALIFICATION_INPUT_INVALID");
      }

      let claimed = false;
      let submissionAccepted = false;
      let snapshotRecorded = false;
      let observedCostMicros: number | null = null;
      try {
        const plan = await dependencies.repository.claim({
          packetId: input.packetId,
          requestFingerprint: Buffer.from(input.requestFingerprint, "hex"),
          actor: input.actor,
        });
        claimed = true;
        const exact = parsePlan(plan);
        const datasetId = await dependencies.protector.reveal(
          plan.providerResourceCiphertext,
          plan.providerResourceFingerprint,
          qualificationDatasetAad(plan.environment),
        );
        const providerRequest = serializeMarketplaceFilterRequest({
          datasetId,
          recordsLimit: exact.recordsLimit,
          maximumRecords: exact.recordsLimit,
          filter: exact.filter,
          reviewedFields: REVIEWED_FIELDS,
        });
        const requestBytes = Buffer.from(`${JSON.stringify(providerRequest)}\n`, "utf8");
        const requestReceipt = evidence(await dependencies.evidenceStore.putImmutable({
          objectKey: `qualification/operations/${input.packetId}/request.json`,
          bytes: requestBytes,
          contentType: JSON_MEDIA_TYPE,
          maxBytes: dependencies.evidenceMaxBytes,
        }));
        await dependencies.repository.recordSubmissionStart({
          packetId: input.packetId,
          request: requestReceipt,
          actor: input.actor,
        });

        const apiKey = await dependencies.secretProvider.getSecret("BRIGHTDATA_API_KEY");
        const submission = await dependencies.client.submit({
          apiKey,
          request: providerRequest,
          signal: input.signal,
        });
        submissionAccepted = true;
        const protectedSnapshot = await dependencies.protector.protect(
          submission.snapshotReference,
          qualificationSnapshotAad(input.packetId),
        );
        await dependencies.repository.recordSnapshotReference({
          packetId: input.packetId,
          ciphertext: protectedSnapshot.ciphertext,
          fingerprint: protectedSnapshot.fingerprint,
          actor: input.actor,
        });
        snapshotRecorded = true;

        const startedAt = now();
        let failures = 0;
        for (;;) {
          input.signal.throwIfAborted();
          if (now() - startedAt >= plan.pollDeadlineMs) {
            throw new MarketplaceQualificationExecutionError("MARKETPLACE_QUALIFICATION_POLL_TIMEOUT");
          }
          try {
            const metadata = await dependencies.client.getSnapshotMetadata({
              apiKey,
              snapshotReference: submission.snapshotReference,
              signal: input.signal,
            });
            if (metadata.datasetId !== null && metadata.datasetId !== datasetId) {
              throw new MarketplaceQualificationExecutionError("MARKETPLACE_QUALIFICATION_FAILED");
            }
            if (metadata.datasetSize !== null && metadata.datasetSize > exact.recordsLimit) {
              throw new MarketplaceQualificationExecutionError(
                "MARKETPLACE_QUALIFICATION_RECORD_CEILING_EXCEEDED",
              );
            }
            if (metadata.cost !== null) {
              observedCostMicros = costMicros(metadata.cost);
              if (observedCostMicros > plan.maximumEstimatedCostMicros) {
                throw new MarketplaceQualificationExecutionError(
                  "MARKETPLACE_QUALIFICATION_COST_CEILING_EXCEEDED",
                );
              }
            }
            failures = 0;
            await dependencies.repository.recordPollCheckpoint({
              packetId: input.packetId,
              providerStatus: metadata.status,
              safeErrorCode: null,
              actor: input.actor,
            });
            if (metadata.status === "failed") {
              throw new MarketplaceQualificationExecutionError("MARKETPLACE_QUALIFICATION_PROVIDER_FAILED");
            }
            if (metadata.status === "ready") {
              if (observedCostMicros === null) {
                throw new MarketplaceQualificationExecutionError(
                  "MARKETPLACE_QUALIFICATION_COST_UNAVAILABLE",
                );
              }
              break;
            }
          } catch (cause) {
            if (!(cause instanceof MarketplaceFilterBoundaryError) || !cause.retryable) throw cause;
            failures += 1;
            const status = cause.code === "MARKETPLACE_FILTER_RATE_LIMITED"
              ? "rate_limited"
              : cause.code === "MARKETPLACE_FILTER_SNAPSHOT_NOT_FOUND"
                ? "missing"
                : cause.code === "MARKETPLACE_FILTER_SNAPSHOT_NOT_READY"
                  ? "not_ready"
                  : "read_failed";
            await dependencies.repository.recordPollCheckpoint({
              packetId: input.packetId,
              providerStatus: status,
              safeErrorCode: cause.code,
              actor: input.actor,
            });
            if (failures >= dependencies.maximumPollFailures) {
              throw new MarketplaceQualificationExecutionError(
                "MARKETPLACE_QUALIFICATION_POLL_FAILURES_EXHAUSTED",
              );
            }
          }
          const remaining = plan.pollDeadlineMs - (now() - startedAt);
          await wait(Math.min(dependencies.pollIntervalMs, Math.max(1, remaining)), input.signal);
        }

        const downloaded = await dependencies.client.downloadSnapshot({
          apiKey,
          snapshotReference: submission.snapshotReference,
          signal: input.signal,
        });
        const rawBytes = await boundedBuffer(downloaded.bytes, dependencies.evidenceMaxBytes);
        const rawReceipt = evidence(await dependencies.evidenceStore.putImmutable({
          objectKey: `qualification/operations/${input.packetId}/raw.json`,
          bytes: rawBytes,
          contentType: downloaded.contentType,
          maxBytes: dependencies.evidenceMaxBytes,
        }));
        const normalized = await normalizeMarketplaceProviderResult({
          contract: createMarketplaceNormalizedOutputContract({
            templateSlug: "linkedin-posts",
            templateVersion: 1,
            normalizerCode: "marketplace.linkedin-posts.selected-fields",
            normalizerVersion: 1,
            schemaVersion: "marketplace.linkedin-posts.output.v1",
            fieldSchemas: {
              url: { type: "string", format: "uri" },
              text: { type: ["string", "null"] },
            },
          }),
          selectedFields: exact.selectedFields,
          bytes: Readable.from([rawBytes]),
          contentType: downloaded.contentType,
          contentEncoding: downloaded.contentEncoding,
          maxBytes: dependencies.evidenceMaxBytes,
        });
        if (normalized.recordCount > exact.recordsLimit) {
          throw new MarketplaceQualificationExecutionError("MARKETPLACE_QUALIFICATION_FAILED");
        }
        const normalizedReceipt = evidence(await dependencies.evidenceStore.putImmutable({
          objectKey: `qualification/operations/${input.packetId}/normalized.json`,
          bytes: normalized.bytes,
          contentType: normalized.contentType,
          maxBytes: dependencies.evidenceMaxBytes,
        }));
        await dependencies.repository.completeSuccess({
          packetId: input.packetId,
          raw: rawReceipt,
          normalized: normalizedReceipt,
          rawRecordCount: normalized.recordCount,
          normalizedRecordCount: normalized.recordCount,
          observedCostMicros: observedCostMicros as number,
          currencyCode: plan.currencyCode,
          actor: input.actor,
        });
        return Object.freeze({
          packet_id: input.packetId,
          execution_state: "succeeded" as const,
          record_count: normalized.recordCount,
          observed_cost_micros: observedCostMicros as number,
          currency_code: plan.currencyCode,
          raw_checksum: rawReceipt.checksum.toString("hex"),
          normalized_checksum: normalizedReceipt.checksum.toString("hex"),
          provider_submissions: 1 as const,
        });
      } catch (cause) {
        const failure = submissionAccepted && !snapshotRecorded
          ? new MarketplaceQualificationExecutionError(
            "MARKETPLACE_QUALIFICATION_SUBMISSION_UNCERTAIN",
            "uncertain",
            cause,
          )
          : safeFailure(cause);
        if (claimed) {
          try {
            await dependencies.repository.completeFailure({
              packetId: input.packetId,
              executionState: failure.executionState,
              safeErrorCode: failure.code,
              observedCostMicros,
              currencyCode: "USD",
              actor: input.actor,
            });
          } catch (recordError) {
            throw new AggregateError(
              [failure, recordError],
              "Marketplace qualification failure could not be finalized",
            );
          }
        }
        throw failure;
      }
    },
  });
}
