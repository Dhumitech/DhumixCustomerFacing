import { describe, expect, it, vi } from "vitest";
import { ClientSecretCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";
import { configuredAzureBlobService } from "../../src/services/storage/resultStorageComposition.js";
import type { ResultStorageRuntimeConfig } from "../../src/config/environment.js";

const mock = vi.hoisted(() => ({ getProperties: vi.fn(), getContainerClient: vi.fn(),
  createIfNotExists: vi.fn(), setAccessPolicy: vi.fn() }));
vi.mock("@azure/identity", () => ({ ClientSecretCredential: vi.fn(function () {}) }));
vi.mock("@azure/storage-blob", async importOriginal => ({
  ...await importOriginal<typeof import("@azure/storage-blob")>(),
  BlobServiceClient: vi.fn(function () { return { getContainerClient: mock.getContainerClient }; }),
}));

const config: ResultStorageRuntimeConfig = {
  driver: "azure_blob", connectionString: null, containerName: "dhumi-results",
  downloadTtlSeconds: 300, maxBytes: 104_857_600,
  azure: { accountName: "examplestorage123", tenantId: "11111111-1111-4111-8111-111111111111",
    clientId: "22222222-2222-4222-8222-222222222222", clientSecret: "test-only-secret" },
};

describe("Azure Blob runtime composition", () => {
  it("uses portable credentials and the existing private container without provisioning it", async () => {
    mock.getProperties.mockResolvedValue({});
    mock.getContainerClient.mockReturnValue(mock);
    const result = await configuredAzureBlobService(config);
    expect(ClientSecretCredential).toHaveBeenCalledWith(config.azure!.tenantId, config.azure!.clientId, config.azure!.clientSecret);
    expect(BlobServiceClient).toHaveBeenCalledWith("https://examplestorage123.blob.core.windows.net", expect.anything());
    expect(mock.getContainerClient).toHaveBeenCalledWith("dhumi-results");
    expect(result.container).toBe(mock);
    expect(mock.createIfNotExists).not.toHaveBeenCalled();
    expect(mock.setAccessPolicy).not.toHaveBeenCalled();
  });

  it("rejects anonymous container access instead of changing the policy", async () => {
    mock.getProperties.mockResolvedValue({ blobPublicAccess: "blob" });
    mock.getContainerClient.mockReturnValue(mock);
    await expect(configuredAzureBlobService(config)).rejects.toThrow(/anonymous public access/);
    expect(mock.setAccessPolicy).not.toHaveBeenCalled();
  });
});
