import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type {
  MarketplaceFilterClient,
  MarketplaceSnapshotMetadata,
} from "../../src/services/brightdata/marketplace/marketplaceFilterClient.js";
import { MarketplaceFilterBoundaryError } from "../../src/services/brightdata/marketplace/marketplaceFilterClient.js";
import {
  createMarketplaceRunExecutor,
  type MarketplaceExecutionPlan,
  type MarketplaceExecutionPlanRepository,
} from "../../src/services/brightdata/marketplace/marketplaceRunExecutor.js";
import {
  RunExecutionCancellationError,
  RunExecutionReconciliationError,
} from "../../src/services/jobs/controlledRunExecutor.js";
import { providerMappingAad, providerSnapshotAad } from "../../src/services/brightdata/providerExecutionPlanRepository.js";
import { createLocalProviderReferenceProtector } from "../../src/services/brightdata/providerReferenceProtector.js";
import type { ResultIngestionService } from "../../src/services/storage/resultIngestionService.js";
import type { ResultObjectStore } from "../../src/services/storage/resultObjectStore.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const sourceAttemptId = "44444444-4444-4444-8444-444444444444";
const fenceToken = "55555555-5555-4555-8555-555555555555";
const mappingId = "66666666-6666-4666-8666-666666666666";
const snapshotReference = "s_fixture123";
const rawBytes = Buffer.from(JSON.stringify([{
  url: "https://www.linkedin.com/posts/example-001",
  text: "Fixture text",
  provider_only: "must-not-enter-normalized",
}]));

const executionInput = {
  tenantId, runId, attemptId, fenceToken,
  signal: new AbortController().signal,
} as const;

