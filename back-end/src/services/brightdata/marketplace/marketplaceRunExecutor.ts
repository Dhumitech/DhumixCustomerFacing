import { setTimeout as waitFor } from "node:timers/promises";
import { Readable } from "node:stream";
import { z } from "zod";
import type {
  ControlledRunExecutionInput,
  ControlledRunExecutor,
  ControlledRunNormalizationInput,
  ControlledRunRecoveryInput,
} from "../../jobs/controlledRunExecutor.js";
import {
  RunExecutionCancellationError,
  RunExecutionReconciliationError,
  RunExecutionTerminalError,
} from "../../jobs/controlledRunExecutor.js";
import type { SecretProvider } from "../../secrets/secretProvider.js";
import type { ResultIngestionService } from "../../storage/resultIngestionService.js";
import type { ResultObjectStore } from "../../storage/resultObjectStore.js";
import {
  providerMappingAad,
  providerSnapshotAad,
} from "../providerExecutionPlanRepository.js";
import type { ProviderReferenceProtector } from "../providerReferenceProtector.js";
import {
  type MarketplaceFilterClient,
  MarketplaceFilterBoundaryError,
  type MarketplaceSnapshotMetadata,
} from "./marketplaceFilterClient.js";
import {
  type MarketplaceReviewedFilterField,
  MarketplaceFilterContractError,
  serializeMarketplaceFilterRequest,
} from "./marketplaceFilterRequest.js";
import {
  createMarketplaceNormalizedOutputContract,
  MarketplaceOutputContractError,
  MarketplaceResultNormalizationError,
  normalizeMarketplaceProviderResult,
} from "./marketplaceResultNormalizer.js";

const policySchema = z.object({
  provider_operation: z.literal("filter"),
  transport: z.literal("fixture"),
  records_limit_max: z.number().int().positive(),
  snapshot: z.object({
    format: z.literal("json"),
    compress: z.literal(false),
  }).strict(),
  normalizer_code: z.string().trim().min(1).max(128),
  normalizer_version: z.number().int().positive(),
  normalized_schema_version: z.string().trim().min(1).max(128),
  usage: z.object({
    meter_code: z.string().regex(/^[a-z][a-z0-9_.-]{2,127}$/),
    unit: z.literal("records"),
  }).strict(),
  provider_cost: z.object({ currency_code: z.literal("USD") }).strict(),
}).strict();

type MarketplacePolicy = z.infer<typeof policySchema>;

export interface MarketplaceExecutionPlan {
  readonly mappingId: string;
  readonly providerResourceAadMappingId: string;
  readonly validatedInput: Readonly<Record<string, unknown>>;
  readonly validatedConfiguration: Readonly<Record<string, unknown>>;
  readonly templateSlug: string;
  readonly templateVersion: number;
  readonly templateOutputSchema: Readonly<Record<string, unknown>>;
  readonly adapterCode: "bright_data.marketplace.filter";
  readonly providerResourceCiphertext: Buffer;
  readonly providerResourceFingerprint: Buffer;
  readonly outputPolicy: Readonly<Record<string, unknown>>;
  readonly providerCode: "bright_data";
  readonly providerEnvironment: "test";
  readonly vaultSecretReference: string;
}

export interface MarketplaceReconciliationPlan extends MarketplaceExecutionPlan {
  readonly sourceAttemptId: string;
  readonly sourceProviderReferenceCiphertext: Buffer;
  readonly sourceProviderReferenceFingerprint: Buffer;
}

