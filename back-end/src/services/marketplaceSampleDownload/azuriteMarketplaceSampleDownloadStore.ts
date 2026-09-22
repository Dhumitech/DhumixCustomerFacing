import { createHash } from "node:crypto";
import {
  BlobSASPermissions,
  BlobServiceClient,
  SASProtocol,
  type ContainerClient,
} from "@azure/storage-blob";
import {
  MarketplaceSampleDownloadIntegrityError,
  type MarketplaceSampleDownloadReceipt,
  type MarketplaceSampleDownloadStore,
  type MarketplaceSampleDownloadCleanupStore,
  type MarketplaceSampleDownloadCleanupCandidate,
} from "./marketplaceSampleDownloadStore.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const OBJECT_KEY = new RegExp(
  `^marketplace/sample-downloads/(${UUID})/(${UUID})/[0-9a-f]{64}\\.(json|csv)$`,
  "i",
);
const SHA256 = /^[0-9a-f]{64}$/;
const FILE_NAME = /^[a-z0-9][a-z0-9._-]{2,159}\.(json|csv)$/;

function errorStatus(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "statusCode" in error &&
      typeof (error as { statusCode?: unknown }).statusCode === "number"
    ? (error as { statusCode: number }).statusCode
    : undefined;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

function matchesIdentity(objectKey: string, tenantId: string, authorizationId: string): boolean {
  const match = OBJECT_KEY.exec(objectKey);
  return match !== null && match[1]?.toLowerCase() === tenantId.toLowerCase() &&
    match[2]?.toLowerCase() === authorizationId.toLowerCase();
}

function requireLoopback(container: ContainerClient): void {
  const endpoint = new URL(container.url);
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname)) {
    throw new Error("The local Marketplace sample-download signer requires loopback Azurite");
  }
}

function receiptFromProperties(
  objectKey: string,
  properties: {
    readonly contentLength?: number;
    readonly contentType?: string;
    readonly contentDisposition?: string;
    readonly metadata?: Record<string, string>;
    readonly etag?: string;
  },
): MarketplaceSampleDownloadReceipt {
  const byteCount = properties.contentLength;
  const checksumHex = properties.metadata?.dhumi_sha256;
  const fileName = properties.metadata?.dhumi_file_name;
  const contentType = properties.contentType;
  if (byteCount === undefined || !Number.isSafeInteger(byteCount) || byteCount < 1 ||
      checksumHex === undefined || !SHA256.test(checksumHex) ||
      fileName === undefined || !FILE_NAME.test(fileName) ||
      contentType === undefined ||
      properties.metadata?.dhumi_byte_count !== String(byteCount) ||
      properties.metadata?.dhumi_evidence_class !== "marketplace_sample_download" ||
      properties.contentDisposition !== `attachment; filename="${fileName}"` ||
      properties.etag === undefined) {
    throw new MarketplaceSampleDownloadIntegrityError();
  }
  return { objectKey, contentType, fileName, byteCount, checksumHex, eTag: properties.etag };
}

async function head(container: ContainerClient, objectKey: string) {
  try {
    return receiptFromProperties(objectKey, await container.getBlobClient(objectKey).getProperties());
  } catch (error) {
    if (errorStatus(error) === 404 || errorCode(error) === "BlobNotFound") return null;
    throw error;
  }
}

function same(
  actual: MarketplaceSampleDownloadReceipt,
  expected: Omit<MarketplaceSampleDownloadReceipt, "eTag">,
): boolean {
  return actual.objectKey === expected.objectKey && actual.contentType === expected.contentType &&
    actual.fileName === expected.fileName && actual.byteCount === expected.byteCount &&
    actual.checksumHex === expected.checksumHex;
}

