import { BlobServiceClient } from "@azure/storage-blob";
import { ClientSecretCredential } from "@azure/identity";
import type { ResultStorageRuntimeConfig } from "../../config/environment.js";
import {
  createUnavailableResultUrlSigner,
  type ResultUrlSigner,
} from "../../helpers/resultUrlSigner.js";
import { createAzuriteResultUrlSigner } from "./azuriteResultUrlSigner.js";
import { createBlobResultObjectStore } from "./blobResultObjectStore.js";
import { createAzureBlobResultUrlSigner } from "./azureBlobResultUrlSigner.js";
import type { ResultObjectStore } from "./resultObjectStore.js";

async function configuredAzuriteContainer(config: ResultStorageRuntimeConfig) {
  if (config.driver !== "azurite" || config.connectionString === null) {
    throw new Error("Azurite result storage configuration is incomplete");
  }
  const service = BlobServiceClient.fromConnectionString(config.connectionString);
  const container = service.getContainerClient(config.containerName);
  await container.createIfNotExists();
  const access = await container.getAccessPolicy();
  if (access.blobPublicAccess !== undefined) {
    throw new Error("Result container must not permit anonymous public access");
  }
  return container;
}

export async function configuredAzureBlobService(config: ResultStorageRuntimeConfig) {
  if (config.driver !== "azure_blob" || !config.azure) throw new Error("Azure Blob configuration is incomplete");
  const { accountName, tenantId, clientId, clientSecret } = config.azure;
  const service = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`,
    new ClientSecretCredential(tenantId, clientId, clientSecret));
  const container = service.getContainerClient(config.containerName);
  // Infrastructure creates the container; runtime never changes its access policy.
  if ((await container.getProperties()).blobPublicAccess !== undefined) {
    throw new Error("Result container must not permit anonymous public access");
  }
  return { service, container };
}

export async function createConfiguredResultObjectStore(
  config: ResultStorageRuntimeConfig & { readonly driver: "azurite" | "azure_blob" },
): Promise<ResultObjectStore> {
  if (config.driver === "azure_blob") {
    return createBlobResultObjectStore((await configuredAzureBlobService(config)).container);
  }
  return createBlobResultObjectStore(await configuredAzuriteContainer(config));
}

export async function createConfiguredResultUrlSigner(
  config: ResultStorageRuntimeConfig,
): Promise<ResultUrlSigner> {
  if (config.driver === "unavailable") return createUnavailableResultUrlSigner();
  if (config.driver === "azure_blob") {
    const { service } = await configuredAzureBlobService(config);
    return createAzureBlobResultUrlSigner({ service, accountName: config.azure!.accountName,
      containerName: config.containerName, ttlSeconds: config.downloadTtlSeconds });
  }
  const container = await configuredAzuriteContainer(config);
  return createAzuriteResultUrlSigner({
    container,
    ttlSeconds: config.downloadTtlSeconds,
    ...(config.publicBaseUrl ? { publicBaseUrl: config.publicBaseUrl } : {}),
  });
}