async function fixture(options: {
  readonly statuses?: readonly MarketplaceSnapshotMetadata["status"][];
  readonly metadataErrors?: readonly Error[];
  readonly submitError?: Error;
  readonly cancellationRequested?: boolean;
  readonly cancellationSequence?: readonly boolean[];
  readonly reconciliationMissing?: boolean;
  readonly remainingMs?: number;
  readonly metadataDatasetId?: string;
  readonly selectedFields?: readonly string[];
  readonly pollMaxConsecutiveFailures?: number;
} = {}) {
  const protector = createLocalProviderReferenceProtector(
    "test",
    randomBytes(32).toString("base64url"),
  );
  const protectedDataset = await protector.protect("gd_lyy3tktm25m4avu764", providerMappingAad(mappingId));
  const protectedSnapshot = await protector.protect(
    snapshotReference,
    providerSnapshotAad({ tenantId, runId, attemptId: sourceAttemptId }),
  );
  const plan: MarketplaceExecutionPlan = {
    mappingId,
    providerResourceAadMappingId: mappingId,
    validatedInput: { records_limit: 2 },
    validatedConfiguration: {
      selected_fields: options.selectedFields ?? ["url", "text"],
      filter: { name: "url", operator: "is_not_null" },
    },
    templateSlug: "linkedin-posts",
    templateVersion: 2,
    templateOutputSchema: {
      type: "array",
      items: {
        type: "object",
        properties: {
          url: { type: "string", format: "uri" },
          text: { type: ["string", "null"] },
        },
      },
    },
    adapterCode: "bright_data.marketplace.filter",
    providerResourceCiphertext: protectedDataset.ciphertext,
    providerResourceFingerprint: protectedDataset.fingerprint,
    outputPolicy: {
      provider_operation: "filter",
      transport: "fixture",
      records_limit_max: 100,
      snapshot: { format: "json", compress: false },
      normalizer_code: "marketplace.linkedin-posts.selected-fields",
      normalizer_version: 1,
      normalized_schema_version: "marketplace.linkedin-posts.output.v1",
      usage: { meter_code: "marketplace.result_records.observed", unit: "records" },
      provider_cost: { currency_code: "USD" },
    },
    providerCode: "bright_data",
    providerEnvironment: "test",
    vaultSecretReference: "BRIGHTDATA_API_KEY",
  };
  let protectedReference: { ciphertext: Buffer; fingerprint: Buffer } | undefined;
  let statusIndex = 0;
  let metadataErrorIndex = 0;
  let cancellationIndex = 0;
  let failures = 0;
  const statuses = options.statuses ?? ["scheduled", "building", "ready"];
  const metadataErrors = options.metadataErrors ?? [];
  const cancellationSequence = options.cancellationSequence ?? [];
  const repository: MarketplaceExecutionPlanRepository = {
    resolveSubmission: vi.fn(async () => plan),
    resolveNormalization: vi.fn(async () => plan),
    resolveReconciliation: vi.fn(async () => {
      if (options.reconciliationMissing) throw Object.assign(new Error("not found"), { code: "P0002" });
      return {
        ...plan,
        sourceAttemptId,
        sourceProviderReferenceCiphertext: protectedSnapshot.ciphertext,
        sourceProviderReferenceFingerprint: protectedSnapshot.fingerprint,
      };
    }),
    recordProviderReference: vi.fn(async (input) => {
      protectedReference = { ciphertext: input.ciphertext, fingerprint: input.fingerprint };
    }),
    checkpointPoll: vi.fn(async (input) => {
      if (input.failure === true) failures += 1;
      if (input.failure === false) failures = 0;
      return { remainingMs: options.remainingMs ?? 5000, waitMs: 0, consecutiveFailures: failures };
    }),
    recordSnapshotObservation: vi.fn(async () => undefined),
    recordKnownSubmissionOutcome: vi.fn(async () => undefined),
    isCancellationRequested: vi.fn(async () => {
      const sequenced = cancellationSequence[cancellationIndex];
      cancellationIndex += 1;
      return sequenced ?? options.cancellationRequested ?? false;
    }),
  };
  const client: MarketplaceFilterClient = {
    transport: "fixture",
    submit: vi.fn(async () => {
      if (options.submitError) throw options.submitError;
      return { snapshotReference };
    }),
    getSnapshotMetadata: vi.fn(async () => {
      const metadataError = metadataErrors[metadataErrorIndex];
      metadataErrorIndex += 1;
      if (metadataError !== undefined) throw metadataError;
      const status = statuses[Math.min(statusIndex, statuses.length - 1)] ?? "ready";
      statusIndex += 1;
      return {
        id: snapshotReference,
        status,
        datasetId: options.metadataDatasetId ?? "gd_lyy3tktm25m4avu764",
        datasetSize: status === "ready" ? 1 : null,
        fileSize: status === "ready" ? rawBytes.byteLength : null,
        cost: status === "ready" ? 0.0025 : null,
      };
    }),
    downloadSnapshot: vi.fn(async () => ({
      bytes: Readable.from([rawBytes]),
      contentType: "application/json" as const,
      contentEncoding: null,
    })),
  };
  const ingested: Array<{ kind: string; attemptId: string; bytes: Buffer; recordCount: number | null }> = [];
  const ingestion: ResultIngestionService = {
    async ingest(input) {
      const chunks: Buffer[] = [];
      for await (const chunk of input.bytes) chunks.push(Buffer.from(chunk as Uint8Array));
      const bytes = Buffer.concat(chunks);
      ingested.push({ kind: input.identity.kind, attemptId: input.identity.attemptId, bytes, recordCount: input.recordCount });
      return {
        artifactId: `${input.identity.kind}-artifact`, replayed: false,
        receipt: {
          objectKey: "private-key", contentType: input.contentType,
          contentEncoding: input.contentEncoding, byteCount: bytes.byteLength,
          checksumHex: "ab".repeat(32), eTag: "etag",
        },
      };
    },
  };
  const store: ResultObjectStore = {
    putImmutable: vi.fn(async () => { throw new Error("unused"); }),
    head: vi.fn(async () => null),
    open: vi.fn(async () => ({
      bytes: Readable.from([rawBytes]),
      receipt: {
        objectKey: "private-key", contentType: "application/json",
        contentEncoding: null, byteCount: rawBytes.byteLength,
        checksumHex: "ab".repeat(32), eTag: "etag",
      },
    })),
  };
  const secretProvider = { getSecret: vi.fn(async () => "private-provider-key") };
  const executor = createMarketplaceRunExecutor({
    repository,
    protector,
    client,
    secretProvider,
    ingestion,
    store,
    maxBytes: 4096,
    pollIntervalMs: 10,
    pollMaxElapsedMs: 5000,
    ...(options.pollMaxConsecutiveFailures === undefined
      ? {}
      : { pollMaxConsecutiveFailures: options.pollMaxConsecutiveFailures }),
    wait: vi.fn(async () => undefined),
  });
  return { executor, repository, client, secretProvider, protector, ingested, getProtectedReference: () => protectedReference };
}

