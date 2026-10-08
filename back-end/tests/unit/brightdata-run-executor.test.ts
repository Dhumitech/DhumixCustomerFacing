import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  BrightDataBoundaryError,
  type BrightDataIntegrationClient,
} from "../../src/services/brightdata/brightDataIntegrationClient.js";
import {
  createBrightDataRunExecutor,
} from "../../src/services/brightdata/brightDataRunExecutor.js";
import {
  RunExecutionCancellationError,
  RunExecutionTerminalError,
} from "../../src/services/jobs/controlledRunExecutor.js";
import {
  providerDatasetAad,
  providerSnapshotAad,
  type ProviderExecutionPlan,
  type ProviderExecutionPlanRepository,
} from "../../src/services/brightdata/providerExecutionPlanRepository.js";
import { createLocalProviderReferenceProtector } from "../../src/services/brightdata/providerReferenceProtector.js";
import type { SecretProvider } from "../../src/services/secrets/secretProvider.js";
import type { ResultIngestionService } from "../../src/services/storage/resultIngestionService.js";
import type { ResultObjectStore } from "../../src/services/storage/resultObjectStore.js";
import { execution as sharedExecution, sharedScraperFixture } from "../helpers/sharedScraperFixture.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const fenceToken = "44444444-4444-4444-8444-444444444444";
const templateVersionId = "77777777-7777-4777-8777-777777777777";
const sourceAttemptId = "66666666-6666-4666-8666-666666666666";
const snapshotReference = "s_m4x7enmven8djfqak";

