import { BlobSASPermissions, generateBlobSASQueryParameters, SASProtocol, type BlobServiceClient } from "@azure/storage-blob";
import { ResultUrlSigningUnavailableError, type ResultUrlSigner } from "../../helpers/resultUrlSigner.js";
import { isResultObjectKeyForRun } from "./resultObjectIdentity.js";
import { ResultObjectIntegrityError } from "./resultObjectStore.js";

export function createAzureBlobResultUrlSigner(options: {
  readonly service: BlobServiceClient;
  readonly accountName: string;
  readonly containerName: string;
  readonly ttlSeconds: number;
  readonly now?: () => Date;
}): ResultUrlSigner {
  const endpoint = new URL(options.service.url);
  if (!/^[a-z0-9]{3,24}$/.test(options.accountName) || endpoint.protocol !== "https:" ||
    endpoint.hostname !== `${options.accountName}.blob.core.windows.net` || endpoint.port || endpoint.pathname !== "/" ||
    endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
    !Number.isSafeInteger(options.ttlSeconds) || options.ttlSeconds < 30 || options.ttlSeconds > 900) {
    throw new TypeError("Azure Blob signer requires the configured account HTTPS endpoint and bounded expiry");
  }
  const container = options.service.getContainerClient(options.containerName);
  const now = options.now ?? (() => new Date());
  return {
    async sign(input) {
      if (!isResultObjectKeyForRun(input.objectKey, input.tenantId, input.runId)) {
        throw new ResultObjectIntegrityError("Result object key did not match the authorized Run");
      }
      const blob = container.getBlobClient(input.objectKey);
      const properties = await blob.getProperties();
      if (!/^[a-f0-9]{64}$/.test(input.checksumHex) || properties.contentLength !== input.byteCount ||
        properties.contentType !== input.contentType || properties.metadata?.dhumi_sha256 !== input.checksumHex ||
        properties.metadata?.dhumi_byte_count !== String(input.byteCount)) throw new ResultObjectIntegrityError();
      const issuedAt = now();
      const startsOn = new Date(issuedAt.valueOf() - 30_000);
      const expiresAt = new Date(issuedAt.valueOf() + options.ttlSeconds * 1_000);
      let key;
      try { key = await options.service.getUserDelegationKey(startsOn, expiresAt); }
      catch { throw new ResultUrlSigningUnavailableError(); }
      const sas = generateBlobSASQueryParameters({
        containerName: options.containerName,
        blobName: input.objectKey,
        permissions: BlobSASPermissions.parse("r"),
        protocol: SASProtocol.Https,
        startsOn, expiresOn: expiresAt,
        contentType: input.contentType,
        contentDisposition: "attachment",
      }, key, options.accountName).toString();
      return { downloadUrl: `${blob.url}?${sas}`, expiresAt, transport: "https" as const };
    },
  };
}