export interface MarketplaceExecutionPlanRepository {
  resolveSubmission(input: Omit<ControlledRunExecutionInput, "signal">): Promise<MarketplaceExecutionPlan>;
  resolveReconciliation(input: Omit<ControlledRunExecutionInput, "signal"> & {
    readonly sourceAttemptId: string;
  }): Promise<MarketplaceReconciliationPlan>;
  resolveNormalization(input: Omit<ControlledRunExecutionInput, "signal"> & {
    readonly sourceAttemptId: string;
  }): Promise<MarketplaceExecutionPlan>;
  recordProviderReference(input: Omit<ControlledRunExecutionInput, "signal"> & {
    readonly ciphertext: Buffer;
    readonly fingerprint: Buffer;
  }): Promise<void>;
  checkpointPoll(input: Omit<ControlledRunExecutionInput, "signal"> & {
    readonly sourceAttemptId: string;
    readonly maxElapsedMs: number;
    readonly status?: string;
    readonly failure?: boolean;
    readonly delayMs?: number;
  }): Promise<{ readonly remainingMs: number; readonly waitMs: number; readonly consecutiveFailures: number }>;
  recordSnapshotObservation(input: Omit<ControlledRunExecutionInput, "signal"> & {
    readonly sourceAttemptId: string;
    readonly status: "ready" | "failed";
    readonly datasetSize: number | null;
    readonly fileSize: number | null;
    readonly costMicros: number | null;
    readonly currencyCode: "USD";
  }): Promise<void>;
  recordKnownSubmissionOutcome(input: Omit<ControlledRunExecutionInput, "signal"> & {
    readonly outcome: "credential_rejected" | "payment_required" | "rate_limited" | "request_rejected" | "zero_matches";
  }): Promise<void>;
  isCancellationRequested(input: Omit<ControlledRunExecutionInput, "signal">): Promise<boolean>;
}

interface Dependencies {
  readonly repository: MarketplaceExecutionPlanRepository;
  readonly secretProvider: SecretProvider;
  readonly protector: ProviderReferenceProtector;
  readonly client: MarketplaceFilterClient;
  readonly ingestion: ResultIngestionService;
  readonly store: ResultObjectStore;
  readonly maxBytes: number;
  readonly pollIntervalMs: number;
  readonly pollMaxElapsedMs: number;
  readonly pollMaxConsecutiveFailures?: number;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

class MarketplaceExecutionConfigurationError extends Error {}
class MarketplaceSnapshotFailedError extends Error {}
class MarketplaceSnapshotTimedOutError extends Error {}

function plainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePolicy(value: Readonly<Record<string, unknown>>): MarketplacePolicy {
  const result = policySchema.safeParse(value);
  if (!result.success) throw new MarketplaceExecutionConfigurationError();
  return result.data;
}

function exactObject(
  value: Readonly<Record<string, unknown>>,
  names: readonly string[],
): void {
  if (Object.keys(value).some((name) => !names.includes(name))) {
    throw new MarketplaceExecutionConfigurationError();
  }
}

function executionInputs(plan: MarketplaceExecutionPlan): {
  readonly recordsLimit: number;
  readonly selectedFields: readonly string[];
  readonly filter: unknown;
} {
  exactObject(plan.validatedInput, ["records_limit"]);
  exactObject(plan.validatedConfiguration, ["selected_fields", "filter"]);
  const recordsLimit = plan.validatedInput.records_limit;
  const selectedFields = plan.validatedConfiguration.selected_fields;
  const reviewedOutputFields = outputFields(plan);
  if (!Number.isSafeInteger(recordsLimit) || (recordsLimit as number) < 1 ||
      !Array.isArray(selectedFields) || selectedFields.length < 1 || selectedFields.length > 100 ||
      selectedFields.some((field) =>
        typeof field !== "string" ||
        !Object.prototype.hasOwnProperty.call(reviewedOutputFields, field)
      ) ||
      new Set(selectedFields).size !== selectedFields.length) {
    throw new MarketplaceExecutionConfigurationError();
  }
  return {
    recordsLimit: recordsLimit as number,
    selectedFields: Object.freeze([...selectedFields]) as readonly string[],
    filter: plan.validatedConfiguration.filter,
  };
}

function outputFields(plan: MarketplaceExecutionPlan): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  const schema = plan.templateOutputSchema;
  const items = schema.items;
  if (schema.type !== "array" || !plainObject(items) || items.type !== "object" || !plainObject(items.properties)) {
    throw new MarketplaceExecutionConfigurationError();
  }
  const fields: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [name, field] of Object.entries(items.properties)) {
    if (!plainObject(field)) throw new MarketplaceExecutionConfigurationError();
    fields[name] = field;
  }
  if (Object.keys(fields).length < 1) throw new MarketplaceExecutionConfigurationError();
  return Object.freeze(fields);
}

