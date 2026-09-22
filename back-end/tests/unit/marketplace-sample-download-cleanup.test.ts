import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { cleanupMarketplaceSampleDownloads } from
  "../../src/services/marketplaceSampleDownload/marketplaceSampleDownloadCleanup.js";
import type { MarketplaceSampleDownloadCleanupRepository } from
  "../../src/services/marketplaceSampleDownload/marketplaceSampleDownloadCleanupRepository.js";
import type { MarketplaceSampleDownloadCleanupStore } from
  "../../src/services/marketplaceSampleDownload/marketplaceSampleDownloadStore.js";
import { parseSampleDownloadCleanupCommand } from "../../src/worker/marketplaceSampleDownloadCleanup.js";
import { loadSampleDownloadCleanupConfig } from "../../src/config/sampleDownloadCleanupEnvironment.js";

function setup() {
  const candidate = { tenantId: randomUUID(), authorizationId: randomUUID(), objectKey: "private-key" };
  const receipt = { objectKey: candidate.objectKey, contentType: "application/json; charset=utf-8",
    fileName: "linkedin-posts-sample-v3.json", byteCount: 20, checksumHex: "a".repeat(64) };
  const repository: MarketplaceSampleDownloadCleanupRepository = {
    claim: vi.fn(async () => ({ kind: "eligible" as const, receipt })),
  };
  const store: MarketplaceSampleDownloadCleanupStore = {
    listCleanupPage: vi.fn(async () => ({ candidates: [candidate], ignored: 0, nextCursor: undefined })),
    deleteIfMatching: vi.fn(async () => "deleted" as const),
  };
  return { candidate, receipt, repository, store,
    run: (maxPages = 10) => cleanupMarketplaceSampleDownloads({ repository, store, pageSize: 100, maxPages }) };
}

describe("generated sample-download cleanup", () => {
  it("deletes only after a confirmed eligible database claim and returns a key-free report", async () => {
    const context = setup();
    const summary = await context.run();
    expect(summary).toMatchObject({ deleted: 1, examined: 1, failures: 0, complete: true });
    expect(context.repository.claim).toHaveBeenCalledWith(context.candidate);
    expect(context.store.deleteIfMatching).toHaveBeenCalledWith({
      tenantId: context.candidate.tenantId, authorizationId: context.candidate.authorizationId,
      receipt: context.receipt,
    });
    expect(JSON.stringify(summary)).not.toContain(context.candidate.objectKey);
  });

  it.each(["protected", "untracked"] as const)("preserves %s objects", async (kind) => {
    const context = setup();
    vi.mocked(context.repository.claim).mockResolvedValue({ kind });
    expect((await context.run())[kind]).toBe(1);
    expect(context.store.deleteIfMatching).not.toHaveBeenCalled();
  });

  it("preserves objects if the database claim fails or has an uncertain commit", async () => {
    const context = setup();
    vi.mocked(context.repository.claim).mockRejectedValue(new Error("commit response lost"));
    expect(await context.run()).toMatchObject({ failures: 1, deleted: 0 });
    expect(context.store.deleteIfMatching).not.toHaveBeenCalled();
  });

  it("reports storage failure and can retry the same object on the next inventory", async () => {
    const context = setup();
    vi.mocked(context.store.deleteIfMatching).mockRejectedValueOnce(new Error("etag changed"));
    expect(await context.run()).toMatchObject({ failures: 1, deleted: 0 });
    expect(await context.run()).toMatchObject({ failures: 0, deleted: 1 });
  });

  it("treats an already absent object as idempotent success", async () => {
    const context = setup();
    vi.mocked(context.store.deleteIfMatching).mockResolvedValue("absent");
    expect(await context.run()).toMatchObject({ failures: 0, absent: 1 });
  });

  it("drains bounded pages and fails completeness if the scan budget is exhausted", async () => {
    const context = setup();
    vi.mocked(context.store.listCleanupPage)
      .mockResolvedValueOnce({ candidates: [], ignored: 1, nextCursor: "private-cursor" });
    expect(await context.run(1)).toMatchObject({ pages: 1, ignored: 1, complete: false });
    vi.mocked(context.store.listCleanupPage)
      .mockResolvedValueOnce({ candidates: [], ignored: 0, nextCursor: "private-cursor" });
    expect(await context.run()).toMatchObject({ pages: 2, deleted: 1, complete: true });
    expect(context.store.listCleanupPage).toHaveBeenLastCalledWith({ limit: 100, cursor: "private-cursor" });
  });

  it("rejects invalid bounds and requires explicit deletion/database confirmation", async () => {
    const context = setup();
    await expect(context.run(0)).rejects.toThrow("bounds");
    expect(() => parseSampleDownloadCleanupCommand([])).toThrow("confirm");
    expect(() => parseSampleDownloadCleanupCommand(["--confirm-delete-generated-objects"])).toThrow("identity");
    expect(parseSampleDownloadCleanupCommand([
      "--expected-database", "dhumi_dev", "--confirm-delete-generated-objects",
    ])).toEqual({ expectedDatabase: "dhumi_dev", pageSize: 100, maxPages: 1000 });
    expect(() => parseSampleDownloadCleanupCommand([
      "--expected-database", "dhumi_dev", "--page-size", "1001", "--confirm-delete-generated-objects",
    ])).toThrow("bounds");
  });

  it("loads storage-only configuration without any provider or queue credentials", () => {
    const config = loadSampleDownloadCleanupConfig({
      NODE_ENV: "test", DATABASE_HOST: "127.0.0.1", DATABASE_NAME: "dhumi_test",
      DATABASE_OPERATOR_USER: "dhumi_test_operator_login", DATABASE_OPERATOR_PASSWORD: "x".repeat(32),
      RESULT_STORAGE_DRIVER: "azurite", RESULT_STORAGE_CONNECTION_STRING: "private-local-connection",
      RESULT_STORAGE_CONTAINER: "dhumi-test-results",
    });
    expect(config.database.database).toBe("dhumi_test");
    expect(config).not.toHaveProperty("executor");
    expect(() => loadSampleDownloadCleanupConfig({ NODE_ENV: "production" })).toThrow();
  });
});
