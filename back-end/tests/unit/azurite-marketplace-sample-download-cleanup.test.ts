import { randomUUID } from "node:crypto";
import type { ContainerClient } from "@azure/storage-blob";
import { describe, expect, it, vi } from "vitest";
import { createAzuriteMarketplaceSampleDownloadStore } from
  "../../src/services/marketplaceSampleDownload/azuriteMarketplaceSampleDownloadStore.js";
import { MarketplaceSampleDownloadIntegrityError } from
  "../../src/services/marketplaceSampleDownload/marketplaceSampleDownloadStore.js";

function setup() {
  const tenantId = randomUUID();
  const authorizationId = randomUUID();
  const checksumHex = "a".repeat(64);
  const objectKey = `marketplace/sample-downloads/${tenantId}/${authorizationId}/${checksumHex}.json`;
  const receipt = { objectKey, contentType: "application/json; charset=utf-8",
    fileName: "linkedin-posts-sample-v3.json", byteCount: 20, checksumHex };
  const properties = { contentLength: receipt.byteCount, contentType: receipt.contentType,
    contentDisposition: `attachment; filename="${receipt.fileName}"`, etag: '"exact-etag"',
    metadata: { dhumi_sha256: checksumHex, dhumi_byte_count: "20",
      dhumi_file_name: receipt.fileName, dhumi_evidence_class: "marketplace_sample_download" } };
  const blob = { getProperties: vi.fn(async () => properties), deleteIfExists: vi.fn(async () => ({ succeeded: true })) };
  const byPage = vi.fn(() => ({ next: vi.fn(async () => ({ done: false, value: {
    segment: { blobItems: [{ name: objectKey }, { name: "marketplace/sample-downloads/not-owned.txt" }] },
    continuationToken: "next-private-cursor",
  } })) }));
  const container = { url: "http://127.0.0.1:10000/devstoreaccount1/test-container",
    getBlobClient: vi.fn(() => blob), listBlobsFlat: vi.fn(() => ({ byPage })) };
  const store = createAzuriteMarketplaceSampleDownloadStore(container as unknown as ContainerClient);
  return { store, blob, container, properties, byPage, tenantId, authorizationId, receipt };
}

describe("targeted generated-download deletion", () => {
  it("checks the exact receipt and sends an If-Match ETag without snapshot deletion", async () => {
    const context = setup();
    expect(await context.store.deleteIfMatching(context)).toBe("deleted");
    expect(context.container.getBlobClient).toHaveBeenCalledWith(context.receipt.objectKey);
    expect(context.blob.deleteIfExists).toHaveBeenCalledWith({ conditions: { ifMatch: '"exact-etag"' } });
  });

  it("treats missing objects as success without issuing a delete", async () => {
    const context = setup();
    vi.mocked(context.blob.getProperties).mockRejectedValue({ statusCode: 404 });
    expect(await context.store.deleteIfMatching(context)).toBe("absent");
    expect(context.blob.deleteIfExists).not.toHaveBeenCalled();
  });

  it("rejects wrong Tenant, wrong authorization and non-download prefixes before storage access", async () => {
    const context = setup();
    for (const invalid of [
      { ...context, tenantId: randomUUID() },
      { ...context, authorizationId: randomUUID() },
      { ...context, receipt: { ...context.receipt, objectKey: "marketplace/samples/source.json" } },
    ]) {
      await expect(context.store.deleteIfMatching(invalid)).rejects.toBeInstanceOf(MarketplaceSampleDownloadIntegrityError);
    }
    expect(context.blob.getProperties).not.toHaveBeenCalled();
  });

  it("preserves unexpected metadata or changed receipt/checksum", async () => {
    const context = setup();
    await expect(context.store.deleteIfMatching({ ...context,
      receipt: { ...context.receipt, checksumHex: "b".repeat(64) },
    })).rejects.toBeInstanceOf(MarketplaceSampleDownloadIntegrityError);
    context.properties.metadata.dhumi_evidence_class = "marketplace_sample";
    await expect(context.store.deleteIfMatching(context)).rejects.toBeInstanceOf(MarketplaceSampleDownloadIntegrityError);
    expect(context.blob.deleteIfExists).not.toHaveBeenCalled();
  });

  it("fails closed on an ETag race instead of retrying with an unconditional delete", async () => {
    const context = setup();
    vi.mocked(context.blob.deleteIfExists).mockRejectedValue({ statusCode: 412 });
    await expect(context.store.deleteIfMatching(context)).rejects.toMatchObject({ statusCode: 412 });
    expect(context.blob.deleteIfExists).toHaveBeenCalledOnce();
  });

  it("lists only the generated prefix in bounded pages and validates every identity", async () => {
    const context = setup();
    const page = await context.store.listCleanupPage({ limit: 100, cursor: "previous-private-cursor" });
    expect(context.container.listBlobsFlat).toHaveBeenCalledWith({ prefix: "marketplace/sample-downloads/" });
    expect(context.byPage).toHaveBeenCalledWith({ maxPageSize: 100, continuationToken: "previous-private-cursor" });
    expect(page).toEqual({ ignored: 1, nextCursor: "next-private-cursor",
      candidates: [{ objectKey: context.receipt.objectKey, tenantId: context.tenantId,
        authorizationId: context.authorizationId }] });
    await expect(context.store.listCleanupPage({ limit: 0 })).rejects.toThrow();
  });
});
