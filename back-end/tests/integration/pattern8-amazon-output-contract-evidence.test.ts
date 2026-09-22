import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { BlobServiceClient } from "@azure/storage-blob";
import { describe, expect, it } from "vitest";
import {
  AmazonResultContractUnavailableError,
  inspectAmazonProviderResult,
  normalizeAmazonProviderResult,
} from "../../src/services/brightdata/amazon/amazonResultNormalizer.js";

const enabled = process.env.RUN_AZURITE_INTEGRATION_TESTS === "true";
const connectionString = process.env.RESULT_STORAGE_CONNECTION_STRING;
const containerName = process.env.RESULT_STORAGE_CONTAINER;

const SUCCESS_EVIDENCE = [
  {
    qualificationId: "fcb79899-41bd-4e11-a89a-ef1c398b0d16",
    operationCode: "amazon.products.collect_by_url",
    byteCount: 23_891,
    recordCount: 1,
  },
  {
    qualificationId: "0368f142-a061-4803-b042-0dce23a59a7c",
    operationCode: "amazon.products_global.collect_by_url",
    byteCount: 14_133,
    recordCount: 1,
  },
  {
    qualificationId: "f3200036-cb1e-40d4-b5b6-2142bb02a3df",
    operationCode: "amazon.products_search.collect_by_url",
    byteCount: 45_421,
    recordCount: 30,
  },
  {
    qualificationId: "8538256a-f780-4f22-9ff7-d2f5bf822b74",
    operationCode: "amazon.products.discover_by_upc",
    byteCount: 2,
    recordCount: 0,
  },
] as const;

const SELLER_ERROR_EVIDENCE = {
  qualificationId: "7df8d6c6-ecbc-48d9-87f0-f25e8915d4a6",
  operationCode: "amazon.sellers.collect_by_url",
  byteCount: 252,
} as const;

function container() {
  if (connectionString === undefined || containerName === undefined) {
    throw new Error("Azurite Pattern 8 output-contract test configuration is missing");
  }
  return BlobServiceClient.fromConnectionString(connectionString)
    .getContainerClient(containerName);
}

async function readEvidence(qualificationId: string, expectedByteCount: number): Promise<Buffer> {
  const objectKey = `qualification/operations/${qualificationId}/response.json`;
  const blob = container().getBlockBlobClient(objectKey);
  const properties = await blob.getProperties();
  const bytes = await blob.downloadToBuffer();
  const checksum = createHash("sha256").update(bytes).digest("hex");

  expect(bytes.byteLength).toBe(expectedByteCount);
  expect(properties.metadata?.dhumi_byte_count).toBe(String(expectedByteCount));
  expect(properties.metadata?.dhumi_sha256).toBe(checksum);
  expect(properties.contentType).toBe("application/json");
  return bytes;
}

describe.skipIf(!enabled)("Pattern 8 Amazon output contracts against immutable evidence", () => {
  it.each(SUCCESS_EVIDENCE)(
    "normalizes $operationCode using its exact stored response",
    async ({ qualificationId, operationCode, byteCount, recordCount }) => {
      const bytes = await readEvidence(qualificationId, byteCount);
      const result = await normalizeAmazonProviderResult({
        operationCode,
        bytes: Readable.from(bytes),
        contentType: "application/json",
        contentEncoding: null,
        maxBytes: byteCount,
      });
      const records = JSON.parse(result.bytes.toString("utf8")) as readonly Record<string, unknown>[];

      expect(result.recordCount).toBe(recordCount);
      expect(records).toHaveLength(recordCount);
      for (const record of records) {
        expect(record).not.toHaveProperty("input");
        expect(record).not.toHaveProperty("error");
        expect(record).not.toHaveProperty("error_code");
      }
    },
  );

  it("classifies the seller capture as provider-error evidence and keeps it unpublished", async () => {
    const bytes = await readEvidence(
      SELLER_ERROR_EVIDENCE.qualificationId,
      SELLER_ERROR_EVIDENCE.byteCount,
    );
    const inspection = await inspectAmazonProviderResult({
      bytes: Readable.from(bytes),
      contentType: "application/json",
      contentEncoding: null,
      maxBytes: SELLER_ERROR_EVIDENCE.byteCount,
    });

    expect(inspection).toEqual({ recordCount: 1, providerErrorCount: 1 });
    await expect(normalizeAmazonProviderResult({
      operationCode: SELLER_ERROR_EVIDENCE.operationCode,
      bytes: Readable.from(bytes),
      contentType: "application/json",
      contentEncoding: null,
      maxBytes: SELLER_ERROR_EVIDENCE.byteCount,
    })).rejects.toBeInstanceOf(AmazonResultContractUnavailableError);
  });
});
