import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { ContainerClient } from "@azure/storage-blob";
import { createResultObjectKey } from "./resultObjectIdentity.js";
import {
  ResultObjectConflictError,
  ResultObjectIntegrityError,
  ResultObjectLimitExceededError,
  type PutResultObjectInput,
  type OpenResultObjectOutcome,
  type ResultObjectReceipt,
  type ResultObjectStore,
} from "./resultObjectStore.js";

const BLOCK_SIZE_BYTES = 4 * 1_024 * 1_024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONTENT_TYPE_PATTERN =
  /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;\s*[a-z0-9!#$&^_.+-]+=[a-z0-9!#$&^_.+"'()-]+)*$/i;
const CONTENT_ENCODING_PATTERN = /^[a-z0-9!#$&^_.+-]{1,64}$/i;

interface HttpErrorShape {
  readonly statusCode?: unknown;
  readonly code?: unknown;
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as HttpErrorShape).statusCode;
  return typeof value === "number" ? value : undefined;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as HttpErrorShape).code;
  return typeof value === "string" ? value : undefined;
}

function isNotFound(error: unknown): boolean {
  return statusCode(error) === 404 || errorCode(error) === "BlobNotFound";
}

function isImmutableConflict(error: unknown): boolean {
  return (
    statusCode(error) === 409 ||
    statusCode(error) === 412 ||
    errorCode(error) === "BlobAlreadyExists" ||
    errorCode(error) === "ConditionNotMet"
  );
}

function validateWriteInput(input: PutResultObjectInput): void {
  if (!CONTENT_TYPE_PATTERN.test(input.contentType)) {
    throw new TypeError("contentType must be a safe media type");
  }
  if (
    input.contentEncoding !== null &&
    !CONTENT_ENCODING_PATTERN.test(input.contentEncoding)
  ) {
    throw new TypeError("contentEncoding must be a safe token or null");
  }
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) {
    throw new TypeError("maxBytes must be a positive safe integer");
  }
}

function receiptFromProperties(
  objectKey: string,
  properties: {
    readonly contentLength?: number;
    readonly contentType?: string;
    readonly contentEncoding?: string;
    readonly metadata?: Record<string, string>;
    readonly etag?: string;
  },
): ResultObjectReceipt {
  const checksumHex = properties.metadata?.dhumi_sha256;
  const byteCountMetadata = properties.metadata?.dhumi_byte_count;
  const byteCount = properties.contentLength;
  if (
    byteCount === undefined ||
    !Number.isSafeInteger(byteCount) ||
    byteCount < 0 ||
    byteCountMetadata !== String(byteCount) ||
    checksumHex === undefined ||
    !SHA256_PATTERN.test(checksumHex) ||
    properties.contentType === undefined ||
    properties.etag === undefined
  ) {
    throw new ResultObjectIntegrityError();
  }

  return {
    objectKey,
    contentType: properties.contentType,
    contentEncoding: properties.contentEncoding ?? null,
    byteCount,
    checksumHex,
    eTag: properties.etag,
  };
}

function receiptsMatch(
  existing: ResultObjectReceipt,
  incoming: Omit<ResultObjectReceipt, "eTag">,
): boolean {
  return (
    existing.objectKey === incoming.objectKey &&
    existing.contentType === incoming.contentType &&
    existing.contentEncoding === incoming.contentEncoding &&
    existing.byteCount === incoming.byteCount &&
    existing.checksumHex === incoming.checksumHex
  );
}

function fixedLengthBlockId(writerId: string, index: number): string {
  return Buffer.from(`${writerId}:${String(index).padStart(8, "0")}`, "ascii").toString(
    "base64",
  );
}