function reviewedFilterFields(plan: MarketplaceExecutionPlan): Readonly<Record<string, MarketplaceReviewedFilterField>> {
  const result: Record<string, MarketplaceReviewedFilterField> = {};
  for (const [name, schema] of Object.entries(outputFields(plan))) {
    const rawTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    const types = rawTypes.filter((type): type is "array" | "boolean" | "integer" | "number" | "object" | "string" =>
      ["array", "boolean", "integer", "number", "object", "string"].includes(String(type)),
    );
    if (types.length < 1) throw new MarketplaceExecutionConfigurationError();
    const format = schema.format;
    result[name] = Object.freeze({
      types: Object.freeze(types),
      ...(format === "date" || format === "date-time" || format === "uri" ? { format } : {}),
    });
  }
  return Object.freeze(result);
}

function costMicros(value: number | null): number | null {
  if (value === null) return null;
  const converted = Math.round(value * 1_000_000);
  if (!Number.isSafeInteger(converted) || converted < 0) {
    throw new MarketplaceExecutionConfigurationError();
  }
  return converted;
}

function normalizeError(cause: unknown): unknown {
  if (cause instanceof RunExecutionTerminalError || cause instanceof RunExecutionCancellationError || cause instanceof RunExecutionReconciliationError) return cause;
  if (cause instanceof MarketplaceFilterBoundaryError) {
    if (cause.submissionOutcome === "uncertain") return new RunExecutionReconciliationError(cause);
    if (cause.code === "MARKETPLACE_FILTER_ZERO_MATCHES") return new RunExecutionTerminalError({
      customerErrorCode: "NO_MATCHES", retryable: false,
      outcomeClass: "provider_zero_matches", attemptState: "rejected", cause,
    });
    if (
      cause.code === "MARKETPLACE_FILTER_CONFIGURATION_INVALID" ||
      cause.code === "MARKETPLACE_FILTER_CREDENTIAL_REJECTED" ||
      cause.code === "MARKETPLACE_FILTER_PAYMENT_REQUIRED"
    ) return new RunExecutionTerminalError({
      customerErrorCode: "SERVICE_UNAVAILABLE", retryable: false,
      outcomeClass: cause.code === "MARKETPLACE_FILTER_CREDENTIAL_REJECTED"
        ? "provider_credential_rejected"
        : cause.code === "MARKETPLACE_FILTER_PAYMENT_REQUIRED"
          ? "provider_payment_required"
          : "provider_configuration_unavailable",
      attemptState: "failed",
      cause,
    });
    if (
      cause.code === "MARKETPLACE_FILTER_RESPONSE_INVALID" ||
      cause.code === "MARKETPLACE_FILTER_SNAPSHOT_FAILED"
    ) return new RunExecutionTerminalError({
      customerErrorCode: "UPSTREAM_FAILED", retryable: false,
      outcomeClass: cause.code === "MARKETPLACE_FILTER_SNAPSHOT_FAILED"
        ? "provider_snapshot_failed"
        : "provider_response_invalid",
      attemptState: "failed",
      cause,
    });
    return new RunExecutionTerminalError({
      customerErrorCode: "UPSTREAM_REJECTED",
      retryable: false,
      outcomeClass: "provider_request_rejected",
      attemptState: "rejected",
      cause,
    });
  }
  if (cause instanceof MarketplaceSnapshotFailedError) return new RunExecutionTerminalError({
    customerErrorCode: "UPSTREAM_FAILED", retryable: false,
    outcomeClass: "provider_snapshot_failed", attemptState: "failed", cause,
  });
  if (cause instanceof MarketplaceSnapshotTimedOutError) return new RunExecutionTerminalError({
    customerErrorCode: "PROVIDER_TIMEOUT", retryable: true,
    outcomeClass: "provider_snapshot_timeout", attemptState: "failed", cause,
  });
  if (
    cause instanceof MarketplaceExecutionConfigurationError ||
    cause instanceof MarketplaceFilterContractError ||
    cause instanceof MarketplaceOutputContractError
  ) return new RunExecutionTerminalError({
    customerErrorCode: "SERVICE_UNAVAILABLE", retryable: false,
    outcomeClass: "provider_configuration_unavailable", attemptState: "failed", cause,
  });
  if (cause instanceof MarketplaceResultNormalizationError) return new RunExecutionTerminalError({
    customerErrorCode: "UPSTREAM_FAILED", retryable: false,
    outcomeClass: "provider_response_invalid", attemptState: "failed", cause,
  });
  return cause;
}