export function createAzuriteMarketplaceSampleDownloadStore(
  container: ContainerClient,
): MarketplaceSampleDownloadStore & MarketplaceSampleDownloadCleanupStore {
  requireLoopback(container);
  const store: MarketplaceSampleDownloadStore & MarketplaceSampleDownloadCleanupStore = {
    async putImmutable(input) {
      if (!matchesIdentity(input.objectKey, input.tenantId, input.authorizationId) ||
          !Buffer.isBuffer(input.bytes) || input.bytes.byteLength < 1 ||
          input.bytes.byteLength > input.maxBytes || !FILE_NAME.test(input.fileName) ||
          !["application/json; charset=utf-8", "text/csv; charset=utf-8"].includes(input.contentType)) {
        throw new TypeError("Marketplace sample-download write input is invalid");
      }
      const checksumHex = createHash("sha256").update(input.bytes).digest("hex");
      const expected = {
        objectKey: input.objectKey,
        contentType: input.contentType,
        fileName: input.fileName,
        byteCount: input.bytes.byteLength,
        checksumHex,
      };
      try {
        await container.getBlockBlobClient(input.objectKey).uploadData(input.bytes, {
          conditions: { ifNoneMatch: "*" },
          blobHTTPHeaders: {
            blobContentType: input.contentType,
            blobContentDisposition: `attachment; filename="${input.fileName}"`,
          },
          metadata: {
            dhumi_sha256: checksumHex,
            dhumi_byte_count: String(input.bytes.byteLength),
            dhumi_file_name: input.fileName,
            dhumi_evidence_class: "marketplace_sample_download",
          },
        });
      } catch (error) {
        if (![409, 412].includes(errorStatus(error) ?? 0) &&
            !["BlobAlreadyExists", "ConditionNotMet"].includes(errorCode(error) ?? "")) throw error;
        const existing = await head(container, input.objectKey);
        if (existing === null || !same(existing, expected)) {
          throw new MarketplaceSampleDownloadIntegrityError(error);
        }
        return existing;
      }
      const committed = await head(container, input.objectKey);
      if (committed === null || !same(committed, expected)) {
        throw new MarketplaceSampleDownloadIntegrityError();
      }
      return committed;
    },

    async authorize(input) {
      const issuedAt = new Date();
      if (!matchesIdentity(input.receipt.objectKey, input.tenantId, input.authorizationId) ||
          !(input.expiresAt instanceof Date) || Number.isNaN(input.expiresAt.valueOf()) ||
          !Number.isSafeInteger(input.maxTtlSeconds) || input.maxTtlSeconds < 1 ||
          input.expiresAt.valueOf() <= issuedAt.valueOf() ||
          input.expiresAt.valueOf() > issuedAt.valueOf() + input.maxTtlSeconds * 1000) {
        throw new MarketplaceSampleDownloadIntegrityError();
      }
      const blob = container.getBlobClient(input.receipt.objectKey);
      const current = receiptFromProperties(input.receipt.objectKey, await blob.getProperties());
      if (!same(current, input.receipt)) throw new MarketplaceSampleDownloadIntegrityError();
      const downloadUrl = await blob.generateSasUrl({
        permissions: BlobSASPermissions.parse("r"),
        protocol: SASProtocol.HttpsAndHttp,
        startsOn: new Date(issuedAt.valueOf() - 30_000),
        expiresOn: input.expiresAt,
        contentType: input.receipt.contentType,
        contentDisposition: `attachment; filename="${input.receipt.fileName}"`,
      });
      return { downloadUrl, expiresAt: input.expiresAt, transport: "loopback-http" as const };
    },

    async deleteIfMatching(input) {
      if (!matchesIdentity(input.receipt.objectKey, input.tenantId, input.authorizationId)) {
        throw new MarketplaceSampleDownloadIntegrityError();
      }
      const current = await head(container, input.receipt.objectKey);
      if (current === null) return "absent";
      if (!same(current, input.receipt)) throw new MarketplaceSampleDownloadIntegrityError();
      // Do not include snapshots or versions. A changed ETag or unexpected
      // snapshot fails closed rather than widening the deletion target.
      const result = await container.getBlobClient(input.receipt.objectKey).deleteIfExists({
        conditions: { ifMatch: current.eTag },
      });
      return result.succeeded ? "deleted" : "absent";
    },

    async listCleanupPage(input) {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1000) {
        throw new TypeError("Marketplace sample-download cleanup page limit is invalid");
      }
      const iterator = container.listBlobsFlat({ prefix: "marketplace/sample-downloads/" })
        .byPage({ ...(input.cursor ? { continuationToken: input.cursor } : {}), maxPageSize: input.limit });
      const page = await iterator.next();
      if (page.done) return { candidates: [], ignored: 0, nextCursor: undefined };
      const candidates: MarketplaceSampleDownloadCleanupCandidate[] = [];
      let ignored = 0;
      for (const blob of page.value.segment.blobItems) {
        const match = OBJECT_KEY.exec(blob.name);
        if (match?.[1] === undefined || match[2] === undefined) {
          ignored += 1;
        } else {
          candidates.push({ objectKey: blob.name, tenantId: match[1], authorizationId: match[2] });
        }
      }
      return { candidates, ignored, nextCursor: page.value.continuationToken || undefined };
    },
  };
  return Object.freeze(store);
}

export async function createConfiguredMarketplaceSampleDownloadStore(input: {
  readonly connectionString: string;
  readonly containerName: string;
}): Promise<MarketplaceSampleDownloadStore & MarketplaceSampleDownloadCleanupStore> {
  const container = BlobServiceClient.fromConnectionString(input.connectionString)
    .getContainerClient(input.containerName);
  await container.createIfNotExists();
  if ((await container.getAccessPolicy()).blobPublicAccess !== undefined) {
    throw new Error("Marketplace sample-download container must be private");
  }
  return createAzuriteMarketplaceSampleDownloadStore(container);
}
