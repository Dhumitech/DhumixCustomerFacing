import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { BlobServiceClient } from "@azure/storage-blob";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAzuriteResultObjectStore } from "../../src/services/storage/azuriteResultObjectStore.js";
import { createAzuriteResultUrlSigner } from "../../src/services/storage/azuriteResultUrlSigner.js";
import { ResultObjectConflictError } from "../../src/services/storage/resultObjectStore.js";
import { createGetRunResultService } from "../../src/services/runQuery/getRunResultService.js";

const enabled = process.env.RUN_AZURITE_INTEGRATION_TESTS === "true";
const connectionString = process.env.RESULT_STORAGE_CONNECTION_STRING;
const containerName = `dhumi-pattern3-${randomUUID()}`;

const identity = {
  tenantId: randomUUID(),
  runId: randomUUID(),
  attemptId: randomUUID(),
  kind: "normalized",
  artifactVersion: 1,
} as const;

function serviceClient(): BlobServiceClient {
  if (!connectionString) throw new Error("RESULT_STORAGE_CONNECTION_STRING is required");
  return BlobServiceClient.fromConnectionString(connectionString);
}

describe.skipIf(!enabled)("Azurite Pattern 3 result boundary", () => {
  beforeAll(async () => {
    await serviceClient().getContainerClient(containerName).create();
  });

  afterAll(async () => {
    await serviceClient().getContainerClient(containerName).deleteIfExists();
  });

  it("streams exact bytes, confirms same/same, and rejects same/different", async () => {
    const container = serviceClient().getContainerClient(containerName);
    const store = createAzuriteResultObjectStore(container);
    const bytes = Buffer.from('[{"synthetic":true,"source":"pattern-3-test"}]', "utf8");

    const [first, replay] = await Promise.all([
      store.putImmutable({
        identity,
        bytes: Readable.from([bytes.subarray(0, 7), bytes.subarray(7)]),
        contentType: "application/json",
        contentEncoding: null,
        maxBytes: 1_024,
      }),
      store.putImmutable({
        identity,
        bytes: Readable.from(bytes),
        contentType: "application/json",
        contentEncoding: null,
        maxBytes: 1_024,
      }),
    ]);

    expect(first).toMatchObject({
      objectKey: replay.objectKey,
      byteCount: bytes.byteLength,
      checksumHex: createHash("sha256").update(bytes).digest("hex"),
      contentType: "application/json",
      contentEncoding: null,
    });
    expect(replay).toEqual(first);

    const opened = await store.open(identity, 1_024);
    const openedChunks: Buffer[] = [];
    for await (const chunk of opened.bytes) {
      openedChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    expect(Buffer.concat(openedChunks)).toEqual(bytes);
    expect(opened.receipt).toEqual(first);

    await expect(
      store.putImmutable({
        identity,
        bytes: Readable.from("different"),
        contentType: "application/json",
        contentEncoding: null,
        maxBytes: 1_024,
      }),
    ).rejects.toBeInstanceOf(ResultObjectConflictError);
  });

  it("fails oversized input without exposing a committed object", async () => {
    const store = createAzuriteResultObjectStore(serviceClient().getContainerClient(containerName));
    const oversizedIdentity = { ...identity, artifactVersion: 2 };

    await expect(
      store.putImmutable({
        identity: oversizedIdentity,
        bytes: Readable.from(Buffer.alloc(65)),
        contentType: "application/octet-stream",
        contentEncoding: null,
        maxBytes: 64,
      }),
    ).rejects.toMatchObject({ name: "ResultObjectLimitExceededError" });

    await expect(store.head(oversizedIdentity)).resolves.toBeNull();
  });

  it("stores empty bytes and accepts an input exactly at its configured limit", async () => {
    const store = createAzuriteResultObjectStore(serviceClient().getContainerClient(containerName));
    const emptyIdentity = { ...identity, artifactVersion: 5 };
    const boundaryIdentity = { ...identity, artifactVersion: 6 };

    const empty = await store.putImmutable({
      identity: emptyIdentity,
      bytes: Readable.from([]),
      contentType: "application/json",
      contentEncoding: null,
      maxBytes: 64,
    });
    expect(empty).toMatchObject({
      byteCount: 0,
      checksumHex: createHash("sha256").digest("hex"),
    });

    const boundaryBytes = Buffer.alloc(64, 0x61);
    const boundary = await store.putImmutable({
      identity: boundaryIdentity,
      bytes: Readable.from(boundaryBytes),
      contentType: "application/octet-stream",
      contentEncoding: null,
      maxBytes: boundaryBytes.byteLength,
    });
    expect(boundary).toMatchObject({
      byteCount: boundaryBytes.byteLength,
      checksumHex: createHash("sha256").update(boundaryBytes).digest("hex"),
    });
  });

  it("does not expose an object when its source stream terminates with an error", async () => {
    const store = createAzuriteResultObjectStore(serviceClient().getContainerClient(containerName));
    const interruptedIdentity = { ...identity, artifactVersion: 7 };
    const interrupted = Readable.from(
      (async function* (): AsyncGenerator<Buffer> {
        yield Buffer.alloc(4 * 1_024 * 1_024, 0x62);
        throw new Error("synthetic interrupted source");
      })(),
    );

    await expect(
      store.putImmutable({
        identity: interruptedIdentity,
        bytes: interrupted,
        contentType: "application/octet-stream",
        contentEncoding: null,
        maxBytes: 8 * 1_024 * 1_024,
      }),
    ).rejects.toThrow("synthetic interrupted source");

    await expect(store.head(interruptedIdentity)).resolves.toBeNull();
  });

  it("verifies the object before returning a short-lived read-only SAS", async () => {
    const container = serviceClient().getContainerClient(containerName);
    const store = createAzuriteResultObjectStore(container);
    const signingIdentity = { ...identity, artifactVersion: 3 };
    const bytes = Buffer.from("signed synthetic result", "utf8");
    const receipt = await store.putImmutable({
      identity: signingIdentity,
      bytes: Readable.from(bytes),
      contentType: "text/plain",
      contentEncoding: null,
      maxBytes: 1_024,
    });
    const signer = createAzuriteResultUrlSigner({
      container,
      ttlSeconds: 60,
    });

    const signed = await signer.sign({
      objectKey: receipt.objectKey,
      tenantId: signingIdentity.tenantId,
      runId: signingIdentity.runId,
      contentType: receipt.contentType,
      byteCount: receipt.byteCount,
      checksumHex: receipt.checksumHex,
    });

    expect(signed.transport).toBe("loopback-http");
    expect(
      Math.abs(
        new Date(new URL(signed.downloadUrl).searchParams.get("se") ?? "").valueOf() -
          signed.expiresAt.valueOf(),
      ),
    ).toBeLessThan(1_000);
    const download = await fetch(signed.downloadUrl);
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);

    const forbiddenWrite = await fetch(signed.downloadUrl, {
      method: "PUT",
      headers: { "x-ms-blob-type": "BlockBlob" },
      body: "forbidden",
    });
    expect(forbiddenWrite.status).toBe(403);

    const auditCalls: unknown[] = [];
    const serviceResult = await createGetRunResultService({
      repository: {
        async findResult() {
          return {
            kind: "ready" as const,
            artifact: {
              artifactId: randomUUID(),
              objectKey: receipt.objectKey,
              contentType: receipt.contentType,
              byteCount: String(receipt.byteCount),
              checksum: Buffer.from(receipt.checksumHex, "hex"),
            },
          };
        },
        async recordDownloadAuthorization(input) {
          auditCalls.push(input);
        },
      },
      urlSigner: signer,
    }).get({
      principal: {
        kind: "browser",
        userId: randomUUID(),
        sessionId: randomUUID(),
        tenantId: signingIdentity.tenantId,
      },
      runId: signingIdentity.runId,
      schemaErrors: [],
      requestId: randomUUID(),
      ipFingerprint: null,
    });

    expect(serviceResult.download_url).toContain("127.0.0.1:10000");
    expect(auditCalls).toHaveLength(1);
  });

  it("allows a signed download before expiry and rejects the same URL after expiry", async () => {
    const container = serviceClient().getContainerClient(containerName);
    const store = createAzuriteResultObjectStore(container);
    const expiringIdentity = { ...identity, artifactVersion: 8 };
    const bytes = Buffer.from("expiring synthetic result", "utf8");
    const receipt = await store.putImmutable({
      identity: expiringIdentity,
      bytes: Readable.from(bytes),
      contentType: "text/plain",
      contentEncoding: null,
      maxBytes: 1_024,
    });
    const signer = createAzuriteResultUrlSigner({
      container,
      ttlSeconds: 2,
    });

    const signed = await signer.sign({
      objectKey: receipt.objectKey,
      tenantId: expiringIdentity.tenantId,
      runId: expiringIdentity.runId,
      contentType: receipt.contentType,
      byteCount: receipt.byteCount,
      checksumHex: receipt.checksumHex,
    });

    const beforeExpiry = await fetch(signed.downloadUrl);
    expect(beforeExpiry.status).toBe(200);
    expect(Buffer.from(await beforeExpiry.arrayBuffer())).toEqual(bytes);

    const expiryToleranceMs = 1_500;
    const waitMs = Math.max(0, signed.expiresAt.valueOf() - Date.now()) + expiryToleranceMs;
    expect(waitMs).toBeLessThanOrEqual(3_500);
    await delay(waitMs);

    const afterExpiry = await fetch(signed.downloadUrl);
    expect(afterExpiry.status).toBe(403);
    expect(Buffer.from(await afterExpiry.arrayBuffer())).not.toEqual(bytes);
  });

  it("fails closed for missing, corrupt, or wrong-Run objects", async () => {
    const container = serviceClient().getContainerClient(containerName);
    const store = createAzuriteResultObjectStore(container);
    const signer = createAzuriteResultUrlSigner({ container, ttlSeconds: 60 });
    const corruptIdentity = { ...identity, artifactVersion: 4 };
    const receipt = await store.putImmutable({
      identity: corruptIdentity,
      bytes: Readable.from("integrity"),
      contentType: "text/plain",
      contentEncoding: null,
      maxBytes: 1_024,
    });
    const baseInput = {
      objectKey: receipt.objectKey,
      tenantId: corruptIdentity.tenantId,
      runId: corruptIdentity.runId,
      contentType: receipt.contentType,
      byteCount: receipt.byteCount,
      checksumHex: receipt.checksumHex,
    };

    await expect(
      signer.sign({ ...baseInput, runId: randomUUID() }),
    ).rejects.toMatchObject({ name: "ResultObjectIntegrityError" });

    await container.getBlobClient(receipt.objectKey).setMetadata({
      dhumi_sha256: "00".repeat(32),
      dhumi_byte_count: String(receipt.byteCount),
    });
    await expect(signer.sign(baseInput)).rejects.toMatchObject({
      name: "ResultObjectIntegrityError",
    });

    const missingKey = receipt.objectKey.replace("/v4/", "/v5/");
    await expect(
      signer.sign({ ...baseInput, objectKey: missingKey }),
    ).rejects.toBeDefined();
  });
});