async function defaultWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  await waitFor(milliseconds, undefined, { signal });
}

export function createMarketplaceRunExecutor(dependencies: Dependencies): ControlledRunExecutor {
  if (
    dependencies.client.transport !== "fixture" ||
    !Number.isSafeInteger(dependencies.maxBytes) || dependencies.maxBytes < 2 ||
    !Number.isSafeInteger(dependencies.pollIntervalMs) || dependencies.pollIntervalMs < 1 ||
    !Number.isSafeInteger(dependencies.pollMaxElapsedMs) || dependencies.pollMaxElapsedMs < dependencies.pollIntervalMs
  ) throw new MarketplaceExecutionConfigurationError();
  const wait = dependencies.wait ?? defaultWait;
  const maxFailures = dependencies.pollMaxConsecutiveFailures ?? 5;
  if (!Number.isSafeInteger(maxFailures) || maxFailures < 1 || maxFailures > 100) {
    throw new MarketplaceExecutionConfigurationError();
  }

  async function planRequest(plan: MarketplaceExecutionPlan, datasetId: string) {
    if (plan.adapterCode !== "bright_data.marketplace.filter" || plan.providerCode !== "bright_data" || plan.providerEnvironment !== "test") {
      throw new MarketplaceExecutionConfigurationError();
    }
    const policy = parsePolicy(plan.outputPolicy);
    const selected = executionInputs(plan);
    const request = serializeMarketplaceFilterRequest({
      datasetId,
      recordsLimit: selected.recordsLimit,
      maximumRecords: policy.records_limit_max,
      filter: selected.filter,
      reviewedFields: reviewedFilterFields(plan),
    });
    return { policy, selected, request };
  }

  async function collect(input: {
    readonly execution: ControlledRunExecutionInput;
    readonly sourceAttemptId: string;
    readonly apiKey: string;
    readonly datasetId: string;
    readonly snapshotReference: string;
    readonly policy: MarketplacePolicy;
  }): Promise<ReturnType<MarketplaceFilterClient["downloadSnapshot"]> extends Promise<infer T> ? T : never> {
    const checkpoint = (status?: string, failure?: boolean, delayMs?: number) =>
      dependencies.repository.checkpointPoll({
        tenantId: input.execution.tenantId,
        runId: input.execution.runId,
        attemptId: input.execution.attemptId,
        fenceToken: input.execution.fenceToken,
        sourceAttemptId: input.sourceAttemptId,
        maxElapsedMs: dependencies.pollMaxElapsedMs,
        ...(status === undefined ? {} : { status }),
        ...(failure === undefined ? {} : { failure }),
        ...(delayMs === undefined ? {} : { delayMs }),
      });
    let budget = await checkpoint();
    while (true) {
      input.execution.signal.throwIfAborted();
      if (budget.remainingMs <= 0) throw new MarketplaceSnapshotTimedOutError();
      if (budget.consecutiveFailures >= maxFailures) throw new RunExecutionTerminalError({
        customerErrorCode: "UPSTREAM_FAILED", retryable: false,
        outcomeClass: "provider_poll_failures_exhausted", attemptState: "failed",
      });
      if (await dependencies.repository.isCancellationRequested(input.execution)) {
        throw new RunExecutionCancellationError();
      }
      if (budget.waitMs > 0) {
        await wait(Math.min(budget.waitMs, budget.remainingMs, dependencies.pollIntervalMs), input.execution.signal);
        budget = await checkpoint();
        continue;
      }
      try {
        const metadata = await dependencies.client.getSnapshotMetadata({
          apiKey: input.apiKey,
          snapshotReference: input.snapshotReference,
          signal: input.execution.signal,
        });
        if (metadata.datasetId !== null && metadata.datasetId !== input.datasetId) {
          throw new MarketplaceFilterBoundaryError({
            code: "MARKETPLACE_FILTER_RESPONSE_INVALID",
            retryable: false,
            submissionOutcome: "not_applicable",
          });
        }
        budget = await checkpoint(metadata.status, false);
        if (metadata.status === "failed") {
          await recordObservation(input.execution, input.sourceAttemptId, metadata, input.policy);
          throw new MarketplaceSnapshotFailedError();
        }
        if (metadata.status === "ready") {
          await recordObservation(input.execution, input.sourceAttemptId, metadata, input.policy);
          return await dependencies.client.downloadSnapshot({
            apiKey: input.apiKey,
            snapshotReference: input.snapshotReference,
            signal: input.execution.signal,
          });
        }
        budget = await checkpoint(metadata.status, false, dependencies.pollIntervalMs);
      } catch (cause) {
        input.execution.signal.throwIfAborted();
        if (!(cause instanceof MarketplaceFilterBoundaryError) || !cause.retryable) throw cause;
        const status = cause.code === "MARKETPLACE_FILTER_SNAPSHOT_NOT_READY" ? "not_ready"
          : cause.code === "MARKETPLACE_FILTER_SNAPSHOT_NOT_FOUND" ? "missing"
          : cause.code === "MARKETPLACE_FILTER_RATE_LIMITED" ? "rate_limited" : "read_failed";
        const failure = status !== "not_ready";
        const delay = cause.retryAfterMs ?? dependencies.pollIntervalMs * 2 ** Math.min(budget.consecutiveFailures, 10);
        budget = await checkpoint(status, failure, Math.min(delay, 60_000));
      }
    }
  }

  async function recordObservation(
    execution: ControlledRunExecutionInput,
    sourceAttemptId: string,
    metadata: MarketplaceSnapshotMetadata,
    policy: MarketplacePolicy,
  ): Promise<void> {
    await dependencies.repository.recordSnapshotObservation({
      tenantId: execution.tenantId,
      runId: execution.runId,
      attemptId: execution.attemptId,
      fenceToken: execution.fenceToken,
      sourceAttemptId,
      status: metadata.status as "ready" | "failed",
      datasetSize: metadata.datasetSize,
      fileSize: metadata.fileSize,
      costMicros: costMicros(metadata.cost),
      currencyCode: policy.provider_cost.currency_code,
    });
  }

  async function persistBytes(input: ControlledRunExecutionInput, sourceAttemptId: string, result: {
    readonly bytes: Readable;
    readonly contentType: "application/json";
    readonly contentEncoding: null;
  }) {
    const artifact = await dependencies.ingestion.ingest({
      identity: {
        tenantId: input.tenantId,
        runId: input.runId,
        attemptId: sourceAttemptId,
        kind: "raw",
        artifactVersion: 1,
      },
      bytes: result.bytes,
      contentType: result.contentType,
      contentEncoding: result.contentEncoding,
      schemaVersion: null,
      recordCount: null,
      expiresAt: null,
    });
    return { artifactId: artifact.artifactId };
  }

  return {
    completionOutcomeClass: "provider_execution_completed",
    async persistRaw(input) {
      try {
        input.signal.throwIfAborted();
        const plan = await dependencies.repository.resolveSubmission(input);
        const datasetId = await dependencies.protector.reveal(
          plan.providerResourceCiphertext,
          plan.providerResourceFingerprint,
          providerMappingAad(plan.providerResourceAadMappingId),
        );
        const prepared = await planRequest(plan, datasetId);
        const apiKey = await dependencies.secretProvider.getSecret(plan.vaultSecretReference);
        let submitted;
        try {
          submitted = await dependencies.client.submit({ apiKey, request: prepared.request, signal: input.signal });
        } catch (cause) {
          if (cause instanceof MarketplaceFilterBoundaryError && cause.submissionOutcome === "known_failed") {
            const outcome = cause.code === "MARKETPLACE_FILTER_ZERO_MATCHES" ? "zero_matches"
              : cause.code === "MARKETPLACE_FILTER_PAYMENT_REQUIRED" ? "payment_required"
              : cause.code === "MARKETPLACE_FILTER_RATE_LIMITED" ? "rate_limited"
              : cause.code === "MARKETPLACE_FILTER_CREDENTIAL_REJECTED" ? "credential_rejected"
              : cause.code === "MARKETPLACE_FILTER_REQUEST_REJECTED" ? "request_rejected"
              : null;
            if (outcome !== null) {
              await dependencies.repository.recordKnownSubmissionOutcome({ ...input, outcome });
            }
          }
          throw cause;
        }
        const protectedReference = await dependencies.protector.protect(
          submitted.snapshotReference,
          providerSnapshotAad(input),
        );
        await dependencies.repository.recordProviderReference({
          ...input,
          ciphertext: protectedReference.ciphertext,
          fingerprint: protectedReference.fingerprint,
        });
        const result = await collect({
          execution: input,
          sourceAttemptId: input.attemptId,
          apiKey,
          datasetId,
          snapshotReference: submitted.snapshotReference,
          policy: prepared.policy,
        });
        return persistBytes(input, input.attemptId, result);
      } catch (cause) {
        throw normalizeError(cause);
      }
    },

    async persistNormalized(input: ControlledRunNormalizationInput) {
      try {
        input.signal.throwIfAborted();
        const sourceAttemptId = input.sourceAttemptId ?? input.attemptId;
        const plan = await dependencies.repository.resolveNormalization({ ...input, sourceAttemptId });
        const policy = parsePolicy(plan.outputPolicy);
        const selected = executionInputs(plan).selectedFields;
        const contract = createMarketplaceNormalizedOutputContract({
          templateSlug: plan.templateSlug,
          templateVersion: plan.templateVersion,
          normalizerCode: policy.normalizer_code,
          normalizerVersion: policy.normalizer_version,
          schemaVersion: policy.normalized_schema_version,
          fieldSchemas: outputFields(plan),
        });
        const raw = await dependencies.store.open({
          tenantId: input.tenantId,
          runId: input.runId,
          attemptId: sourceAttemptId,
          kind: "raw",
          artifactVersion: 1,
        }, dependencies.maxBytes);
        const transformed = await normalizeMarketplaceProviderResult({
          contract,
          selectedFields: selected,
          bytes: raw.bytes,
          contentType: raw.receipt.contentType,
          contentEncoding: raw.receipt.contentEncoding,
          maxBytes: dependencies.maxBytes,
        });
        const normalized = await dependencies.ingestion.ingest({
          identity: {
            tenantId: input.tenantId,
            runId: input.runId,
            attemptId: sourceAttemptId,
            kind: "normalized",
            artifactVersion: 1,
          },
          bytes: Readable.from([transformed.bytes]),
          contentType: transformed.contentType,
          contentEncoding: transformed.contentEncoding,
          schemaVersion: transformed.schemaVersion,
          recordCount: transformed.recordCount,
          expiresAt: null,
        });
        return {
          artifactId: normalized.artifactId,
          usage: { meterCode: policy.usage.meter_code, unit: policy.usage.unit },
        };
      } catch (cause) {
        throw normalizeError(cause);
      }
    },

    async recoverRaw(input: ControlledRunRecoveryInput): Promise<boolean> {
      try {
        input.signal.throwIfAborted();
        let plan: MarketplaceReconciliationPlan;
        try {
          plan = await dependencies.repository.resolveReconciliation(input);
        } catch (cause) {
          const code = plainObject(cause) ? cause.code : undefined;
          if (code === "P0002") return false;
          throw cause;
        }
        if (plan.sourceAttemptId !== input.sourceAttemptId) throw new MarketplaceExecutionConfigurationError();
        const datasetId = await dependencies.protector.reveal(
          plan.providerResourceCiphertext,
          plan.providerResourceFingerprint,
          providerMappingAad(plan.providerResourceAadMappingId),
        );
        const prepared = await planRequest(plan, datasetId);
        const snapshotReference = await dependencies.protector.reveal(
          plan.sourceProviderReferenceCiphertext,
          plan.sourceProviderReferenceFingerprint,
          providerSnapshotAad({ tenantId: input.tenantId, runId: input.runId, attemptId: plan.sourceAttemptId }),
        );
        const apiKey = await dependencies.secretProvider.getSecret(plan.vaultSecretReference);
        const result = await collect({
          execution: input,
          sourceAttemptId: plan.sourceAttemptId,
          apiKey,
          datasetId,
          snapshotReference,
          policy: prepared.policy,
        });
        await persistBytes(input, plan.sourceAttemptId, result);
        return true;
      } catch (cause) {
        throw normalizeError(cause);
      }
    },
  };
}