async function fixture(options: {
  readonly submission?: "inline" | "snapshot";
  readonly providerExecutionMode?: "scrape" | "trigger";
  readonly cancellationRequested?: boolean;
  readonly cancelEnabled?: boolean;
  readonly planProviderEnvironment?: "local" | "test" | "production";
  readonly executorProviderEnvironment?: "local" | "test" | "production";
  readonly progressStatuses?: readonly ("starting" | "running" | "ready" | "failed" | "canceled")[];
  readonly pollMaxElapsedMs?: number;
  readonly now?: () => number;
  readonly submissionError?: Error;
  readonly rawRecords?: readonly Record<string, unknown>[];
  readonly outputV2?: boolean;
} = {}) {
  const protector = createLocalProviderReferenceProtector(
    "test",
    randomBytes(32).toString("base64url"),
  );
  const protectedMapping = await protector.protect(
    "gd_l7q7dkf244hwjntr0",
    providerDatasetAad(templateVersionId),
  );
  const protectedSnapshot = await protector.protect(
    snapshotReference,
    providerSnapshotAad({ tenantId, runId, attemptId: sourceAttemptId }),
  );
  const plan: ProviderExecutionPlan = {
    templateVersionId,
    validatedInput: {
      targets: [{ url: "https://www.amazon.com/dp/B0CRMZHDG8" }],
    },
    operationCode: "amazon.products.collect_by_url",
    datasetCiphertext: protectedMapping.ciphertext,
    datasetFingerprint: protectedMapping.fingerprint,
    outputPolicy: {
      provider_submission: { endpoint: options.providerExecutionMode ?? "scrape" },
      provider_request: { mode: "collect", limit_per_input: null },
      snapshot: {
        enabled: true,
        cancel_enabled: options.cancelEnabled ?? false,
        multipart_enabled: false,
        format: "json",
      },
      normalizer_code: "amazon.products.collect-by-url.projected-array",
      normalizer_version: options.outputV2 ? 3 : 2,
      normalized_schema_version: options.outputV2 ? "amazon.products.collect-by-url.output.v2" : "amazon.products.collect-by-url.output.v1",
    },
    definitionConfigVersion: "amazon-v1",
    providerCode: "bright_data",
    providerEnvironment: options.planProviderEnvironment ?? "test",
    secretReference: "BRIGHTDATA_API_KEY",
  };
  let failures = 0;
  const repository: ProviderExecutionPlanRepository = {
    resolveExecutorKind: vi.fn(async () => "amazon" as const),
    checkpointPoll: vi.fn(async (input) => {
      if (input.failure === true) failures += 1;
      if (input.failure === false) failures = 0;
      return { remainingMs: 5000, waitMs: 0, consecutiveFailures: failures };
    }),
    resolveSubmission: vi.fn(async () => plan),
    recordProviderReference: vi.fn(async () => undefined),
    resolveReconciliation: vi.fn(async () => ({
      ...plan,
      sourceAttemptId,
      sourceProviderReferenceCiphertext: protectedSnapshot.ciphertext,
      sourceProviderReferenceFingerprint: protectedSnapshot.fingerprint,
    })),
    resolveNormalization: vi.fn(async () => ({
      operationCode: plan.operationCode,
      outputPolicy: plan.outputPolicy,
    })),
    isCancellationRequested: vi.fn(async () => options.cancellationRequested ?? false),
  };
  const secretProvider: SecretProvider = {
    getSecret: vi.fn(async () => "provider-secret-never-returned"),
  };
  const rawBytes = Buffer.from(JSON.stringify(options.rawRecords ?? [{
    asin: "B0CRMZHDG8",
    title: "Insulated tumbler",
    url: "https://www.amazon.com/dp/B0CRMZHDG8",
    domain: "amazon.com",
    currency: "USD",
    final_price: 45,
    initial_price: 50,
    rating: 4.7,
    reviews_count: 1200,
    availability: "In Stock",
    brand: "Example",
    image_url: "https://m.media-amazon.com/images/I/example.jpg",
    timestamp: "2026-08-30T08:56:31.000Z",
  }]), "utf8");
  let progressIndex = 0;
  const progressStatuses = options.progressStatuses ?? ["running", "ready"];
  const client: BrightDataIntegrationClient = {
    listScrapers: vi.fn(async () => []),
    submit: vi.fn(async () => {
      if (options.submissionError !== undefined) throw options.submissionError;
      return options.submission === "snapshot"
        ? { kind: "snapshot" as const, snapshotReference }
        : {
            kind: "inline" as const,
            bytes: Readable.from(rawBytes),
            contentType: "application/json",
            contentEncoding: null,
          };
    }),
    trigger: vi.fn(async () => ({ snapshotReference })),
    getProgress: vi.fn(async () => {
      const status =
        progressStatuses[Math.min(progressIndex, progressStatuses.length - 1)] ?? "running";
      progressIndex += 1;
      return { status };
    }),
    getParts: vi.fn(async () => ({ parts: 1 })),
    download: vi.fn(async () => ({
      kind: "inline" as const,
      bytes: Readable.from(rawBytes),
      contentType: "application/json",
      contentEncoding: null,
    })),
    cancel: vi.fn(async () => undefined),
  };
  const ingested: Array<{
    readonly kind: string;
    readonly attemptId: string;
    readonly bytes: Buffer;
    readonly recordCount: number | null;
  }> = [];
  const ingestion: ResultIngestionService = {
    async ingest(input) {
      const chunks: Buffer[] = [];
      for await (const chunk of input.bytes) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      ingested.push({
        kind: input.identity.kind,
        attemptId: input.identity.attemptId,
        bytes: Buffer.concat(chunks),
        recordCount: input.recordCount,
      });
      return {
        artifactId: `${input.identity.kind}-artifact-id`,
        replayed: false,
        receipt: {
          objectKey: "private-object-key",
          contentType: input.contentType,
          contentEncoding: input.contentEncoding,
          byteCount: rawBytes.byteLength,
          checksumHex: "ab".repeat(32),
          eTag: "etag",
        },
      };
    },
  };
  const store: ResultObjectStore = {
    putImmutable: vi.fn(async () => {
      throw new Error("not used directly");
    }),
    head: vi.fn(async () => null),
    open: vi.fn(async () => ({
      bytes: Readable.from(rawBytes),
      receipt: {
        objectKey: "private-object-key",
        contentType: "application/json",
        contentEncoding: null,
        byteCount: rawBytes.byteLength,
        checksumHex: "ab".repeat(32),
        eTag: "etag",
      },
    })),
  };
  const wait = vi.fn(async (_milliseconds: number, _signal: AbortSignal) => undefined);
  const executor = createBrightDataRunExecutor({
    repository,
    secretProvider,
    protector,
    client,
    ingestion,
    store,
    maxBytes: 4096,
    pollIntervalMs: 100,
    pollMaxElapsedMs: options.pollMaxElapsedMs ?? 5000,
    providerEnvironment: options.executorProviderEnvironment ?? "test",
    wait,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { executor, repository, secretProvider, protector, client, store, ingested, rawBytes, wait };
}

const executionInput = {
  tenantId,
  runId,
  attemptId,
  fenceToken,
  signal: new AbortController().signal,
} as const;

describe("BrightDataRunExecutor", () => {
  it('uses the revised product contract without another provider call when prices are missing', async () => {
    const setup = await fixture({ outputV2: true, rawRecords: [{ asin: 'B00CK01P2A', title: 'Unavailable variant',
      url: 'https://www.amazon.com/dp/B00CK01P2A', domain: 'amazon.com', currency: 'USD', rating: 4.7, reviews_count: 45620,
      brand: 'Filterbuy', image_url: 'https://m.media-amazon.com/images/I/example.jpg', timestamp: '2026-10-08T07:51:30Z' }] });
    const result = await setup.executor.persistNormalized(executionInput);
    expect(result.artifactId).toBe('normalized-artifact-id');
    expect(setup.ingested[0]?.recordCount).toBe(1);
    expect(JSON.parse(setup.ingested[0]!.bytes.toString('utf8'))[0]).toMatchObject({ final_price: null, initial_price: null, availability: null });
    expect(setup.client.submit).not.toHaveBeenCalled();
    expect(setup.client.trigger).not.toHaveBeenCalled();
    expect(setup.client.download).not.toHaveBeenCalled();
  });
  it("measures the new seam removing the legacy error-classification reread without changing its terminal outcome", async () => {
    const records = [{ error: "private fixture failure", error_code: "aborted_page" }];
    const legacy = await fixture({ rawRecords: records });
    const shared = await sharedScraperFixture({ records });
    for (const [executor, input] of [[legacy.executor, executionInput], [shared.executor, sharedExecution]] as const) {
      await executor.persistRaw(input);
      await expect(executor.persistNormalized(input)).rejects.toMatchObject({
        customerErrorCode: "ALL_INPUTS_FAILED", retryable: false, outcomeClass: "provider_all_inputs_failed",
      });
    }
    expect(legacy.store.open).toHaveBeenCalledTimes(2);
    expect(shared.store.open).toHaveBeenCalledOnce();
    expect(shared.processing.stats().parses).toBe(1);
    expect(shared.processing.stats().compilations).toBe(2);
  });
  it("retains error-only raw bytes and classifies normalization terminally", async () => {
    const records = [{ input: { url: "https://www.amazon.in/dp/B0H7S6LT9P" }, error: "private failure", error_code: "aborted_page" }];
    const parts = await fixture({ submission: "snapshot", progressStatuses: ["ready"], rawRecords: records });
    await parts.executor.persistRaw(executionInput);
    await expect(parts.executor.persistNormalized(executionInput)).rejects.toMatchObject({
      customerErrorCode: "ALL_INPUTS_FAILED", retryable: false, outcomeClass: "provider_all_inputs_failed",
    });
    expect(parts.ingested).toHaveLength(1);
    expect(parts.ingested[0]?.bytes).toEqual(Buffer.from(JSON.stringify(records)));
    expect(parts.client.download).toHaveBeenCalledOnce();
  });
  it("retries not-ready downloads without repeating the billable submission", async () => {
    const parts = await fixture({ submission: "snapshot", progressStatuses: ["ready"] });
    vi.mocked(parts.client.download).mockRejectedValueOnce(new BrightDataBoundaryError({
      code: "PROVIDER_UNAVAILABLE", submissionOutcome: "not_applicable", retryable: true,
      safeReason: "PROVIDER_SNAPSHOT_NOT_READY", retryAfterMs: 7000,
    }));
    await parts.executor.persistRaw(executionInput);
    expect(parts.client.download).toHaveBeenCalledTimes(2);
    expect(parts.client.submit).toHaveBeenCalledOnce();
    expect(parts.repository.checkpointPoll).toHaveBeenCalledWith(expect.objectContaining({ status: "not_ready", failure: false, delayMs: 7000 }));
  });
  it("bounds consecutive read failures even when progress repeatedly returns ready", async () => {
    const parts = await fixture({ submission: "snapshot", progressStatuses: ["ready"] });
    vi.mocked(parts.client.download).mockRejectedValue(new BrightDataBoundaryError({
      code: "PROVIDER_UNAVAILABLE", submissionOutcome: "not_applicable", retryable: true,
    }));
    await expect(parts.executor.persistRaw(executionInput)).rejects.toMatchObject({ outcomeClass: "provider_poll_failures_exhausted" });
    expect(parts.client.download).toHaveBeenCalledTimes(5);
    expect(parts.client.submit).toHaveBeenCalledOnce();
  });
  it("does not spend the failure budget on documented not-ready downloads", async () => {
    const parts = await fixture({ submission: "snapshot", progressStatuses: ["ready"] });
    for (let index = 0; index < 6; index += 1) {
      vi.mocked(parts.client.download).mockRejectedValueOnce(new BrightDataBoundaryError({
        code: "PROVIDER_UNAVAILABLE", submissionOutcome: "not_applicable", retryable: true,
        safeReason: "PROVIDER_SNAPSHOT_NOT_READY",
      }));
    }
    await parts.executor.persistRaw(executionInput);
    expect(parts.client.submit).toHaveBeenCalledOnce();
    expect(parts.client.download).toHaveBeenCalledTimes(7);
    expect(parts.ingested).toHaveLength(1);
  });
  it("keeps an already rejected normalization terminal if diagnostic storage reread fails", async () => {
    const parts = await fixture({ rawRecords: [{ error: "private failure" }] });
    const first = await parts.store.open({ tenantId, runId, attemptId, kind: "raw", artifactVersion: 1 }, 4096);
    vi.mocked(parts.store.open).mockResolvedValueOnce(first).mockRejectedValueOnce(new Error("storage offline"));
    await expect(parts.executor.persistNormalized(executionInput)).rejects.toMatchObject({
      name: "RunExecutionTerminalError", customerErrorCode: "UPSTREAM_FAILED", retryable: false,
    });
  });
  it.each(["PROVIDER_HTTP_404", "PROVIDER_STATUS_UNKNOWN"] as const)("reconciles %s then terminates on its durable failure budget", async (safeReason) => {
    const parts = await fixture({ submission: "snapshot" });
    vi.mocked(parts.client.getProgress).mockRejectedValue(new BrightDataBoundaryError({
      code: "PROVIDER_RESPONSE_INVALID", submissionOutcome: "not_applicable", retryable: true, safeReason,
    }));
    await expect(parts.executor.persistRaw(executionInput)).rejects.toMatchObject({ name: "RunExecutionReconciliationError", cause: { safeReason } });
    await expect(parts.executor.recoverRaw!({ ...executionInput, sourceAttemptId })).rejects.toMatchObject({ outcomeClass: "provider_poll_failures_exhausted" });
    expect(parts.client.submit).toHaveBeenCalledOnce();
    expect(parts.client.getProgress).toHaveBeenCalledTimes(5);
  });
  it("does not restart an expired polling deadline during recovery", async () => {
    const parts = await fixture({ submission: "snapshot" });
    vi.mocked(parts.repository.checkpointPoll).mockResolvedValue({ remainingMs: -1, waitMs: 0, consecutiveFailures: 0 });
    await expect(parts.executor.recoverRaw!({ ...executionInput, sourceAttemptId })).rejects.toMatchObject({ customerErrorCode: "PROVIDER_TIMEOUT" });
    expect(parts.client.submit).not.toHaveBeenCalled();
    expect(parts.client.getProgress).not.toHaveBeenCalled();
  });
  it("respects a saved retry wait on recovery without polling past its deadline", async () => {
    const parts = await fixture({ submission: "snapshot" });
    vi.mocked(parts.repository.checkpointPoll)
      .mockResolvedValueOnce({ remainingMs: 1000, waitMs: 11000, consecutiveFailures: 1 })
      .mockResolvedValueOnce({ remainingMs: 0, waitMs: 10000, consecutiveFailures: 1 });
    await expect(parts.executor.recoverRaw!({ ...executionInput, sourceAttemptId }))
      .rejects.toMatchObject({ customerErrorCode: "PROVIDER_TIMEOUT" });
    expect(parts.wait).toHaveBeenCalledWith(100, executionInput.signal);
    expect(parts.client.getProgress).not.toHaveBeenCalled();
    expect(parts.client.submit).not.toHaveBeenCalled();
  });
  it("resolves one fenced plan/secret and persists an inline result", async () => {
    const parts = await fixture();

    await expect(parts.executor.persistRaw(executionInput)).resolves.toEqual({
      artifactId: "raw-artifact-id",
    });

    expect(parts.repository.resolveSubmission).toHaveBeenCalledWith(executionInput);
    expect(parts.secretProvider.getSecret).toHaveBeenCalledWith("BRIGHTDATA_API_KEY");
    expect(parts.client.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "provider-secret-never-returned",
        datasetId: "gd_l7q7dkf244hwjntr0",
        fixedQuery: { mode: "collect" },
      }),
    );
    expect(parts.ingested).toEqual([
      { kind: "raw", attemptId, bytes: parts.rawBytes, recordCount: null },
    ]);
  });

  it("protects a 202 snapshot reference before polling and downloading", async () => {
    const parts = await fixture({ submission: "snapshot" });

    await parts.executor.persistRaw(executionInput);

    expect(parts.repository.recordProviderReference).toHaveBeenCalledOnce();
    const recorded = vi.mocked(parts.repository.recordProviderReference).mock.calls[0]?.[0];
    expect(recorded).toBeDefined();
    expect(recorded?.ciphertext.toString("utf8")).not.toContain(snapshotReference);
    await expect(
      parts.protector.reveal(
        recorded?.ciphertext ?? Buffer.alloc(0),
        recorded?.fingerprint ?? Buffer.alloc(0),
        providerSnapshotAad({ tenantId, runId, attemptId }),
      ),
    ).resolves.toBe(snapshotReference);
    expect(parts.client.getProgress).toHaveBeenCalledTimes(2);
    expect(parts.client.download).toHaveBeenCalledOnce();
    expect(parts.ingested[0]?.bytes).toEqual(parts.rawBytes);
  });

  it("uses only the immutable trigger endpoint selected by the accepted mapping", async () => {
    const parts = await fixture({ providerExecutionMode: "trigger" });

    await parts.executor.persistRaw(executionInput);

    expect(parts.client.trigger).toHaveBeenCalledOnce();
    expect(parts.client.submit).not.toHaveBeenCalled();
    expect(parts.repository.recordProviderReference).toHaveBeenCalledOnce();
    expect(parts.ingested).toEqual([
      { kind: "raw", attemptId, bytes: parts.rawBytes, recordCount: null },
    ]);
  });

  it("copies the durable raw object into the pinned normalized Artifact", async () => {
    const parts = await fixture();

    await expect(parts.executor.persistNormalized(executionInput)).resolves.toEqual({
      artifactId: "normalized-artifact-id",
      usage: {
        meterCode: "amazon.result_records.observed",
        unit: "records",
      },
    });

    expect(parts.store.open).toHaveBeenCalledWith(
      { tenantId, runId, attemptId, kind: "raw", artifactVersion: 1 },
      4096,
    );
    expect(parts.repository.resolveNormalization).toHaveBeenCalledWith({
      tenantId,
      runId,
      attemptId,
      fenceToken,
      sourceAttemptId: attemptId,
    });
    expect(parts.ingested).toEqual([
      { kind: "normalized", attemptId, bytes: parts.rawBytes, recordCount: 1 },
    ]);
  });

  it("uses conditional provider cancel only after a protected snapshot exists", async () => {
    const parts = await fixture({
      submission: "snapshot",
      cancellationRequested: true,
      cancelEnabled: true,
    });

    await expect(parts.executor.persistRaw(executionInput)).rejects.toBeInstanceOf(
      RunExecutionCancellationError,
    );
    expect(parts.client.cancel).toHaveBeenCalledOnce();
    expect(parts.client.download).not.toHaveBeenCalled();
    expect(parts.ingested).toHaveLength(0);
  });

  it("resumes a protected snapshot during reconciliation without another POST", async () => {
    const parts = await fixture({ submission: "snapshot" });

    await expect(
      parts.executor.recoverRaw?.({
        ...executionInput,
        sourceAttemptId,
      }),
    ).resolves.toBe(true);

    expect(parts.client.submit).not.toHaveBeenCalled();
    expect(parts.client.getProgress).toHaveBeenCalledTimes(2);
    expect(parts.client.download).toHaveBeenCalledOnce();
    expect(parts.ingested).toEqual([
      { kind: "raw", attemptId: sourceAttemptId, bytes: parts.rawBytes, recordCount: null },
    ]);
  });

  it("fails closed before egress when the pinned provider environment differs", async () => {
    const parts = await fixture({
      planProviderEnvironment: "production",
      executorProviderEnvironment: "test",
    });

    await expect(parts.executor.persistRaw(executionInput)).rejects.toMatchObject({
      name: "RunExecutionTerminalError",
      customerErrorCode: "SERVICE_UNAVAILABLE",
      retryable: false,
      outcomeClass: "provider_configuration_unavailable",
    });
    expect(parts.client.submit).not.toHaveBeenCalled();
    expect(parts.secretProvider.getSecret).not.toHaveBeenCalled();
  });

  it("maps insufficient provider balance to a non-retryable service failure", async () => {
    const parts = await fixture({
      submissionError: new BrightDataBoundaryError({
        code: "PROVIDER_PAYMENT_REQUIRED",
        submissionOutcome: "known_failed",
        retryable: false,
        safeReason: "PROVIDER_HTTP_402",
      }),
    });

    await expect(parts.executor.persistRaw(executionInput)).rejects.toMatchObject({
      name: "RunExecutionTerminalError",
      customerErrorCode: "SERVICE_UNAVAILABLE",
      retryable: false,
      outcomeClass: "provider_payment_required",
      attemptState: "failed",
    });
    expect(parts.ingested).toHaveLength(0);
  });

  it("turns a bounded snapshot polling timeout into a retryable terminal Run outcome", async () => {
    let now = 0;
    const parts = await fixture({
      submission: "snapshot",
      progressStatuses: ["running"],
      pollMaxElapsedMs: 100,
      now: () => {
        now += 100;
        return now;
      },
    });

    await expect(parts.executor.persistRaw(executionInput)).rejects.toEqual(
      expect.objectContaining<Partial<RunExecutionTerminalError>>({
        name: "RunExecutionTerminalError",
        customerErrorCode: "PROVIDER_TIMEOUT",
        retryable: true,
        outcomeClass: "provider_snapshot_timeout",
      }),
    );
    expect(parts.repository.recordProviderReference).toHaveBeenCalledOnce();
    expect(parts.client.download).not.toHaveBeenCalled();
  });
});
