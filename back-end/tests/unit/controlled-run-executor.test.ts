import { describe, expect, it, vi } from "vitest";
import { createSyntheticControlledRunExecutor } from "../../src/services/jobs/controlledRunExecutor.js";
import type { IngestResultInput } from "../../src/services/storage/resultIngestionService.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";

async function bytes(input: IngestResultInput): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input.bytes) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

describe("controlled Pattern 4 executor", () => {
  it("writes deterministic raw and normalized objects through Pattern 3 ingestion", async () => {
    const calls: IngestResultInput[] = [];
    const ingest = vi.fn(async (input: IngestResultInput) => {
      calls.push(input);
      return {
        receipt: {
          objectKey: "object",
          contentType: input.contentType,
          contentEncoding: input.contentEncoding,
          byteCount: 1,
          checksumHex: "ab".repeat(32),
          eTag: '"etag"',
        },
        artifactId:
          input.identity.kind === "raw"
            ? "44444444-4444-4444-8444-444444444444"
            : "55555555-5555-4555-8555-555555555555",
        replayed: false,
      };
    });
    const executor = createSyntheticControlledRunExecutor({ ingest });
    const input = {
      tenantId,
      runId,
      attemptId,
      fenceToken: "66666666-6666-4666-8666-666666666666",
      signal: new AbortController().signal,
    };

    await executor.persistRaw(input);
    await expect(executor.persistNormalized(input)).resolves.toEqual({
      artifactId: "55555555-5555-4555-8555-555555555555",
      usage: null,
    });

    expect(calls.map((call) => call.identity.kind)).toEqual(["raw", "normalized"]);
    expect(calls[0]?.schemaVersion).toBeNull();
    expect(calls[1]?.schemaVersion).toBe("pattern4-controlled-v1");
    expect(calls[0]?.recordCount).toBeNull();
    expect(calls[1]?.recordCount).toBe(0);
    const rawInput = calls[0];
    const normalizedInput = calls[1];
    if (rawInput === undefined || normalizedInput === undefined) {
      throw new Error("expected raw and normalized ingestion calls");
    }
    const [raw, normalized] = await Promise.all([bytes(rawInput), bytes(normalizedInput)]);
    expect(raw).toBe(normalized);
    expect(JSON.parse(raw)).toEqual({
      source: "dhumi_pattern4_controlled_executor",
      run_id: runId,
      status: "succeeded",
      items: [],
    });
  });
});
