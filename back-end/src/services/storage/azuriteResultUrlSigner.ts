import {
  BlobSASPermissions,
  SASProtocol,
  type ContainerClient,
} from "@azure/storage-blob";
import type {
  ResultUrlSigner,
  ResultUrlSigningInput,
  SignedDownloadUrl,
} from "../../helpers/resultUrlSigner.js";
import { isResultObjectKeyForRun } from "./resultObjectIdentity.js";
import { ResultObjectIntegrityError } from "./resultObjectStore.js";
import { publicDownloadUrl } from "./publicDownloadUrl.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface AzuriteResultUrlSignerOptions {
  readonly container: ContainerClient;
  readonly ttlSeconds: number;
  readonly now?: () => Date;
  readonly publicBaseUrl?: string;
}

function requireLoopbackAzurite(container: ContainerClient): void {
  const endpoint = new URL(container.url);
  if (
    endpoint.protocol !== "http:" ||
    !(["127.0.0.1", "localhost", "::1"] as const).includes(
      endpoint.hostname as "127.0.0.1" | "localhost" | "::1",
    )
  ) {
    throw new Error("Azurite result signer requires a loopback HTTP endpoint");
  }
}

function verifyProperties(
  input: ResultUrlSigningInput,
  properties: {
    readonly contentLength?: number;
    readonly contentType?: string;
    readonly metadata?: Record<string, string>;
  },
): void {
  if (
    !SHA256_PATTERN.test(input.checksumHex) ||
    properties.contentLength !== input.byteCount ||
    properties.contentType !== input.contentType ||
    properties.metadata?.dhumi_sha256 !== input.checksumHex ||
    properties.metadata?.dhumi_byte_count !== String(input.byteCount)
  ) {
    throw new ResultObjectIntegrityError();
  }
}

export function createAzuriteResultUrlSigner(
  options: AzuriteResultUrlSignerOptions,
): ResultUrlSigner {
  requireLoopbackAzurite(options.container);
  if (options.publicBaseUrl) publicDownloadUrl(options.container.url, options.publicBaseUrl);
  if (!Number.isSafeInteger(options.ttlSeconds) || options.ttlSeconds < 1) {
    throw new TypeError("ttlSeconds must be a positive safe integer");
  }
  const now = options.now ?? (() => new Date());

  return {
    async sign(input): Promise<SignedDownloadUrl> {
      if (!isResultObjectKeyForRun(input.objectKey, input.tenantId, input.runId)) {
        throw new ResultObjectIntegrityError("Result object key did not match the authorized Run");
      }
      const blob = options.container.getBlobClient(input.objectKey);
      const properties = await blob.getProperties();
      verifyProperties(input, properties);

      const issuedAt = now();
      const expiresAt = new Date(issuedAt.valueOf() + options.ttlSeconds * 1_000);
      const downloadUrl = await blob.generateSasUrl({
        permissions: BlobSASPermissions.parse("r"),
        protocol: SASProtocol.HttpsAndHttp,
        startsOn: new Date(issuedAt.valueOf() - 30_000),
        expiresOn: expiresAt,
        contentType: input.contentType,
        contentDisposition: "attachment",
      });

      return { ...publicDownloadUrl(downloadUrl, options.publicBaseUrl), expiresAt };
    },
  };
}
