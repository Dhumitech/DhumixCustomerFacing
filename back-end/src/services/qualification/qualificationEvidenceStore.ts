import { createHash } from "node:crypto";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";

const OBJECT_KEY_PATTERN =
  /^qualification\/(?:catalog-imports|operations|contact-contracts)\/[0-9a-f-]{36}\/[A-Za-z0-9._/-]{1,512}$/;

export interface QualificationEvidenceReceipt {
  readonly objectKey: string;
  readonly checksumHex: string;
  readonly byteCount: number;
  readonly contentType: string;
  readonly eTag: string;
}

export interface QualificationEvidenceStore {
  putImmutable(input: {
    readonly objectKey: string;
    readonly bytes: Buffer;
    readonly contentType: string;
    readonly maxBytes: number;
  }): Promise<QualificationEvidenceReceipt>;
}

export class QualificationEvidenceConflictError extends Error {
  public constructor() {
    super("Qualification evidence identity already contains different bytes");
    this.name = "QualificationEvidenceConflictError";
  }
}

function validate(input: {
  readonly objectKey: string;
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly maxBytes: number;
}): void {
  if (
    !OBJECT_KEY_PATTERN.test(input.objectKey) ||
    !Buffer.isBuffer(input.bytes) ||
    input.bytes.byteLength > input.maxBytes ||
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes < 1 ||
    !/^[a-z]+\/[a-z0-9.+-]+$/.test(input.contentType)
  ) {
    throw new TypeError("Qualification evidence input is invalid");
  }
}

function checksum(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function storageStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === "number" ? value : undefined;
}

function storageCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" ? value : undefined;
}

async function existingReceipt(
  container: ContainerClient,
  objectKey: string,
): Promise<QualificationEvidenceReceipt | null> {
  const blob = container.getBlobClient(objectKey);
  try {
    const properties = await blob.getProperties();
    const checksumHex = properties.metadata?.dhumi_sha256;
    const byteCount = Number(properties.metadata?.dhumi_byte_count);
    if (
      properties.etag === undefined ||
      properties.contentType === undefined ||
      checksumHex === undefined ||
      !/^[0-9a-f]{64}$/.test(checksumHex) ||
      !Number.isSafeInteger(byteCount) ||
      byteCount < 0
    ) {
      throw new Error("Stored qualification evidence metadata is invalid");
    }
    return {
      objectKey,
      checksumHex,
      byteCount,
      contentType: properties.contentType,
      eTag: properties.etag,
    };
  } catch (error) {
    if (storageStatus(error) === 404) {
      return null;
    }
    throw error;
  }
}

export function createAzuriteQualificationEvidenceStore(
  container: ContainerClient,
): QualificationEvidenceStore {
  return {
    async putImmutable(input): Promise<QualificationEvidenceReceipt> {
      validate(input);
      const checksumHex = checksum(input.bytes);
      const blob = container.getBlockBlobClient(input.objectKey);
      try {
        await blob.uploadData(input.bytes, {
          conditions: { ifNoneMatch: "*" },
          blobHTTPHeaders: { blobContentType: input.contentType },
          metadata: {
            dhumi_sha256: checksumHex,
            dhumi_byte_count: String(input.bytes.byteLength),
            dhumi_evidence_class: "provider_qualification",
          },
        });
      } catch (error) {
        if (
          ![409, 412].includes(storageStatus(error) ?? 0) &&
          !["BlobAlreadyExists", "ConditionNotMet"].includes(storageCode(error) ?? "")
        ) {
          throw error;
        }
        const existing = await existingReceipt(container, input.objectKey);
        if (
          existing === null ||
          existing.checksumHex !== checksumHex ||
          existing.byteCount !== input.bytes.byteLength ||
          existing.contentType !== input.contentType
        ) {
          throw new QualificationEvidenceConflictError();
        }
        return existing;
      }
      const committed = await existingReceipt(container, input.objectKey);
      if (
        committed === null ||
        committed.checksumHex !== checksumHex ||
        committed.byteCount !== input.bytes.byteLength ||
        committed.contentType !== input.contentType
      ) {
        throw new Error("Qualification evidence failed post-write verification");
      }
      return committed;
    },
  };
}

export async function createConfiguredQualificationEvidenceStore(input: {
  readonly connectionString: string;
  readonly containerName: string;
}): Promise<QualificationEvidenceStore> {
  const service = BlobServiceClient.fromConnectionString(input.connectionString);
  const container = service.getContainerClient(input.containerName);
  await container.createIfNotExists();
  const access = await container.getAccessPolicy();
  if (access.blobPublicAccess !== undefined) {
    throw new Error("Qualification evidence container must be private");
  }
  return createAzuriteQualificationEvidenceStore(container);
}
