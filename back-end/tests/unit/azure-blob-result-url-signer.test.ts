import { BlobServiceClient, type UserDelegationKey } from "@azure/storage-blob";
import { describe, expect, it, vi } from "vitest";
import { createAzureBlobResultUrlSigner } from "../../src/services/storage/azureBlobResultUrlSigner.js";
import { createResultObjectKey } from "../../src/services/storage/resultObjectIdentity.js";
import { ResultObjectIntegrityError } from "../../src/services/storage/resultObjectStore.js";
import { ResultUrlSigningUnavailableError } from "../../src/helpers/resultUrlSigner.js";

const accountName = "examplestorage123";
const now = new Date("2026-10-08T15:00:00Z");
const identity = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  runId: "22222222-2222-4222-8222-222222222222",
  attemptId: "33333333-3333-4333-8333-333333333333",
  kind: "normalized",
  artifactVersion: 1,
} as const;
const input = { ...identity, objectKey: createResultObjectKey(identity), contentType: "application/json",
  byteCount: 2, checksumHex: "a".repeat(64) };

function fixture() {
  const properties = vi.fn().mockResolvedValue({ contentLength: input.byteCount,
    contentType: input.contentType, metadata: { dhumi_sha256: input.checksumHex,
      dhumi_byte_count: String(input.byteCount) } });
  const key: UserDelegationKey = {
    signedObjectId: "44444444-4444-4444-8444-444444444444",
    signedTenantId: "55555555-5555-4555-8555-555555555555",
    signedStartsOn: new Date(now.valueOf() - 30_000),
    signedExpiresOn: new Date(now.valueOf() + 300_000),
    signedService: "b", signedVersion: "2025-11-05", value: Buffer.alloc(32, 7).toString("base64"),
  };
  const getUserDelegationKey = vi.fn().mockResolvedValue(key);
  const real = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`);
  const container = real.getContainerClient("dhumi-results");
  const blob = container.getBlobClient(input.objectKey);
  vi.spyOn(blob, "getProperties").mockImplementation(properties);
  vi.spyOn(container, "getBlobClient").mockReturnValue(blob);
  vi.spyOn(real, "getContainerClient").mockReturnValue(container);
  vi.spyOn(real, "getUserDelegationKey").mockImplementation(getUserDelegationKey);
  const signer = createAzureBlobResultUrlSigner({ service: real, accountName,
    containerName: "dhumi-results", ttlSeconds: 300, now: () => now });
  return { signer, properties, getUserDelegationKey };
}

describe("Azure Blob result URL signer", () => {
  it("signs one verified blob for HTTPS read-only access with bounded expiry", async () => {
    const { signer, getUserDelegationKey } = fixture();
    const result = await signer.sign(input);
    const url = new URL(result.downloadUrl);
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe(`${accountName}.blob.core.windows.net`);
    expect(url.pathname).toBe(`/dhumi-results/${input.objectKey}`);
    expect(url.searchParams.get("sp")).toBe("r");
    expect(url.searchParams.get("spr")).toBe("https");
    expect(url.searchParams.get("sr")).toBe("b");
    expect(url.searchParams.get("rscd")).toBe("attachment");
    expect(url.searchParams.get("rsct")).toBe(input.contentType);
    expect(new Date(url.searchParams.get("se")!).valueOf()).toBe(now.valueOf() + 300_000);
    expect(result.expiresAt.valueOf()).toBe(now.valueOf() + 300_000);
    expect(result.transport).toBe("https");
    expect(getUserDelegationKey).toHaveBeenCalledWith(new Date(now.valueOf() - 30_000), result.expiresAt);
  });

  it("rejects another organization's object before touching Azure", async () => {
    const { signer, properties, getUserDelegationKey } = fixture();
    await expect(signer.sign({ ...input, tenantId: "66666666-6666-4666-8666-666666666666" }))
      .rejects.toBeInstanceOf(ResultObjectIntegrityError);
    expect(properties).not.toHaveBeenCalled();
    expect(getUserDelegationKey).not.toHaveBeenCalled();
  });

  it.each([
    { contentLength: 99 },
    { contentType: "text/plain" },
    { metadata: { dhumi_sha256: "b".repeat(64), dhumi_byte_count: "2" } },
    { metadata: { dhumi_sha256: input.checksumHex, dhumi_byte_count: "3" } },
  ])("rejects a mismatched storage receipt before generating a SAS (%j)", async mismatch => {
    const { signer, properties, getUserDelegationKey } = fixture();
    properties.mockResolvedValue({ contentLength: input.byteCount, contentType: input.contentType,
      metadata: { dhumi_sha256: input.checksumHex, dhumi_byte_count: String(input.byteCount) }, ...mismatch });
    await expect(signer.sign(input)).rejects.toBeInstanceOf(ResultObjectIntegrityError);
    expect(getUserDelegationKey).not.toHaveBeenCalled();
  });

  it("fails safely when delegation is unavailable without exposing the SDK error", async () => {
    const { signer, getUserDelegationKey } = fixture();
    getUserDelegationKey.mockRejectedValue(new Error("private credential and SDK request"));
    const error = await signer.sign(input).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ResultUrlSigningUnavailableError);
    expect(String(error)).not.toContain("private");
    expect(error).not.toHaveProperty("cause", expect.any(Error));
  });

  it.each(["http://examplestorage123.blob.core.windows.net", "https://other.blob.core.windows.net",
    "https://examplestorage123.blob.core.windows.net:8443", "https://examplestorage123.blob.core.windows.net/other"])
  ("rejects a non-account or non-HTTPS endpoint (%s)", endpoint => {
    expect(() => createAzureBlobResultUrlSigner({ service: new BlobServiceClient(endpoint), accountName,
      containerName: "dhumi-results", ttlSeconds: 300 })).toThrow(TypeError);
  });
});
