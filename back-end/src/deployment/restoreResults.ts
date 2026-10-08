import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { BlobServiceClient } from "@azure/storage-blob";

interface StoredBlob { key: string; sha256: string; bytes: number; contentType: string; metadata: Record<string, string> }
const value: unknown = JSON.parse(await readFile("/restore/blobs.private.json", "utf8"));
if (!Array.isArray(value) || value.length > 100_000) throw new Error("Invalid result backup manifest");
const container = BlobServiceClient.fromConnectionString(process.env.RESULT_STORAGE_CONNECTION_STRING ?? "")
  .getContainerClient(process.env.RESULT_STORAGE_CONTAINER ?? "");
await container.createIfNotExists();
if ((await container.getAccessPolicy()).blobPublicAccess) throw new Error("Result backup target must be private");
for (const entry of value as StoredBlob[]) {
  if (!entry || typeof entry.key !== "string" || entry.key.startsWith("/") || entry.key.includes("..") || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0)
    throw new Error("Invalid result backup entry");
  const bytes = await readFile(`/restore/blobs/${entry.sha256}.bin`);
  if (bytes.length !== entry.bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error("Result backup integrity failed");
  const blob = container.getBlockBlobClient(entry.key);
  if (await blob.exists()) {
    const existing = await blob.downloadToBuffer();
    if (createHash("sha256").update(existing).digest("hex") !== entry.sha256) throw new Error("Existing result differs from its backup; refusing overwrite");
  } else await blob.uploadData(bytes, { conditions: { ifNoneMatch: "*" }, metadata: entry.metadata, blobHTTPHeaders: { blobContentType: entry.contentType } });
}
console.log(JSON.stringify({ restoredResultObjects: value.length }));
