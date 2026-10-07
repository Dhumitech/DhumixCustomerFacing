import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { ContainerClient } from "@azure/storage-blob";
import { describe, expect, it, vi } from "vitest";
import { createQualificationEvidenceReader } from "../../src/services/marketplaceSample/qualificationEvidenceReader.js";

const objectKey = "qualification/operations/11111111-1111-4111-8111-111111111111/raw.json";
const bytes = Buffer.from('[{"id":"sample"}]');

function storage(input: { checksum?: string; declaredSize?: number; body?: Buffer; downloadError?: unknown } = {}) {
  const size = input.declaredSize ?? bytes.length;
  const getProperties = vi.fn(async () => ({
    contentType: "application/json", contentLength: size, etag: '"v1"',
    metadata: {
      dhumi_evidence_class: "provider_qualification", dhumi_byte_count: String(size),
      dhumi_sha256: input.checksum ?? createHash("sha256").update(bytes).digest("hex"),
    },
  }));
  const download = vi.fn(async () => {
    if (input.downloadError !== undefined) throw input.downloadError;
    return { contentLength: size, contentType: "application/json", readableStreamBody: Readable.from([input.body ?? bytes]) };
  });
  const getBlobClient = vi.fn(() => ({ getProperties, download }));
  return { reader: createQualificationEvidenceReader({ getBlobClient } as unknown as ContainerClient), getBlobClient, download };
}

describe("Marketplace historical qualification evidence reader", () => {
  it("reads checksum-verified evidence at the observed ETag", async () => {
    const { reader, download } = storage();
    const result = await reader.open({ objectKey, maxBytes: bytes.length });
    expect(result.bytes).toEqual(bytes);
    expect(result.byteCount).toBe(bytes.length);
    expect(download).toHaveBeenCalledWith(0, undefined, { conditions: { ifMatch: '"v1"' } });
  });

  it.each(["runs/private.json", "../../secrets", "qualification/operations/not-a-uuid/raw.json"])
    ("rejects invalid object keys before storage access: %s", async (key) => {
      const { reader, getBlobClient } = storage();
      await expect(reader.open({ objectKey: key, maxBytes: 100 })).rejects.toThrow(/integrity/);
      expect(getBlobClient).not.toHaveBeenCalled();
    });

  it("rejects oversized metadata before downloading", async () => {
    const { reader, download } = storage({ declaredSize: 101 });
    await expect(reader.open({ objectKey, maxBytes: 100 })).rejects.toThrow(/integrity/);
    expect(download).not.toHaveBeenCalled();
  });

  it.each([
    { checksum: "0".repeat(64) }, { body: Buffer.from("[]") },
    { body: Buffer.alloc(101) }, { downloadError: { statusCode: 412 } },
    { downloadError: { statusCode: 404 } },
  ])("rejects changed, truncated, oversized or missing evidence %j", async (invalid) => {
    const { reader } = storage(invalid);
    await expect(reader.open({ objectKey, maxBytes: 100 })).rejects.toThrow(/integrity/);
  });
});