async function stageStream(
  input: PutResultObjectInput,
  stage: (blockId: string, bytes: Buffer) => Promise<void>,
): Promise<{ readonly blockIds: readonly string[]; readonly byteCount: number; readonly checksumHex: string }> {
  const writerId = randomUUID();
  const blockIds: string[] = [];
  const hash = createHash("sha256");
  let byteCount = 0;
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  const stageOne = async (bytes: Buffer): Promise<void> => {
    const blockId = fixedLengthBlockId(writerId, blockIds.length);
    await stage(blockId, bytes);
    blockIds.push(blockId);
  };

  for await (const chunk of input.bytes) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    if (byteCount + bytes.byteLength > input.maxBytes) {
      throw new ResultObjectLimitExceededError();
    }
    byteCount += bytes.byteLength;
    hash.update(bytes);
    pending = pending.byteLength === 0 ? bytes : Buffer.concat([pending, bytes]);

    while (pending.byteLength >= BLOCK_SIZE_BYTES) {
      await stageOne(pending.subarray(0, BLOCK_SIZE_BYTES));
      pending = pending.subarray(BLOCK_SIZE_BYTES);
    }
  }

  if (pending.byteLength > 0) await stageOne(pending);
  return { blockIds, byteCount, checksumHex: hash.digest("hex") };
}

export function createAzuriteResultObjectStore(
  container: ContainerClient,
): ResultObjectStore {
  return {
    async putImmutable(input): Promise<ResultObjectReceipt> {
      validateWriteInput(input);
      const objectKey = createResultObjectKey(input.identity);
      const blob = container.getBlockBlobClient(objectKey);
      const staged = await stageStream(input, async (blockId, bytes) => {
        await blob.stageBlock(blockId, bytes, bytes.byteLength);
      });
      const incoming = {
        objectKey,
        contentType: input.contentType,
        contentEncoding: input.contentEncoding,
        byteCount: staged.byteCount,
        checksumHex: staged.checksumHex,
      };

      try {
        const response = await blob.commitBlockList([...staged.blockIds], {
          conditions: { ifNoneMatch: "*" },
          blobHTTPHeaders: {
            blobContentType: input.contentType,
            ...(input.contentEncoding === null
              ? {}
              : { blobContentEncoding: input.contentEncoding }),
          },
          metadata: {
            dhumi_sha256: staged.checksumHex,
            dhumi_byte_count: String(staged.byteCount),
          },
        });
        if (response.etag === undefined) throw new ResultObjectIntegrityError();
      } catch (error) {
        if (!isImmutableConflict(error)) throw error;
        const existing = await this.head(input.identity);
        if (existing === null || !receiptsMatch(existing, incoming)) {
          throw new ResultObjectConflictError();
        }
        return existing;
      }

      const committed = await this.head(input.identity);
      if (committed === null || !receiptsMatch(committed, incoming)) {
        throw new ResultObjectIntegrityError();
      }
      return committed;
    },

    async head(identity): Promise<ResultObjectReceipt | null> {
      const objectKey = createResultObjectKey(identity);
      try {
        const properties = await container.getBlobClient(objectKey).getProperties();
        return receiptFromProperties(objectKey, properties);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async open(identity, maxBytes): Promise<OpenResultObjectOutcome> {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
        throw new TypeError("maxBytes must be a positive safe integer");
      }
      const receipt = await this.head(identity);
      if (receipt === null || receipt.byteCount > maxBytes) {
        throw new ResultObjectIntegrityError();
      }
      const blob = container.getBlobClient(receipt.objectKey);
      let response;
      try {
        response = await blob.download(0, undefined, {
          conditions: { ifMatch: receipt.eTag },
        });
      } catch (error) {
        throw new ResultObjectIntegrityError(undefined, error);
      }
      if (
        response.readableStreamBody === undefined ||
        response.contentLength !== receipt.byteCount ||
        response.contentType !== receipt.contentType ||
        (response.contentEncoding ?? null) !== receipt.contentEncoding
      ) {
        throw new ResultObjectIntegrityError();
      }
      return {
        receipt,
        bytes: Readable.from(response.readableStreamBody as AsyncIterable<Uint8Array>),
      };
    },
  };
}
