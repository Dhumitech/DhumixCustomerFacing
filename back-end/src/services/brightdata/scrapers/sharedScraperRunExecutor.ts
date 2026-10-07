import { Readable } from "node:stream";
import { setTimeout as waitFor } from "node:timers/promises";
import type { ControlledRunExecutionInput, ControlledRunExecutor } from "../../jobs/controlledRunExecutor.js";
import { RunExecutionCancellationError, RunExecutionReconciliationError, RunExecutionTerminalError } from "../../jobs/controlledRunExecutor.js";
import type { SecretProvider } from "../../secrets/secretProvider.js";
import { SecretUnavailableError } from "../../secrets/localEnvironmentSecretProvider.js";
import type { ResultIngestionService } from "../../storage/resultIngestionService.js";
import type { ResultObjectStore } from "../../storage/resultObjectStore.js";
import { BrightDataBoundaryError, type BrightDataIntegrationClient, type BrightDataSubmissionResult } from "../brightDataIntegrationClient.js";
import { providerDatasetAad, providerSnapshotAad } from "../providerExecutionPlanRepository.js";
import { ProviderReferenceProtectionError, type ProviderReferenceProtector } from "../providerReferenceProtector.js";
import type { ScraperExecutionPlan, ScraperExecutionRepository } from "./scraperExecutionRepository.js";
import { createScraperProcessing, ScraperContractError, ScraperInputError, ScraperResultError, type ScraperProcessor } from "../../scrapers/scraperProcessing.js";
import { SHARED_SCRAPER_ADAPTER_CODE, SHARED_SCRAPER_ADAPTER_VERSION, SHARED_SCRAPER_ARTIFACT_DIGEST } from "../../scrapers/sharedScraperVersion.js";

class SnapshotFailure extends Error {
  public constructor(public readonly kind: "failed" | "timeout") { super("Private scraper snapshot did not complete"); }
}
type Inline = Extract<BrightDataSubmissionResult, { readonly kind: "inline" }>;
function terminal(customerErrorCode: string, outcomeClass: string, retryable = false, attemptState: "rejected" | "failed" = "failed") {
  return new RunExecutionTerminalError({ customerErrorCode, outcomeClass, retryable, attemptState });
}
function safeError(error: unknown): unknown {
  if (error instanceof RunExecutionTerminalError || error instanceof RunExecutionCancellationError || error instanceof RunExecutionReconciliationError) return error;
  if (error instanceof SnapshotFailure) return error.kind === "timeout"
    ? terminal("PROVIDER_TIMEOUT", "provider_snapshot_timeout", true)
    : terminal("UPSTREAM_FAILED", "provider_snapshot_failed");
  if (error instanceof ScraperResultError) return error.classification === "all_inputs_failed"
    ? terminal("ALL_INPUTS_FAILED", "provider_all_inputs_failed")
    : terminal("UPSTREAM_FAILED", "provider_response_invalid");
  if (error instanceof ScraperContractError || error instanceof ScraperInputError ||
    error instanceof SecretUnavailableError || error instanceof ProviderReferenceProtectionError) return terminal("SERVICE_UNAVAILABLE", "provider_configuration_unavailable");
  if (error instanceof BrightDataBoundaryError) {
    if (error.submissionOutcome === "uncertain" || error.retryable) return new RunExecutionReconciliationError();
    switch (error.code) {
      case "PROVIDER_CREDENTIAL_UNAVAILABLE": return terminal("SERVICE_UNAVAILABLE", "provider_credential_unavailable");
      case "PROVIDER_PAYMENT_REQUIRED": return terminal("SERVICE_UNAVAILABLE", "provider_payment_required");
      case "PROVIDER_CONFIGURATION_INVALID": return terminal("SERVICE_UNAVAILABLE", "provider_configuration_unavailable");
      case "PROVIDER_REQUEST_REJECTED": return terminal("UPSTREAM_REJECTED", "provider_request_rejected", false, "rejected");
      default: return terminal("UPSTREAM_FAILED", "provider_response_invalid");
    }
  }
  // Storage/DB failures retain the Job Manager's existing orphan adoption and
  // reconciliation behavior. They must never become a repeat submission here.
  return error;
}

