import { describe, expect, it, vi } from "vitest";
import { BrightDataBoundaryError } from "../../src/services/brightdata/brightDataIntegrationClient.js";
import { execution, recoveryAttemptId, sharedScraperFixture } from "../helpers/sharedScraperFixture.js";

describe("one shared scraper execution pipeline", () => {
  it.each(["target", "lowes", "homedepot", "etsy", "walmart"])("%s uses the same executor, credential port, ingestion and storage", async (name) => {
    const parts = await sharedScraperFixture({ name });
    await expect(parts.executor.persistRaw(execution)).resolves.toEqual({ artifactId: "raw-artifact" });
    expect(parts.ingested[0]?.bytes).toEqual(parts.rawBytes);
    await expect(parts.executor.persistNormalized(execution)).resolves.toEqual({ artifactId: "normalized-artifact",
      usage: { meterCode: `${name}.result_records.observed`, unit: "records" } });
    expect(JSON.parse(parts.ingested[1]!.bytes.toString())).toEqual(parts.fixture.records);
    expect(parts.repository.resolvePlan).toHaveBeenCalledTimes(2);
    expect(parts.client.submit).toHaveBeenCalledOnce();
    expect(parts.secretProvider.getSecret).toHaveBeenCalledOnce(); // Normalization never resolves credentials.
    expect(parts.store.open).toHaveBeenCalledOnce();
    expect(parts.processing.stats()).toMatchObject({ compilations: 2, cacheHits: 1, parses: 1 });
  });
  it("persists an encrypted continuation before polling and obeys initial Retry-After", async () => {
    const parts = await sharedScraperFixture({ snapshot: true, retryAfterMs: 1000 });
    await parts.executor.persistRaw(execution);
    expect(parts.repository.recordProviderReference).toHaveBeenCalledOnce();
    expect(parts.repository.checkpointPoll).toHaveBeenCalledWith(expect.objectContaining({ status: "starting", delayMs: 1000 }));
    expect(parts.wait.mock.calls.reduce((sum, [delay]) => sum + delay, 0)).toBe(1000);
    expect(parts.wait).toHaveBeenCalledOnce();
    expect(parts.repository.checkpointPoll).toHaveBeenCalledTimes(3);
    expect(parts.client.getProgress).toHaveBeenCalledOnce();
    expect(vi.mocked(parts.repository.recordProviderReference).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(parts.client.getProgress).mock.invocationCallOrder[0]!);
    expect(parts.ingested[0]?.bytes).toEqual(parts.rawBytes);
  });
  it("supports an explicitly pinned trigger without submitting to scrape", async () => {
    const parts = await sharedScraperFixture({ endpoint: "trigger" });
    await parts.executor.persistRaw(execution);
    expect(parts.client.trigger).toHaveBeenCalledOnce();
    expect(parts.client.submit).not.toHaveBeenCalled();
  });
  it.each(["all", "mixed"])("retains %s-error raw evidence and reads it exactly once", async (mode) => {
    const records: Record<string, unknown>[] = [{ error: "private provider details", error_code: "aborted_page" }];
    if (mode === "mixed") records.push({ url: "https://www.target.com/p/product", title: "Example", final_price: 1, availability: "in_stock" });
    const parts = await sharedScraperFixture({ records });
    await parts.executor.persistRaw(execution);
    await expect(parts.executor.persistNormalized(execution)).rejects.toMatchObject({
      customerErrorCode: mode === "all" ? "ALL_INPUTS_FAILED" : "UPSTREAM_FAILED", retryable: false,
    });
    expect(parts.ingested).toHaveLength(1);
    expect(parts.ingested[0]?.bytes).toEqual(parts.rawBytes);
    expect(parts.store.open).toHaveBeenCalledOnce();
    expect(parts.processing.stats().parses).toBe(1);
  });
  it.each(["identity", "hash", "environment", "input"])("rejects invalid %s before revealing credentials or submitting", async (mismatch) => {
    const parts = await sharedScraperFixture();
    vi.mocked(parts.repository.resolvePlan).mockResolvedValue({ ...parts.plan,
      ...(mismatch === "identity" ? { identity: { ...parts.plan.identity, version: "unknown" } } : {}),
      ...(mismatch === "hash" ? { contractHash: "00".repeat(32) } : {}),
      ...(mismatch === "environment" ? { providerEnvironment: "production" } : {}),
      ...(mismatch === "input" ? { validatedInput: { targets: [{ url: "https://attacker.example/p/product" }] } } : {}),
    });
    await expect(parts.executor.persistRaw(execution)).rejects.toMatchObject({ customerErrorCode: "SERVICE_UNAVAILABLE" });
    expect(parts.secretProvider.getSecret).not.toHaveBeenCalled();
    expect(parts.client.submit).not.toHaveBeenCalled();
  });
  it("never repeats an ambiguous billable submission", async () => {
    const parts = await sharedScraperFixture();
    vi.mocked(parts.client.submit).mockRejectedValue(new BrightDataBoundaryError({ code: "PROVIDER_SUBMISSION_UNCERTAIN", submissionOutcome: "uncertain", retryable: false }));
    await expect(parts.executor.persistRaw(execution)).rejects.toMatchObject({ name: "RunExecutionReconciliationError" });
    expect(parts.client.submit).toHaveBeenCalledOnce();
    expect(parts.client.trigger).not.toHaveBeenCalled();
    expect(parts.ingested).toHaveLength(0);
  });
  it("recovers only by reading the original continuation and preserves its Artifact identity", async () => {
    const parts = await sharedScraperFixture();
    await expect(parts.executor.recoverRaw!({ ...execution, sourceAttemptId: recoveryAttemptId })).resolves.toBe(true);
    expect(parts.client.submit).not.toHaveBeenCalled();
    expect(parts.client.trigger).not.toHaveBeenCalled();
    expect(parts.repository.checkpointPoll).toHaveBeenCalledWith(expect.objectContaining({ sourceAttemptId: recoveryAttemptId }));
    expect(parts.ingested[0]?.attemptId).toBe(recoveryAttemptId);
  });
  it("keeps ready/download failures in a persisted bounded failure chain", async () => {
    const parts = await sharedScraperFixture({ snapshot: true });
    vi.mocked(parts.client.download).mockRejectedValue(new BrightDataBoundaryError({ code: "PROVIDER_UNAVAILABLE", submissionOutcome: "not_applicable", retryable: true }));
    await expect(parts.executor.persistRaw(execution)).rejects.toMatchObject({ outcomeClass: "provider_poll_failures_exhausted" });
    expect(parts.client.download).toHaveBeenCalledTimes(3);
    expect(parts.client.submit).toHaveBeenCalledOnce();
  });
  it("retryable not-ready reads do not consume the failure count or resubmit", async () => {
    const parts = await sharedScraperFixture({ snapshot: true });
    vi.mocked(parts.client.download).mockRejectedValueOnce(new BrightDataBoundaryError({ code: "PROVIDER_UNAVAILABLE", submissionOutcome: "not_applicable",
      retryable: true, safeReason: "PROVIDER_SNAPSHOT_NOT_READY", retryAfterMs: 1000 }));
    await parts.executor.persistRaw(execution);
    expect(parts.repository.checkpointPoll).toHaveBeenCalledWith(expect.objectContaining({ status: "not_ready", failure: false, delayMs: 1000 }));
    expect(parts.client.download).toHaveBeenCalledTimes(2);
    expect(parts.client.submit).toHaveBeenCalledOnce();
  });
  it("honors a persisted future next-poll time after restart without early reads", async () => {
    const parts = await sharedScraperFixture();
    await parts.repository.checkpointPoll({ ...execution, sourceAttemptId: recoveryAttemptId, maxElapsedMs: 5000, status: "running", delayMs: 1000 });
    await parts.executor.recoverRaw!({ ...execution, sourceAttemptId: recoveryAttemptId });
    expect(parts.wait.mock.calls.reduce((sum, [delay]) => sum + delay, 0)).toBe(1000);
    expect(parts.client.getProgress).toHaveBeenCalledOnce();
  });
  it("terminates on a persisted deadline instead of resetting it after restart", async () => {
    const parts = await sharedScraperFixture();
    vi.mocked(parts.repository.checkpointPoll).mockResolvedValue({ remainingMs: 0, waitMs: 0, consecutiveFailures: 0 });
    await expect(parts.executor.recoverRaw!({ ...execution, sourceAttemptId: recoveryAttemptId })).rejects.toMatchObject({ customerErrorCode: "PROVIDER_TIMEOUT" });
    expect(parts.client.getProgress).not.toHaveBeenCalled();
  });
  it.each([false, true])("only calls upstream cancel when pinned support is %s", async (cancelEnabled) => {
    const parts = await sharedScraperFixture({ snapshot: true, cancelEnabled });
    vi.mocked(parts.repository.isCancellationRequested).mockResolvedValueOnce(false).mockResolvedValue(true);
    await expect(parts.executor.persistRaw(execution)).rejects.toMatchObject({ name: "RunExecutionCancellationError" });
    expect(parts.client.cancel).toHaveBeenCalledTimes(cancelEnabled ? 1 : 0);
    expect(parts.client.getProgress).not.toHaveBeenCalled();
  });
  it.each(["failed", "canceled"] as const)("stops at provider terminal state %s", async (status) => {
    const parts = await sharedScraperFixture({ snapshot: true });
    vi.mocked(parts.client.getProgress).mockResolvedValue({ status });
    await expect(parts.executor.persistRaw(execution)).rejects.toBeDefined();
    expect(parts.client.download).not.toHaveBeenCalled();
    expect(parts.client.getProgress).toHaveBeenCalledOnce();
  });
});
