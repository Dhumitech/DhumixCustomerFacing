import { z } from "zod";

const optionalValue = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => value === "" ? undefined : value, schema.optional());

export const resultStorageEnvironmentShape = {
  RESULT_STORAGE_DRIVER: z.enum(["unavailable", "azurite", "azure_blob"]).default("unavailable"),
  RESULT_STORAGE_CONNECTION_STRING: optionalValue(z.string().trim().min(1).max(2_048)),
  RESULT_STORAGE_CONTAINER: z.string().trim().regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/).default("dhumi-results"),
  RESULT_DOWNLOAD_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
  RESULT_MAX_BYTES: z.coerce.number().int().min(1_024).max(1_073_741_824).default(104_857_600),
  AZURE_STORAGE_ACCOUNT_NAME: optionalValue(z.string().regex(/^[a-z0-9]{3,24}$/)),
  AZURE_TENANT_ID: optionalValue(z.uuid()),
  AZURE_CLIENT_ID: optionalValue(z.uuid()),
  AZURE_CLIENT_SECRET: optionalValue(z.string().min(1).max(2_048)),
};

export interface ResultStorageRuntimeConfig {
  readonly driver: "unavailable" | "azurite" | "azure_blob";
  readonly connectionString: string | null;
  readonly publicBaseUrl?: string;
  readonly containerName: string;
  readonly downloadTtlSeconds: number;
  readonly maxBytes: number;
  readonly azure?: {
    readonly accountName: string;
    readonly tenantId: string;
    readonly clientId: string;
    readonly clientSecret: string;
  };
}

type StorageEnvironment = z.infer<z.ZodObject<typeof resultStorageEnvironmentShape>> & {
  readonly NODE_ENV: "development" | "test" | "production";
  readonly RESULT_DOWNLOAD_PROXY_URL?: string | undefined;
};

export function addResultStorageChecks(value: StorageEnvironment, context: z.RefinementCtx): void {
  const issue = (path: string, message: string) => context.addIssue({ code: "custom", path: [path], message });
  if (value.RESULT_STORAGE_DRIVER === "azurite") {
    if (!value.RESULT_STORAGE_CONNECTION_STRING) {
      issue("RESULT_STORAGE_CONNECTION_STRING", "is required when RESULT_STORAGE_DRIVER is azurite");
    } else if (value.RESULT_STORAGE_CONNECTION_STRING !== "UseDevelopmentStorage=true" &&
      !/(?:^|;)BlobEndpoint=http:\/\/(?:127\.0\.0\.1|localhost)(?::[0-9]{1,5})?\//i.test(value.RESULT_STORAGE_CONNECTION_STRING)) {
      issue("RESULT_STORAGE_CONNECTION_STRING", "must target loopback Azurite");
    }
    if (value.NODE_ENV === "production") issue("RESULT_STORAGE_DRIVER", "Azurite is forbidden in production");
  }
  if (value.RESULT_STORAGE_DRIVER === "azure_blob") {
    for (const key of ["AZURE_STORAGE_ACCOUNT_NAME", "AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"] as const) {
      if (!value[key]) issue(key, "is required when RESULT_STORAGE_DRIVER is azure_blob");
    }
    if (value.RESULT_STORAGE_CONNECTION_STRING) issue("RESULT_STORAGE_CONNECTION_STRING", "must be unset for Azure client-secret authentication");
    if (value.RESULT_DOWNLOAD_PROXY_URL) issue("RESULT_DOWNLOAD_PROXY_URL", "loopback download proxy must be unset for Azure Blob Storage");
  }
}

export function resultStorageConfiguration(value: StorageEnvironment): ResultStorageRuntimeConfig {
  return Object.freeze({
    driver: value.RESULT_STORAGE_DRIVER,
    connectionString: value.RESULT_STORAGE_DRIVER === "azurite" ? value.RESULT_STORAGE_CONNECTION_STRING ?? null : null,
    ...(value.RESULT_DOWNLOAD_PROXY_URL ? { publicBaseUrl: value.RESULT_DOWNLOAD_PROXY_URL } : {}),
    containerName: value.RESULT_STORAGE_CONTAINER,
    downloadTtlSeconds: value.RESULT_DOWNLOAD_TTL_SECONDS,
    maxBytes: value.RESULT_MAX_BYTES,
    ...(value.RESULT_STORAGE_DRIVER === "azure_blob" ? {
      azure: Object.freeze({ accountName: value.AZURE_STORAGE_ACCOUNT_NAME!, tenantId: value.AZURE_TENANT_ID!,
        clientId: value.AZURE_CLIENT_ID!, clientSecret: value.AZURE_CLIENT_SECRET! }),
    } : {}),
  });
}
