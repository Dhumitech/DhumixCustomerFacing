import { createHash } from "node:crypto";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";

const OBJECT_KEY_PATTERN =
  /^qualification\/(?:catalog-imports|operations)\/[0-9a-f-]{36}\/[A-Za-z0-9._/-]{1,512}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface QualificationEvidenceDocument {
  readonly objectKey: string;
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly byteCount: number;
  readonly checksumHex: string;
}

export interface QualificationEvidenceReader {
  open(input: {
    readonly objectKey: string;
    readonly maxBytes: number;
  }): Promise<QualificationEvidenceDocument>;
}

export class QualificationEvidenceReadError extends Error {
  public constructor(cause?: unknown) {
    super(
      "Qualification evidence failed integrity validation",
      cause === undefined ? undefined : { cause },
    );
    this.name = "QualificationEvidenceReadError";
  }
}

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

export function createQualificationEvidenceReader(
  container: ContainerClient,
): QualificationEvidenceReader {
  return Object.freeze({
    async open(input: Parameters<QualificationEvidenceReader["open"]>[0]) {
      if (
        !OBJECT_KEY_PATTERN.test(input.objectKey) ||
        !Number.isSafeInteger(input.maxBytes) ||
        input.maxBytes < 2
      ) {
        throw new QualificationEvidenceReadError();
      }
      const blob = container.getBlobClient(input.objectKey);
      try {
        const properties = await blob.getProperties();
        const byteCount = properties.contentLength;
        const checksumHex = properties.metadata?.dhumi_sha256;
        if (
          properties.contentType !== "application/json" ||
          properties.metadata?.dhumi_evidence_class !== "provider_qualification" ||
          byteCount === undefined ||
          !Number.isSafeInteger(byteCount) ||
          byteCount < 2 ||
          byteCount > input.maxBytes ||
          properties.metadata?.dhumi_byte_count !== String(byteCount) ||
          checksumHex === undefined ||
          !SHA256_PATTERN.test(checksumHex) ||
          properties.etag === undefined
        ) {
          throw new QualificationEvidenceReadError();
        }
        const response = await blob.download(0, undefined, {
          conditions: { ifMatch: properties.etag },
        });
        if (
          response.readableStreamBody === undefined ||
          response.contentLength !== byteCount ||
          response.contentType !== "application/json"
        ) {
          throw new QualificationEvidenceReadError();
        }
        const chunks: Buffer[] = [];
        let received = 0;
        for await (const chunk of response.readableStreamBody as AsyncIterable<Uint8Array>) {
          const bytes = Buffer.from(chunk);
          received += bytes.byteLength;
          if (received > input.maxBytes) throw new QualificationEvidenceReadError();
          chunks.push(bytes);
        }
        const bytes = Buffer.concat(chunks);
        if (
          bytes.byteLength !== byteCount ||
          createHash("sha256").update(bytes).digest("hex") !== checksumHex
        ) {
          throw new QualificationEvidenceReadError();
        }
        return Object.freeze({
          objectKey: input.objectKey,
          bytes,
          contentType: "application/json",
          byteCount,
          checksumHex,
        });
      } catch (error) {
        if (error instanceof QualificationEvidenceReadError) throw error;
        if (statusCode(error) === 404 || errorCode(error) === "BlobNotFound") {
          throw new QualificationEvidenceReadError();
        }
        throw new QualificationEvidenceReadError(error);
      }
    },
  });
}

export async function createConfiguredQualificationEvidenceReader(input: {
  readonly connectionString: string;
  readonly containerName: string;
}): Promise<QualificationEvidenceReader> {
  const service = BlobServiceClient.fromConnectionString(input.connectionString);
  const container = service.getContainerClient(input.containerName);
  await container.createIfNotExists();
  const access = await container.getAccessPolicy();
  if (access.blobPublicAccess !== undefined) {
    throw new QualificationEvidenceReadError();
  }
  return createQualificationEvidenceReader(container);
}
