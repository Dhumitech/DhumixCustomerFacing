import { setTimeout as waitFor } from "node:timers/promises";
import { Readable } from "node:stream";
import { z } from "zod";
import type {
  ControlledRunExecutionInput,
  ControlledRunExecutor,
  ControlledRunNormalizationInput,
  ControlledRunRecoveryInput,
} from "../jobs/controlledRunExecutor.js";
import {
  RunExecutionCancellationError,
  RunExecutionTerminalError,
  RunExecutionReconciliationError,
} from "../jobs/controlledRunExecutor.js";
import { SecretUnavailableError } from "../secrets/localEnvironmentSecretProvider.js";
import type { SecretProvider } from "../secrets/secretProvider.js";
import type { ResultIngestionService } from "../storage/resultIngestionService.js";
import type { ResultObjectStore } from "../storage/resultObjectStore.js";
import {
  BrightDataBoundaryError,
  type BrightDataIntegrationClient,
  type BrightDataSubmissionResult,
} from "./brightDataIntegrationClient.js";
import {
  providerDatasetAad,
  providerSnapshotAad,
  type ProviderExecutionPlanRepository,
} from "./providerExecutionPlanRepository.js";
import type { ProviderReferenceProtector } from "./providerReferenceProtector.js";
import { ProviderReferenceProtectionError } from "./providerReferenceProtector.js";
import {
  getAmazonOperationDefinition,
} from "./amazon/amazonOperationDefinitions.js";
import { getAmazonPreciseOutputContract } from "./amazon/amazonOutputContracts.js";
import { AMAZON_PRODUCTS_RESULT_V2, normalizeAmazonProductsResultV2 } from './amazon/amazonProductsResultV2.js';
import {
  AmazonOperationContractError,
  serializeAmazonProviderRequest,
} from "./amazon/amazonOperationSerializer.js";
import {
  AmazonResultContractUnavailableError,
  AmazonResultNormalizationError,
  inspectAmazonProviderResult,
  normalizeAmazonProviderResult,
} from "./amazon/amazonResultNormalizer.js";

const outputPolicySchema = z
  .object({
    provider_submission: z
      .object({
        endpoint: z.enum(["scrape", "trigger"]),
      })
      .strict()
      .optional(),
    provider_request: z.discriminatedUnion("mode", [
      z.object({
        mode: z.literal("collect"),
        limit_per_input: z.number().int().positive().nullable().optional(),
      }).strict(),
      z.object({
        mode: z.literal("discover"),
        discover_by: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
        limit_per_input: z.number().int().positive().nullable().optional(),
      }).strict(),
    ]),
    snapshot: z
      .object({
        enabled: z.boolean(),
        cancel_enabled: z.boolean(),
        multipart_enabled: z.literal(false),
        format: z.literal("json"),
      })
      .strict(),
    normalizer_code: z.string().trim().min(1).max(128),
    normalizer_version: z.number().int().positive(),
    normalized_schema_version: z.string().trim().min(1).max(128),
  })
  .strict();

type OutputPolicy = z.infer<typeof outputPolicySchema>;

class AmazonAllInputsFailedError extends AmazonResultNormalizationError {}

export class ProviderRunCancelledError extends Error {
  public constructor() {
    super("Private provider Run was cancelled");
    this.name = "ProviderRunCancelledError";
  }
}

export class ProviderRunFailedError extends Error {
  public constructor() {
    super("Private provider Run failed");
    this.name = "ProviderRunFailedError";
  }
}

export class ProviderRunTimedOutError extends Error {
  public constructor() {
    super("Private provider Run exceeded its polling deadline");
    this.name = "ProviderRunTimedOutError";
  }
}