describe("M7 Marketplace fixture Run executor", () => {
  it("submits once, protects the Snapshot reference, checkpoints states, and stores exact raw bytes", async () => {
    const parts = await fixture();
    await expect(parts.executor.persistRaw(executionInput)).resolves.toEqual({ artifactId: "raw-artifact" });
    expect(parts.client.submit).toHaveBeenCalledOnce();
    expect(parts.client.getSnapshotMetadata).toHaveBeenCalledTimes(3);
    expect(parts.repository.checkpointPoll).toHaveBeenCalledWith(expect.objectContaining({ status: "scheduled" }));
    expect(parts.repository.checkpointPoll).toHaveBeenCalledWith(expect.objectContaining({ status: "building" }));
    expect(parts.repository.checkpointPoll).toHaveBeenCalledWith(expect.objectContaining({ status: "ready" }));
    expect(parts.repository.recordSnapshotObservation).toHaveBeenCalledOnce();
    expect(parts.repository.recordSnapshotObservation).toHaveBeenCalledWith(expect.objectContaining({
      status: "ready", datasetSize: 1, fileSize: rawBytes.byteLength, costMicros: 2500,
    }));
    expect(parts.ingested).toEqual([{ kind: "raw", attemptId, bytes: rawBytes, recordCount: null }]);

    const protectedReference = parts.getProtectedReference();
    expect(protectedReference).toBeDefined();
    expect(protectedReference?.ciphertext.toString("utf8")).not.toContain(snapshotReference);
    await expect(parts.protector.reveal(
      protectedReference?.ciphertext ?? Buffer.alloc(0),
      protectedReference?.fingerprint ?? Buffer.alloc(0),
      providerSnapshotAad({ tenantId, runId, attemptId }),
    )).resolves.toBe(snapshotReference);
  });

  it("projects only selected reviewed fields and returns a record-based usage observation", async () => {
    const parts = await fixture();
    await expect(parts.executor.persistNormalized(executionInput)).resolves.toEqual({
      artifactId: "normalized-artifact",
      usage: { meterCode: "marketplace.result_records.observed", unit: "records" },
    });
    expect(parts.ingested).toEqual([{
      kind: "normalized",
      attemptId,
      bytes: Buffer.from('[{"url":"https://www.linkedin.com/posts/example-001","text":"Fixture text"}]'),
      recordCount: 1,
    }]);
  });

  it.each([
    [[] as readonly string[]],
    [["url", "url"] as readonly string[]],
    [["unreviewed_provider_field"] as readonly string[]],
  ])("rejects an invalid selected-field projection before secret access or submission: %j", async (selectedFields) => {
    const parts = await fixture({ selectedFields });
    await expect(parts.executor.persistRaw(executionInput)).rejects.toMatchObject({
      customerErrorCode: "SERVICE_UNAVAILABLE",
      outcomeClass: "provider_configuration_unavailable",
    });
    expect(parts.secretProvider.getSecret).not.toHaveBeenCalled();
    expect(parts.client.submit).not.toHaveBeenCalled();
    expect(parts.ingested).toHaveLength(0);
  });

  it.each([
    [401, "MARKETPLACE_FILTER_CREDENTIAL_REJECTED", "credential_rejected", "SERVICE_UNAVAILABLE", "failed"],
    [402, "MARKETPLACE_FILTER_PAYMENT_REQUIRED", "payment_required", "SERVICE_UNAVAILABLE", "failed"],
    [422, "MARKETPLACE_FILTER_ZERO_MATCHES", "zero_matches", "NO_MATCHES", "rejected"],
    [429, "MARKETPLACE_FILTER_RATE_LIMITED", "rate_limited", "UPSTREAM_REJECTED", "rejected"],
  ] as const)("records known submission HTTP %s without a second submission", async (_status, code, outcome, customerErrorCode, attemptState) => {
    const parts = await fixture({ submitError: new MarketplaceFilterBoundaryError({
      code, retryable: false, submissionOutcome: "known_failed",
    }) });
    await expect(parts.executor.persistRaw(executionInput)).rejects.toMatchObject({ customerErrorCode, attemptState });
    expect(parts.client.submit).toHaveBeenCalledOnce();
    expect(parts.repository.recordKnownSubmissionOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome }));
    expect(parts.ingested).toHaveLength(0);
  });

  it.each([
    ["MARKETPLACE_FILTER_CREDENTIAL_REJECTED", "SERVICE_UNAVAILABLE", "provider_credential_rejected"],
    ["MARKETPLACE_FILTER_CONFIGURATION_INVALID", "SERVICE_UNAVAILABLE", "provider_configuration_unavailable"],
    ["MARKETPLACE_FILTER_RESPONSE_INVALID", "UPSTREAM_FAILED", "provider_response_invalid"],
  ] as const)("does not misclassify %s as a customer request rejection", async (code, customerErrorCode, outcomeClass) => {
    const parts = await fixture({ submitError: new MarketplaceFilterBoundaryError({
      code, retryable: false, submissionOutcome: "known_failed",
    }) });
    await expect(parts.executor.persistRaw(executionInput)).rejects.toMatchObject({
      customerErrorCode,
      outcomeClass,
      attemptState: "failed",
    });
    expect(parts.client.submit).toHaveBeenCalledOnce();
  });

  it("fails terminally when provider metadata says failed", async () => {
    const parts = await fixture({ statuses: ["failed"] });
    await expect(parts.executor.persistRaw(executionInput)).rejects.toMatchObject({
      customerErrorCode: "UPSTREAM_FAILED", outcomeClass: "provider_snapshot_failed",
    });
    expect(parts.repository.recordSnapshotObservation).toHaveBeenCalledOnce();
    expect(parts.client.downloadSnapshot).not.toHaveBeenCalled();
  });

  it("rejects Snapshot metadata that identifies a different Dataset", async () => {
    const parts = await fixture({
      statuses: ["ready"],
      metadataDatasetId: "gd_different123",
    });
    await expect(parts.executor.persistRaw(executionInput)).rejects.toMatchObject({
      customerErrorCode: "UPSTREAM_FAILED",
      outcomeClass: "provider_response_invalid",
      attemptState: "failed",
    });
    expect(parts.client.downloadSnapshot).not.toHaveBeenCalled();
    expect(parts.repository.recordSnapshotObservation).not.toHaveBeenCalled();
  });

  it("honors Dhumi cancellation without inventing a provider cancel request", async () => {
    const parts = await fixture({ cancellationRequested: true });
    await expect(parts.executor.persistRaw(executionInput)).rejects.toBeInstanceOf(RunExecutionCancellationError);
    expect(parts.client.submit).toHaveBeenCalledOnce();
    expect(parts.client.getSnapshotMetadata).not.toHaveBeenCalled();
    expect(parts.ingested).toHaveLength(0);
  });

  it("retries a documented not-ready download inside the persisted polling budget without resubmitting", async () => {
    const parts = await fixture({ statuses: ["ready", "ready"] });
    vi.mocked(parts.client.downloadSnapshot)
      .mockRejectedValueOnce(new MarketplaceFilterBoundaryError({
        code: "MARKETPLACE_FILTER_SNAPSHOT_NOT_READY",
        retryable: true,
        submissionOutcome: "not_applicable",
      }));

    await expect(parts.executor.persistRaw(executionInput)).resolves.toEqual({ artifactId: "raw-artifact" });
    expect(parts.client.submit).toHaveBeenCalledOnce();
    expect(parts.client.getSnapshotMetadata).toHaveBeenCalledTimes(2);
    expect(parts.client.downloadSnapshot).toHaveBeenCalledTimes(2);
    expect(parts.repository.checkpointPoll).toHaveBeenCalledWith(expect.objectContaining({
      status: "not_ready",
      failure: false,
    }));
  });

  it("persists provider polling rate-limit backoff and resumes without repeating submission", async () => {
    const parts = await fixture({
      statuses: ["ready"],
      metadataErrors: [new MarketplaceFilterBoundaryError({
        code: "MARKETPLACE_FILTER_RATE_LIMITED",
        retryable: true,
        submissionOutcome: "not_applicable",
        retryAfterMs: 45_000,
      })],
    });

    await expect(parts.executor.persistRaw(executionInput)).resolves.toEqual({ artifactId: "raw-artifact" });
    expect(parts.client.submit).toHaveBeenCalledOnce();
    expect(parts.client.getSnapshotMetadata).toHaveBeenCalledTimes(2);
    expect(parts.repository.checkpointPoll).toHaveBeenCalledWith(expect.objectContaining({
      status: "rate_limited",
      failure: true,
      delayMs: 45_000,
    }));
    expect(parts.ingested).toHaveLength(1);
  });

  it("terminates after the persisted polling failure budget without repeating submission", async () => {
    const readFailure = () => new MarketplaceFilterBoundaryError({
      code: "MARKETPLACE_FILTER_UNAVAILABLE",
      retryable: true,
      submissionOutcome: "not_applicable",
    });
    const parts = await fixture({
      metadataErrors: [readFailure(), readFailure()],
      pollMaxConsecutiveFailures: 2,
    });

    await expect(parts.executor.persistRaw(executionInput)).rejects.toMatchObject({
      customerErrorCode: "UPSTREAM_FAILED",
      retryable: false,
      outcomeClass: "provider_poll_failures_exhausted",
    });
    expect(parts.client.submit).toHaveBeenCalledOnce();
    expect(parts.client.getSnapshotMetadata).toHaveBeenCalledTimes(2);
    expect(parts.ingested).toHaveLength(0);
  });

  it("stops after cancellation wins during polling and never downloads partial output", async () => {
    const parts = await fixture({
      statuses: ["scheduled"],
      cancellationSequence: [false, true],
    });

    await expect(parts.executor.persistRaw(executionInput)).rejects.toBeInstanceOf(
      RunExecutionCancellationError,
    );
    expect(parts.client.submit).toHaveBeenCalledOnce();
    expect(parts.client.getSnapshotMetadata).toHaveBeenCalledOnce();
    expect(parts.client.downloadSnapshot).not.toHaveBeenCalled();
    expect(parts.ingested).toHaveLength(0);
  });

  it("recovers a protected Snapshot without repeating the Filter submission", async () => {
    const parts = await fixture({ statuses: ["ready"] });
    await expect(parts.executor.recoverRaw?.({ ...executionInput, sourceAttemptId })).resolves.toBe(true);
    expect(parts.client.submit).not.toHaveBeenCalled();
    expect(parts.client.downloadSnapshot).toHaveBeenCalledOnce();
    expect(parts.ingested).toEqual([{ kind: "raw", attemptId: sourceAttemptId, bytes: rawBytes, recordCount: null }]);
  });

  it("enters reconciliation on an ambiguous POST and never submits during recovery", async () => {
    const parts = await fixture({
      submitError: new MarketplaceFilterBoundaryError({
        code: "MARKETPLACE_FILTER_SUBMISSION_UNCERTAIN",
        retryable: false,
        submissionOutcome: "uncertain",
      }),
      reconciliationMissing: true,
    });
    await expect(parts.executor.persistRaw(executionInput)).rejects.toBeInstanceOf(RunExecutionReconciliationError);
    await expect(parts.executor.recoverRaw?.({ ...executionInput, sourceAttemptId })).resolves.toBe(false);
    expect(parts.client.submit).toHaveBeenCalledOnce();
  });

  it("does not restart an expired durable polling deadline", async () => {
    const parts = await fixture({ remainingMs: 0 });
    await expect(parts.executor.recoverRaw?.({ ...executionInput, sourceAttemptId })).rejects.toMatchObject({
      customerErrorCode: "PROVIDER_TIMEOUT", outcomeClass: "provider_snapshot_timeout",
    });
    expect(parts.client.submit).not.toHaveBeenCalled();
    expect(parts.client.getSnapshotMetadata).not.toHaveBeenCalled();
  });
});
