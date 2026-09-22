import { createHash } from "node:crypto";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import {
  MarketplaceSampleConflictError,
  MarketplaceSampleIntegrityError,
  type MarketplaceSampleReceipt,
  type MarketplaceSampleStore,
} from "./marketplaceSampleStore.js";

const OBJECT_KEY_PATTERN =
  /^marketplace\/samples\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[1-9][0-9]{0,8}\/[0-9a-f]{64}\.json$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function statusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  const value = (error as { readonly statusCode?: unknown }).statusCode;
  return typeof value === "number" ? value : undefined;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const value = (error as { readonly code?: unknown }).code;
  return typeof value === "string" ? value : undefined;
}

function isConflict(error: unknown): boolean {
  return [409, 412].includes(statusCode(error) ?? 0) ||
    ["BlobAlreadyExists", "ConditionNotMet"].includes(errorCode(error) ?? "");
}

function validateObjectKey(objectKey: string): void {
  if (!OBJECT_KEY_PATTERN.test(objectKey)) {
    throw new TypeError("Marketplace sample object key is invalid");
  }
}

function validateMaximum(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 2) {
    throw new TypeError("Marketplace sample maximum bytes must be a safe integer of at least two");
  }
}

function receiptFromProperties(
  objectKey: string,
  properties: {
    readonly contentLength?: number;
    readonly contentType?: string;
    readonly metadata?: Record<string, string>;
    readonly etag?: string;
  },
): MarketplaceSampleReceipt {
  const byteCount = properties.contentLength;
  const checksumHex = properties.metadata?.dhumi_sha256;
  if (
    byteCount === undefined ||
    !Number.isSafeInteger(byteCount) ||
    byteCount < 2 ||
    properties.metadata?.dhumi_byte_count !== String(byteCount) ||
    checksumHex === undefined ||
    !SHA256_PATTERN.test(checksumHex) ||
    properties.contentType !== "application/json" ||
    !["marketplace_sample_fixture", "marketplace_sample"].includes(
      properties.metadata?.dhumi_evidence_class ?? "",
    ) ||
    properties.etag === undefined
  ) {
    throw new MarketplaceSampleIntegrityError();
  }
  return {
    objectKey,
    contentType: properties.contentType,
    byteCount,
    checksumHex,
    eTag: properties.etag,
  };
}

async function head(
  container: ContainerClient,
  objectKey: string,
): Promise<MarketplaceSampleReceipt | null> {
  try {
    return receiptFromProperties(
      objectKey,
      await container.getBlobClient(objectKey).getProperties(),
    );
  } catch (error) {
    if (statusCode(error) === 404 || errorCode(error) === "BlobNotFound") return null;
    throw error;
  }
}

function matches(
  receipt: MarketplaceSampleReceipt,
  input: { readonly objectKey: string; readonly byteCount: number; readonly checksumHex: string },
): boolean {
  return receipt.objectKey === input.objectKey &&
    receipt.contentType === "application/json" &&
    receipt.byteCount === input.byteCount &&
    receipt.checksumHex === input.checksumHex;
}

export function createAzuriteMarketplaceSampleStore(
  container: ContainerClient,
): MarketplaceSampleStore {
  return Object.freeze({
    async putImmutable(
      input: Parameters<MarketplaceSampleStore["putImmutable"]>[0],
    ): Promise<MarketplaceSampleReceipt> {
      validateObjectKey(input.objectKey);
      validateMaximum(input.maxBytes);
      if (
        input.contentType !== "application/json" ||
        !Buffer.isBuffer(input.bytes) ||
        input.bytes.byteLength < 2 ||
        input.bytes.byteLength > input.maxBytes
      ) {
        throw new TypeError("Marketplace sample write input is invalid");
      }
      const checksumHex = createHash("sha256").update(input.bytes).digest("hex");
      const expected = {
        objectKey: input.objectKey,
        byteCount: input.bytes.byteLength,
        checksumHex,
      };
      try {
        await container.getBlockBlobClient(input.objectKey).uploadData(input.bytes, {
          conditions: { ifNoneMatch: "*" },
          blobHTTPHeaders: { blobContentType: input.contentType },
          metadata: {
            dhumi_sha256: checksumHex,
            dhumi_byte_count: String(input.bytes.byteLength),
            dhumi_evidence_class: "marketplace_sample",
          },
        });
      } catch (error) {
        if (!isConflict(error)) throw error;
        const existing = await head(container, input.objectKey);
        if (existing === null || !matches(existing, expected)) {
          throw new MarketplaceSampleConflictError();
        }
        return existing;
      }
      const committed = await head(container, input.objectKey);
      if (committed === null || !matches(committed, expected)) {
        throw new MarketplaceSampleIntegrityError();
      }
      return committed;
    },

    async open(objectKey: string, maxBytes: number) {
      validateObjectKey(objectKey);
      validateMaximum(maxBytes);
      const receipt = await head(container, objectKey);
      if (receipt === null || receipt.byteCount > maxBytes) {
        throw new MarketplaceSampleIntegrityError();
      }
      let response;
      try {
        response = await container.getBlobClient(objectKey).download(0, undefined, {
          conditions: { ifMatch: receipt.eTag },
        });
      } catch (error) {
        throw new MarketplaceSampleIntegrityError(error);
      }
      if (
        response.readableStreamBody === undefined ||
        response.contentLength !== receipt.byteCount ||
        response.contentType !== receipt.contentType
      ) {
        throw new MarketplaceSampleIntegrityError();
      }
      const chunks: Buffer[] = [];
      let received = 0;
      for await (const chunk of response.readableStreamBody as AsyncIterable<Uint8Array>) {
        const bytes = Buffer.from(chunk);
        received += bytes.byteLength;
        if (received > maxBytes) throw new MarketplaceSampleIntegrityError();
        chunks.push(bytes);
      }
      const bytes = Buffer.concat(chunks);
      if (
        bytes.byteLength !== receipt.byteCount ||
        createHash("sha256").update(bytes).digest("hex") !== receipt.checksumHex
      ) {
        throw new MarketplaceSampleIntegrityError();
      }
      return { receipt, bytes };
    },

    async deleteAndVerify(objectKey: string) {
      validateObjectKey(objectKey);
      const existing = await head(container, objectKey);
      if (existing === null) {
        return { disposition: "already_absent" as const };
      }
      try {
        await container.getBlobClient(objectKey).delete({
          conditions: { ifMatch: existing.eTag },
        });
      } catch (error) {
        if (statusCode(error) === 404 || errorCode(error) === "BlobNotFound") {
          return { disposition: "already_absent" as const };
        }
        throw new MarketplaceSampleIntegrityError(error);
      }
      if (await head(container, objectKey) !== null) {
        throw new MarketplaceSampleIntegrityError();
      }
      return { disposition: "deleted" as const };
    },
  });
}

export async function createConfiguredMarketplaceSampleStore(input: {
  readonly connectionString: string;
  readonly containerName: string;
}): Promise<MarketplaceSampleStore> {
  const service = BlobServiceClient.fromConnectionString(input.connectionString);
  const container = service.getContainerClient(input.containerName);
  await container.createIfNotExists();
  const access = await container.getAccessPolicy();
  if (access.blobPublicAccess !== undefined) {
    throw new Error("Marketplace sample container must be private");
  }
  return createAzuriteMarketplaceSampleStore(container);
}