interface Dependencies {
  readonly repository: ProviderExecutionPlanRepository;
  readonly secretProvider: SecretProvider;
  readonly protector: ProviderReferenceProtector;
  readonly client: BrightDataIntegrationClient;
  readonly ingestion: ResultIngestionService;
  readonly store: ResultObjectStore;
  readonly maxBytes: number;
  readonly pollIntervalMs: number;
  readonly pollMaxElapsedMs: number;
  readonly pollMaxConsecutiveFailures?: number;
  readonly providerEnvironment: "local" | "test" | "production";
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

class ProviderExecutionConfigurationError extends Error {
  public constructor() {
    super("Pinned private provider configuration was unavailable");
    this.name = "ProviderExecutionConfigurationError";
  }
}

function parsePolicy(input: { readonly outputPolicy: Readonly<Record<string, unknown>> }): OutputPolicy {
  const parsed = outputPolicySchema.safeParse(input.outputPolicy);
  if (!parsed.success) throw new ProviderExecutionConfigurationError();
  return parsed.data;
}

function providerRequestPolicy(policy: OutputPolicy):
  | Readonly<{ mode: "collect" }>
  | Readonly<{ mode: "discover"; discoverBy: string }> {
  return policy.provider_request.mode === "collect"
    ? { mode: "collect" }
    : { mode: "discover", discoverBy: policy.provider_request.discover_by };
}

function requireNormalizerPolicy(operationCode: string, policy: OutputPolicy): void {
  const contract = operationCode === AMAZON_PRODUCTS_RESULT_V2.operationCode && policy.normalizer_version === AMAZON_PRODUCTS_RESULT_V2.normalizerVersion
    ? AMAZON_PRODUCTS_RESULT_V2 : getAmazonPreciseOutputContract(operationCode);
  if (
    contract === undefined ||
    policy.normalizer_code !== contract.normalizerCode ||
    policy.normalizer_version !== contract.normalizerVersion ||
    policy.normalized_schema_version !== contract.schemaVersion
  ) {
    throw new ProviderExecutionConfigurationError();
  }
}

function normalizeExecutionError(error: unknown): unknown {
  if (error instanceof RunExecutionTerminalError || error instanceof RunExecutionCancellationError) {
    return error;
  }
  if (error instanceof ProviderRunCancelledError) {
    return new RunExecutionCancellationError(error);
  }
  if (error instanceof ProviderRunFailedError) {
    return new RunExecutionTerminalError({
      customerErrorCode: "UPSTREAM_FAILED",
      retryable: false,
      outcomeClass: "provider_snapshot_failed",
      attemptState: "failed",
      cause: error,
    });
  }
  if (error instanceof ProviderRunTimedOutError) {
    return new RunExecutionTerminalError({
      customerErrorCode: "PROVIDER_TIMEOUT",
      retryable: true,
      outcomeClass: "provider_snapshot_timeout",
      attemptState: "failed",
      cause: error,
    });
  }
  if (error instanceof BrightDataBoundaryError) {
    if (error.submissionOutcome === "uncertain" || error.retryable) return new RunExecutionReconciliationError(error);
    const credentialFailure = error.code === "PROVIDER_CREDENTIAL_UNAVAILABLE";
    const paymentFailure = error.code === "PROVIDER_PAYMENT_REQUIRED";
    const configurationFailure = error.code === "PROVIDER_CONFIGURATION_INVALID";
    const requestRejected = error.code === "PROVIDER_REQUEST_REJECTED";
    return new RunExecutionTerminalError({
      customerErrorCode:
        credentialFailure || paymentFailure || configurationFailure
          ? "SERVICE_UNAVAILABLE"
          : requestRejected
            ? "UPSTREAM_REJECTED"
            : "UPSTREAM_FAILED",
      retryable: false,
      outcomeClass: credentialFailure
        ? "provider_credential_unavailable"
        : paymentFailure
          ? "provider_payment_required"
          : configurationFailure
            ? "provider_configuration_unavailable"
            : requestRejected
              ? "provider_request_rejected"
              : "provider_response_invalid",
      attemptState: requestRejected ? "rejected" : "failed",
      cause: error,
    });
  }
  if (
    error instanceof SecretUnavailableError ||
    error instanceof ProviderReferenceProtectionError ||
    error instanceof ProviderExecutionConfigurationError ||
    error instanceof AmazonResultContractUnavailableError ||
    error instanceof AmazonOperationContractError
  ) {
    return new RunExecutionTerminalError({
      customerErrorCode: "SERVICE_UNAVAILABLE",
      retryable: false,
      outcomeClass: "provider_configuration_unavailable",
      attemptState: "failed",
      cause: error,
    });
  }
  if (error instanceof AmazonResultNormalizationError) {
    return new RunExecutionTerminalError({
      customerErrorCode: error instanceof AmazonAllInputsFailedError ? "ALL_INPUTS_FAILED" : "UPSTREAM_FAILED",
      retryable: false,
      outcomeClass: error instanceof AmazonAllInputsFailedError ? "provider_all_inputs_failed" : "provider_response_invalid",
      attemptState: "failed",
      cause: error,
    });
  }
  return error;
}

async function defaultWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  await waitFor(milliseconds, undefined, { signal });
}