export function createSharedScraperRunExecutor(dependencies: {
  readonly repository: ScraperExecutionRepository;
  readonly processing: ReturnType<typeof createScraperProcessing>;
  readonly client: BrightDataIntegrationClient;
  readonly protector: ProviderReferenceProtector;
  readonly secretProvider: SecretProvider;
  readonly ingestion: ResultIngestionService;
  readonly store: ResultObjectStore;
  readonly providerEnvironment: "local" | "test" | "production";
  readonly maxBytes: number; readonly pollIntervalMs: number; readonly pollMaxElapsedMs: number;
  readonly pollMaxConsecutiveFailures: number;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}): ControlledRunExecutor {
  if (![dependencies.maxBytes, dependencies.pollIntervalMs, dependencies.pollMaxElapsedMs, dependencies.pollMaxConsecutiveFailures].every(
    (value) => Number.isSafeInteger(value) && value > 0) || dependencies.pollMaxElapsedMs < dependencies.pollIntervalMs ||
    dependencies.pollMaxElapsedMs > 86_400_000 || dependencies.pollMaxConsecutiveFailures > 100) throw new TypeError("Invalid shared scraper resource/timing configuration");
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.wait ?? (async (milliseconds, signal) => { await waitFor(milliseconds, undefined, { signal }); });

  function prepare(plan: ScraperExecutionPlan): ScraperProcessor {
    if (plan.identity.code !== SHARED_SCRAPER_ADAPTER_CODE || plan.identity.version !== SHARED_SCRAPER_ADAPTER_VERSION ||
      plan.identity.digest !== SHARED_SCRAPER_ARTIFACT_DIGEST || plan.providerEnvironment !== dependencies.providerEnvironment) throw new ScraperContractError();
    return dependencies.processing.prepare(plan.contract, plan.contractHash);
  }
  async function credentials(plan: ScraperExecutionPlan): Promise<{ readonly apiKey: string; readonly datasetId: string }> {
    if (!Buffer.isBuffer(plan.datasetCiphertext) || !Buffer.isBuffer(plan.datasetFingerprint) || !plan.secretReference) throw new ScraperContractError();
    const datasetId = await dependencies.protector.reveal(plan.datasetCiphertext, plan.datasetFingerprint,
      providerDatasetAad(plan.templateVersionId));
    const apiKey = await dependencies.secretProvider.getSecret(plan.secretReference);
    return { apiKey, datasetId };
  }
  async function persistRaw(execution: ControlledRunExecutionInput, result: Inline, sourceAttemptId = execution.attemptId) {
    const raw = await dependencies.ingestion.ingest({
      identity: { tenantId: execution.tenantId, runId: execution.runId, attemptId: sourceAttemptId, kind: "raw", artifactVersion: 1 },
      bytes: result.bytes, contentType: result.contentType, contentEncoding: result.contentEncoding,
      schemaVersion: null, recordCount: null, expiresAt: null,
    });
    return { artifactId: raw.artifactId };
  }
  async function collectSnapshot(execution: ControlledRunExecutionInput, processor: ScraperProcessor,
    apiKey: string, snapshotReference: string, sourceAttemptId: string, initialDelayMs?: number): Promise<Inline> {
    if (!processor.contract.processing.request.snapshot.enabled) throw new ScraperContractError();
    const startedAt = now();
    const checkpoint = (status?: string, failure?: boolean, delayMs?: number) => dependencies.repository.checkpointPoll({
      tenantId: execution.tenantId, runId: execution.runId, attemptId: execution.attemptId, fenceToken: execution.fenceToken,
      sourceAttemptId, maxElapsedMs: dependencies.pollMaxElapsedMs,
      ...(status === undefined ? {} : { status }), ...(failure === undefined ? {} : { failure }),
      ...(delayMs === undefined ? {} : { delayMs }),
    });
    let budget = initialDelayMs === undefined ? await checkpoint() : await checkpoint("starting", undefined, initialDelayMs);
    while (true) {
      execution.signal.throwIfAborted();
      if (budget.remainingMs <= 0 || now() - startedAt >= dependencies.pollMaxElapsedMs) throw new SnapshotFailure("timeout");
      if (budget.consecutiveFailures >= dependencies.pollMaxConsecutiveFailures) throw terminal("UPSTREAM_FAILED", "provider_poll_failures_exhausted");
      if (await dependencies.repository.isCancellationRequested(execution)) {
        if (processor.contract.processing.request.snapshot.cancelEnabled) await dependencies.client.cancel({ apiKey, snapshotReference, signal: execution.signal });
        throw new RunExecutionCancellationError();
      }
      if (budget.waitMs > 0) {
        // Honor provider backoff without a DB round trip every poll interval.
        // A shared five-second ceiling retains responsive cancellation checks;
        // worker lease renewal remains the Job Manager's independent concern.
        await wait(Math.min(budget.waitMs, budget.remainingMs, 5000), execution.signal);
        budget = await checkpoint(); continue;
      }
      try {
        const progress = await dependencies.client.getProgress({ apiKey, snapshotReference, signal: execution.signal });
        budget = await checkpoint(progress.status, progress.status === "ready" ? undefined : false,
          progress.status === "starting" || progress.status === "running" ? dependencies.pollIntervalMs : undefined);
        if (progress.status === "ready") return await dependencies.client.download({ apiKey, snapshotReference, format: "json", signal: execution.signal });
        if (progress.status === "failed") throw new SnapshotFailure("failed");
        if (progress.status === "canceled") throw new RunExecutionCancellationError();
      } catch (error) {
        execution.signal.throwIfAborted();
        if (!(error instanceof BrightDataBoundaryError) || !error.retryable) throw error;
        const status = error.safeReason === "PROVIDER_SNAPSHOT_NOT_READY" ? "not_ready"
          : error.safeReason === "PROVIDER_HTTP_404" ? "missing"
          : error.safeReason === "PROVIDER_STATUS_UNKNOWN" ? "unknown"
          : error.code === "PROVIDER_RATE_LIMITED" ? "rate_limited" : "read_failed";
        const delay = error.retryAfterMs ?? Math.min(60_000, dependencies.pollIntervalMs * 2 ** Math.min(budget.consecutiveFailures, 10));
        budget = await checkpoint(status, status === "not_ready" ? false : true, delay);
        // A first missing/unknown continuation becomes durable reconciliation,
        // never another POST. Recovery consumes the persisted read budget.
        if ((status === "missing" || status === "unknown") && sourceAttemptId === execution.attemptId) throw new RunExecutionReconciliationError();
      }
    }
  }
  return {
    completionOutcomeClass: "provider_execution_completed",
    async persistRaw(execution) {
      try {
        execution.signal.throwIfAborted();
        const plan = await dependencies.repository.resolvePlan(execution, "submission");
        const processor = prepare(plan);
        const targets = processor.serialize(plan.validatedInput); // Before any credential resolution/egress.
        if (await dependencies.repository.isCancellationRequested(execution)) throw new RunExecutionCancellationError();
        const secrets = await credentials(plan);
        const request = processor.contract.processing.request;
        const providerInput = { ...secrets, targets,
          fixedQuery: request.mode === "collect" ? { mode: "collect" as const } : { mode: "discover" as const, discoverBy: request.discoverBy! },
          ...(request.limitPerInput === undefined ? {} : { limitPerInput: request.limitPerInput }), signal: execution.signal };
        const outcome = request.endpoint === "trigger"
          ? { kind: "snapshot" as const, ...await dependencies.client.trigger(providerInput) }
          : await dependencies.client.submit(providerInput);
        if (outcome.kind === "inline") return await persistRaw(execution, outcome);
        const reference = await dependencies.protector.protect(outcome.snapshotReference, providerSnapshotAad(execution));
        await dependencies.repository.recordProviderReference({ ...execution, ciphertext: reference.ciphertext, fingerprint: reference.fingerprint });
        return await persistRaw(execution, await collectSnapshot(execution, processor, secrets.apiKey, outcome.snapshotReference, execution.attemptId, outcome.retryAfterMs));
      } catch (error) { throw safeError(error); }
    },
    async persistNormalized(execution) {
      try {
        execution.signal.throwIfAborted();
        const sourceAttemptId = execution.sourceAttemptId ?? execution.attemptId;
        const plan = await dependencies.repository.resolvePlan(execution, "normalization", sourceAttemptId);
        if (plan.sourceAttemptId !== sourceAttemptId) throw new ScraperContractError();
        const processor = prepare(plan);
        const identity = { tenantId: execution.tenantId, runId: execution.runId, attemptId: sourceAttemptId, artifactVersion: 1 };
        const raw = await dependencies.store.open({ ...identity, kind: "raw" }, dependencies.maxBytes);
        const transformed = await processor.normalize({ bytes: raw.bytes, byteCount: raw.receipt.byteCount,
          contentType: raw.receipt.contentType, contentEncoding: raw.receipt.contentEncoding, maxBytes: dependencies.maxBytes, signal: execution.signal });
        const normalized = await dependencies.ingestion.ingest({ identity: { ...identity, kind: "normalized" },
          bytes: Readable.from([transformed.bytes]), contentType: transformed.contentType, contentEncoding: transformed.contentEncoding,
          schemaVersion: transformed.schemaVersion, recordCount: transformed.recordCount, expiresAt: null });
        return { artifactId: normalized.artifactId, usage: processor.contract.processing.usage };
      } catch (error) { throw safeError(error); }
    },
    async recoverRaw(execution) {
      try {
        execution.signal.throwIfAborted();
        let plan;
        try { plan = await dependencies.repository.resolvePlan(execution, "reconciliation", execution.sourceAttemptId); }
        catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "P0002") return false; throw error; }
        if (plan.sourceAttemptId !== execution.sourceAttemptId) throw new ScraperContractError();
        const processor = prepare(plan);
        if (!Buffer.isBuffer(plan.sourceProviderReferenceCiphertext) || !Buffer.isBuffer(plan.sourceProviderReferenceFingerprint)) throw new ScraperContractError();
        const secrets = await credentials(plan);
        const snapshotReference = await dependencies.protector.reveal(plan.sourceProviderReferenceCiphertext, plan.sourceProviderReferenceFingerprint,
          providerSnapshotAad({ tenantId: execution.tenantId, runId: execution.runId, attemptId: execution.sourceAttemptId }));
        await persistRaw(execution, await collectSnapshot(execution, processor, secrets.apiKey, snapshotReference, execution.sourceAttemptId), execution.sourceAttemptId);
        return true;
      } catch (error) { throw safeError(error); }
    },
  };
}
