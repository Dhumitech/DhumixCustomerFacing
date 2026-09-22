import { BlobServiceClient } from "@azure/storage-blob";
import type { ResultStorageRuntimeConfig } from "../../config/environment.js";
import {
  createUnavailableResultUrlSigner,
  type ResultUrlSigner,
} from "../../helpers/resultUrlSigner.js";
import { createAzuriteResultUrlSigner } from "./azuriteResultUrlSigner.js";
import { createAzuriteResultObjectStore } from "./azuriteResultObjectStore.js";
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

export async function createConfiguredResultObjectStore(
  config: ResultStorageRuntimeConfig & { readonly driver: "azurite" },
): Promise<ResultObjectStore> {
  return createAzuriteResultObjectStore(await configuredAzuriteContainer(config));
}

export async function createConfiguredResultUrlSigner(
  config: ResultStorageRuntimeConfig,
): Promise<ResultUrlSigner> {
  if (config.driver === "unavailable") return createUnavailableResultUrlSigner();
  const container = await configuredAzuriteContainer(config);
  return createAzuriteResultUrlSigner({
    container,
    ttlSeconds: config.downloadTtlSeconds,
  });
}