export function createBrightDataRunExecutor(dependencies: Dependencies): ControlledRunExecutor {
  if (
    !Number.isSafeInteger(dependencies.maxBytes) ||
    dependencies.maxBytes < 1 ||
    !Number.isSafeInteger(dependencies.pollIntervalMs) ||
    dependencies.pollIntervalMs < 1 ||
    !Number.isSafeInteger(dependencies.pollMaxElapsedMs) ||
    dependencies.pollMaxElapsedMs < dependencies.pollIntervalMs
  ) {
    throw new TypeError("Bright Data Run executor timing/size configuration is invalid");
  }
  const wait = dependencies.wait ?? defaultWait;
  const now = dependencies.now ?? Date.now;
  const maxFailures = dependencies.pollMaxConsecutiveFailures ?? 5;
  if (!Number.isSafeInteger(maxFailures) || maxFailures < 1 || maxFailures > 100) {
    throw new TypeError("Provider consecutive failure limit is invalid");
  }

  async function persistProviderBytes(
    input: ControlledRunExecutionInput,
    outcome: Extract<BrightDataSubmissionResult, { readonly kind: "inline" }>,
    storageAttemptId = input.attemptId,
  ): Promise<{ readonly artifactId: string }> {
    const raw = await dependencies.ingestion.ingest({
      identity: {
        tenantId: input.tenantId,
        runId: input.runId,
        attemptId: storageAttemptId,
        kind: "raw",
        artifactVersion: 1,
      },
      bytes: outcome.bytes,
      contentType: outcome.contentType,
      contentEncoding: outcome.contentEncoding,
      schemaVersion: null,
      recordCount: null,
      expiresAt: null,
    });
    return { artifactId: raw.artifactId };
  }

  async function collectSnapshot(input: {
    readonly execution: ControlledRunExecutionInput;
    readonly apiKey: string;
    readonly snapshotReference: string;
    readonly policy: OutputPolicy;
    readonly sourceAttemptId?: string;
  }): Promise<Extract<BrightDataSubmissionResult, { readonly kind: "inline" }>> {
    if (!input.policy.snapshot.enabled) {
      throw new ProviderExecutionConfigurationError();
    }
    const startedAt = now();
    const checkpoint = (status?: string, failure?: boolean, delayMs?: number) =>
      dependencies.repository.checkpointPoll({
        tenantId: input.execution.tenantId, runId: input.execution.runId,
        attemptId: input.execution.attemptId, fenceToken: input.execution.fenceToken,
        sourceAttemptId: input.sourceAttemptId ?? input.execution.attemptId,
        maxElapsedMs: dependencies.pollMaxElapsedMs,
        ...(status === undefined ? {} : { status }),
        ...(failure === undefined ? {} : { failure }),
        ...(delayMs === undefined ? {} : { delayMs }),
      });
    let budget = await checkpoint();
    while (true) {
      input.execution.signal.throwIfAborted();
      if (budget.remainingMs <= 0 || now() - startedAt >= dependencies.pollMaxElapsedMs) {
        throw new ProviderRunTimedOutError();
      }
      if (budget.consecutiveFailures >= maxFailures) {
        throw new RunExecutionTerminalError({
          customerErrorCode: "UPSTREAM_FAILED", retryable: false,
          outcomeClass: "provider_poll_failures_exhausted", attemptState: "failed",
        });
      }
      if (
        await dependencies.repository.isCancellationRequested({
          tenantId: input.execution.tenantId,
          runId: input.execution.runId,
          attemptId: input.execution.attemptId,
          fenceToken: input.execution.fenceToken,
        })
      ) {
        if (input.policy.snapshot.cancel_enabled) {
          await dependencies.client.cancel({
            apiKey: input.apiKey,
            snapshotReference: input.snapshotReference,
            signal: input.execution.signal,
          });
        }
        throw new ProviderRunCancelledError();
      }
      if (budget.waitMs > 0) {
        // Recheck local cancellation during a long provider Retry-After, while
        // the persisted next-poll time prevents early provider status reads.
        await wait(Math.min(budget.waitMs, budget.remainingMs, dependencies.pollIntervalMs), input.execution.signal);
        budget = await checkpoint();
        continue;
      }
      try {
        const progress = await dependencies.client.getProgress({
          apiKey: input.apiKey,
          snapshotReference: input.snapshotReference,
          signal: input.execution.signal,
        });
        // Persist readiness without resetting a chain of failed downloads.
        budget = await checkpoint(progress.status, progress.status === "ready" ? undefined : false);
        if (progress.status === "ready") {
          return await dependencies.client.download({
            apiKey: input.apiKey,
            snapshotReference: input.snapshotReference,
            format: input.policy.snapshot.format,
            signal: input.execution.signal,
          });
        }
        if (progress.status === "failed") throw new ProviderRunFailedError();
        if (progress.status === "canceled") throw new ProviderRunCancelledError();
        budget = await checkpoint(progress.status, false, dependencies.pollIntervalMs);
      } catch (error) {
        input.execution.signal.throwIfAborted();
        if (!(error instanceof BrightDataBoundaryError) || !error.retryable) throw error;
        const status = error.safeReason === "PROVIDER_SNAPSHOT_NOT_READY" ? "not_ready"
          : error.safeReason === "PROVIDER_HTTP_404" ? "missing"
          : error.safeReason === "PROVIDER_STATUS_UNKNOWN" ? "unknown"
          : error.code === "PROVIDER_RATE_LIMITED" ? "rate_limited" : "read_failed";
        const delay = error.retryAfterMs ?? Math.min(60_000,
          dependencies.pollIntervalMs * 2 ** Math.min(budget.consecutiveFailures, 10));
        // A documented not-ready response is progress, not a failed read.
        // Its wait remains bounded by the original polling deadline.
        budget = await checkpoint(status, status !== "not_ready", delay);
        // Missing/unknown references must pass through durable recovery first.
        // The shared checkpoint limits that recovery across worker restarts.
        if ((status === "missing" || status === "unknown") && input.sourceAttemptId === undefined) throw error;
      }
    }
  }

  return {
    completionOutcomeClass: "provider_execution_completed",
    async persistRaw(input): Promise<{ readonly artifactId: string }> {
      try {
        input.signal.throwIfAborted();
        const plan = await dependencies.repository.resolveSubmission(input);
        if (plan.providerEnvironment !== dependencies.providerEnvironment) {
          throw new ProviderExecutionConfigurationError();
        }
        const policy = parsePolicy(plan);
        requireNormalizerPolicy(plan.operationCode, policy);
        const serialized = serializeAmazonProviderRequest({
          operationCode: plan.operationCode,
          validatedInput: plan.validatedInput,
          providerRequest: providerRequestPolicy(policy),
        });
        const datasetId = await dependencies.protector.reveal(
          plan.datasetCiphertext,
          plan.datasetFingerprint,
          providerDatasetAad(plan.templateVersionId),
        );
        const apiKey = await dependencies.secretProvider.getSecret(plan.secretReference);
        const providerInput = {
          apiKey,
          datasetId,
          targets: serialized.targets,
          fixedQuery: serialized.fixedQuery,
          ...(policy.provider_request.limit_per_input === undefined
            ? {}
            : { limitPerInput: policy.provider_request.limit_per_input }),
          signal: input.signal,
        } as const;
        const submitted = policy.provider_submission?.endpoint === "trigger"
          ? {
              kind: "snapshot" as const,
              ...await dependencies.client.trigger(providerInput),
            }
          : await dependencies.client.submit(providerInput);
        if (submitted.kind === "inline") return persistProviderBytes(input, submitted);

        const protectedReference = await dependencies.protector.protect(
          submitted.snapshotReference,
          providerSnapshotAad(input),
        );
        await dependencies.repository.recordProviderReference({
          tenantId: input.tenantId,
          runId: input.runId,
          attemptId: input.attemptId,
          fenceToken: input.fenceToken,
          ciphertext: protectedReference.ciphertext,
          fingerprint: protectedReference.fingerprint,
        });
        const downloaded = await collectSnapshot({
          execution: input,
          apiKey,
          snapshotReference: submitted.snapshotReference,
          policy,
        });
        return persistProviderBytes(input, downloaded);
      } catch (error) {
        throw normalizeExecutionError(error);
      }
    },

    async persistNormalized(
      input: ControlledRunNormalizationInput,
    ) {
      try {
        input.signal.throwIfAborted();
        const sourceAttemptId = input.sourceAttemptId ?? input.attemptId;
        const plan = await dependencies.repository.resolveNormalization({
          tenantId: input.tenantId,
          runId: input.runId,
          attemptId: input.attemptId,
          fenceToken: input.fenceToken,
          sourceAttemptId,
        });
        const policy = parsePolicy(plan);
        requireNormalizerPolicy(plan.operationCode, policy);
        const raw = await dependencies.store.open(
          {
            tenantId: input.tenantId,
            runId: input.runId,
            attemptId: sourceAttemptId,
            kind: "raw",
            artifactVersion: 1,
          },
          dependencies.maxBytes,
        );
        let transformed;
        try {
          transformed = await (policy.normalizer_version === AMAZON_PRODUCTS_RESULT_V2.normalizerVersion
            ? normalizeAmazonProductsResultV2 : normalizeAmazonProviderResult)({
            operationCode: plan.operationCode,
            bytes: raw.bytes,
            contentType: raw.receipt.contentType,
            contentEncoding: raw.receipt.contentEncoding,
            maxBytes: dependencies.maxBytes,
          });
        } catch (error) {
          if (!(error instanceof AmazonResultNormalizationError)) throw error;
          // Keep the cryptographically pinned normalizer unchanged. Classify
          // its rejection using the already durable raw Artifact, never egress.
          let allInputsFailed = false;
          try {
            const evidence = await dependencies.store.open({
              tenantId: input.tenantId, runId: input.runId, attemptId: sourceAttemptId,
              kind: "raw", artifactVersion: 1,
            }, dependencies.maxBytes);
            const observed = await inspectAmazonProviderResult({
              bytes: evidence.bytes, contentType: evidence.receipt.contentType,
              contentEncoding: evidence.receipt.contentEncoding, maxBytes: dependencies.maxBytes,
            });
            allInputsFailed = observed.recordCount > 0 && observed.providerErrorCount === observed.recordCount;
          } catch {
            // Optional diagnostic classification cannot turn an already known
            // terminal normalization failure back into an endless recovery.
          }
          if (allInputsFailed) throw new AmazonAllInputsFailedError();
          throw error;
        }
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
        const definition = getAmazonOperationDefinition(plan.operationCode);
        if (definition === undefined) throw new ProviderExecutionConfigurationError();
        return {
          artifactId: normalized.artifactId,
          usage: {
            meterCode: definition.usage.meterCode,
            // Pattern 8A fixes the normalized-record observation unit without
            // mutating Pattern 6's cryptographically pinned operation bytes.
            unit: "records",
          },
        };
      } catch (error) {
        throw normalizeExecutionError(error);
      }
    },

    async recoverRaw(input: ControlledRunRecoveryInput): Promise<boolean> {
      try {
        input.signal.throwIfAborted();
        let plan;
        try {
          plan = await dependencies.repository.resolveReconciliation(input);
        } catch (error) {
          const code =
            typeof error === "object" && error !== null && "code" in error
              ? (error as { readonly code?: unknown }).code
              : undefined;
          if (code === "P0002") return false;
          throw error;
        }
        if (
          plan.sourceAttemptId !== input.sourceAttemptId ||
          plan.providerEnvironment !== dependencies.providerEnvironment
        ) {
          throw new ProviderExecutionConfigurationError();
        }
        const policy = parsePolicy(plan);
        requireNormalizerPolicy(plan.operationCode, policy);
        await dependencies.protector.reveal(
          plan.datasetCiphertext,
          plan.datasetFingerprint,
          providerDatasetAad(plan.templateVersionId),
        );
        const snapshotReference = await dependencies.protector.reveal(
          plan.sourceProviderReferenceCiphertext,
          plan.sourceProviderReferenceFingerprint,
          providerSnapshotAad({
            tenantId: input.tenantId,
            runId: input.runId,
            attemptId: plan.sourceAttemptId,
          }),
        );
        const apiKey = await dependencies.secretProvider.getSecret(plan.secretReference);
        const downloaded = await collectSnapshot({
          execution: input,
          apiKey,
          snapshotReference,
          policy,
          sourceAttemptId: plan.sourceAttemptId,
        });
        await persistProviderBytes(input, downloaded, plan.sourceAttemptId);
        return true;
      } catch (error) {
        throw normalizeExecutionError(error);
      }
    },
  };
}
