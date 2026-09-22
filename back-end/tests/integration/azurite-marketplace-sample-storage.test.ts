import { createHash, randomUUID } from "node:crypto";
import { BlobServiceClient } from "@azure/storage-blob";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAzuriteMarketplaceSampleStore } from
  "../../src/services/marketplaceSample/azuriteMarketplaceSampleStore.js";
import { MarketplaceSampleConflictError } from
  "../../src/services/marketplaceSample/marketplaceSampleStore.js";

const enabled = process.env.RUN_AZURITE_INTEGRATION_TESTS === "true";
const connectionString = process.env.RESULT_STORAGE_CONNECTION_STRING;
const containerName = `dhumi-marketplace-m3-${randomUUID()}`;

function client(): BlobServiceClient {
  if (!connectionString) throw new Error("RESULT_STORAGE_CONNECTION_STRING is required");
  return BlobServiceClient.fromConnectionString(connectionString);
}

describe.skipIf(!enabled)("Azurite M3 Marketplace sample boundary", () => {
  beforeAll(async () => {
    await client().getContainerClient(containerName).create();
  });

  afterAll(async () => {
    await client().getContainerClient(containerName).deleteIfExists();
  });

  it("stores exact private fixture bytes, reads them back, and rejects a conflicting replay", async () => {
    const store = createAzuriteMarketplaceSampleStore(
      client().getContainerClient(containerName),
    );
    const templateVersionId = randomUUID();
    const bytes = Buffer.from('[{"url":"https://www.linkedin.com/posts/synthetic"}]');
    const checksumHex = createHash("sha256").update(bytes).digest("hex");
    const objectKey = `marketplace/samples/${templateVersionId}/1/${checksumHex}.json`;

    const receipt = await store.putImmutable({
      objectKey,
      bytes,
      contentType: "application/json",
      maxBytes: 1024,
    });
    expect(receipt).toMatchObject({
      objectKey,
      byteCount: bytes.byteLength,
      checksumHex,
      contentType: "application/json",
    });
    await expect(store.open(objectKey, 1024)).resolves.toMatchObject({
      receipt,
      bytes,
    });
    await expect(store.putImmutable({
      objectKey,
      bytes: Buffer.from("[]"),
      contentType: "application/json",
      maxBytes: 1024,
    })).rejects.toBeInstanceOf(MarketplaceSampleConflictError);

    await expect(store.deleteAndVerify(objectKey)).resolves.toEqual({
      disposition: "deleted",
    });
    await expect(store.deleteAndVerify(objectKey)).resolves.toEqual({
      disposition: "already_absent",
    });
    await expect(store.open(objectKey, 1024)).rejects.toThrow();

    const policy = await client().getContainerClient(containerName).getAccessPolicy();
    expect(policy.blobPublicAccess).toBeUndefined();
  });
});
