import { createHash, randomUUID } from "node:crypto";
import { BlobServiceClient } from "@azure/storage-blob";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAzuriteMarketplaceSampleDownloadStore } from
  "../../src/services/marketplaceSampleDownload/azuriteMarketplaceSampleDownloadStore.js";
import { MarketplaceSampleDownloadIntegrityError } from
  "../../src/services/marketplaceSampleDownload/marketplaceSampleDownloadStore.js";

const enabled = process.env.RUN_AZURITE_INTEGRATION_TESTS === "true";
const connectionString = process.env.RESULT_STORAGE_CONNECTION_STRING;
const containerName = `dhumi-marketplace-m5-${randomUUID()}`;

function client(): BlobServiceClient {
  if (!connectionString) throw new Error("RESULT_STORAGE_CONNECTION_STRING is required");
  return BlobServiceClient.fromConnectionString(connectionString);
}

describe.skipIf(!enabled)("Azurite M5 Marketplace sample-download boundary", () => {
  beforeAll(async () => {
    await client().getContainerClient(containerName).create();
  });

  afterAll(async () => {
    await client().getContainerClient(containerName).deleteIfExists();
  });

  it("stores exact private bytes and issues a tenant-bound read-only expiring URL", async () => {
    const container = client().getContainerClient(containerName);
    const store = createAzuriteMarketplaceSampleDownloadStore(container);
    const tenantId = randomUUID();
    const authorizationId = randomUUID();
    const bytes = Buffer.from('[{"url":"https://linkedin.example/posts/1","text":"Synt***one."}]\n');
    const checksumHex = createHash("sha256").update(bytes).digest("hex");
    const objectKey = `marketplace/sample-downloads/${tenantId}/${authorizationId}/${checksumHex}.json`;
    const receipt = await store.putImmutable({
      objectKey,
      tenantId,
      authorizationId,
      bytes,
      contentType: "application/json; charset=utf-8",
      fileName: "linkedin-posts-sample-v1.json",
      maxBytes: 1024,
    });

    expect(receipt).toMatchObject({ objectKey, byteCount: bytes.byteLength, checksumHex });
    expect((await container.getAccessPolicy()).blobPublicAccess).toBeUndefined();
    await expect(store.authorize({
      receipt,
      tenantId: randomUUID(),
      authorizationId,
      expiresAt: new Date(Date.now() + 5_000),
      maxTtlSeconds: 5,
    })).rejects.toBeInstanceOf(MarketplaceSampleDownloadIntegrityError);

    const signed = await store.authorize({
      receipt,
      tenantId,
      authorizationId,
      expiresAt: new Date(Date.now() + 1_000),
      maxTtlSeconds: 1,
    });
    const beforeExpiry = await fetch(signed.downloadUrl);
    expect(beforeExpiry.status).toBe(200);
    const downloaded = Buffer.from(await beforeExpiry.arrayBuffer());
    expect(downloaded.equals(bytes)).toBe(true);
    expect(createHash("sha256").update(downloaded).digest("hex")).toBe(checksumHex);
    expect(beforeExpiry.headers.get("content-disposition"))
      .toContain('filename="linkedin-posts-sample-v1.json"');

    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const afterExpiry = await fetch(signed.downloadUrl);
    expect(afterExpiry.status).toBe(403);
  });

  it("deletes only the exact generated object and can safely repeat deletion", async () => {
    const container = client().getContainerClient(containerName);
    const store = createAzuriteMarketplaceSampleDownloadStore(container);
    const tenantId = randomUUID();
    const authorizationId = randomUUID();
    const bytes = Buffer.from('[{"text":"masked***sample"}]\n');
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const receipt = await store.putImmutable({
      tenantId, authorizationId, bytes,
      objectKey: `marketplace/sample-downloads/${tenantId}/${authorizationId}/${checksum}.json`,
      contentType: "application/json; charset=utf-8", fileName: "linkedin-posts-sample-v3.json", maxBytes: 1024,
    });
    const source = container.getBlockBlobClient("marketplace/samples/not-a-generated-download.json");
    await source.uploadData(bytes);
    await expect(store.deleteIfMatching({ tenantId: randomUUID(), authorizationId, receipt }))
      .rejects.toBeInstanceOf(MarketplaceSampleDownloadIntegrityError);
    await expect(store.deleteIfMatching({ tenantId, authorizationId,
      receipt: { ...receipt, checksumHex: "b".repeat(64) },
    })).rejects.toBeInstanceOf(MarketplaceSampleDownloadIntegrityError);
    expect(await container.getBlobClient(receipt.objectKey).exists()).toBe(true);
    const page = await store.listCleanupPage({ limit: 100 });
    expect(page.candidates.some((candidate) => candidate.objectKey === receipt.objectKey)).toBe(true);
    expect(page.candidates.some((candidate) => candidate.objectKey === source.name)).toBe(false);
    expect(await store.deleteIfMatching({ tenantId, authorizationId, receipt })).toBe("deleted");
    expect(await store.deleteIfMatching({ tenantId, authorizationId, receipt })).toBe("absent");
    expect(await source.exists()).toBe(true);
  });
});
