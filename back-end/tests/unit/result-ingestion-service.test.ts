import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type {
  FinalizeResultArtifactInput,
  ResultArtifactFinalizer,
} from "../../src/services/storage/resultArtifactFinalizer.js";
import { createResultIngestionService } from "../../src/services/storage/resultIngestionService.js";
import { createResultObjectKey } from "../../src/services/storage/resultObjectIdentity.js";
import type {
  PutResultObjectInput,
  ResultObjectReceipt,
  ResultObjectStore,
} from "../../src/services/storage/resultObjectStore.js";

const identity = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  runId: "22222222-2222-4222-8222-222222222222",
  attemptId: "33333333-3333-4333-8333-333333333333",
  kind: "normalized",
  artifactVersion: 1,
} as const;

const receipt: ResultObjectReceipt = {
  objectKey:
    "tenants/11111111-1111-4111-8111-111111111111/" +
    "runs/22222222-2222-4222-8222-222222222222/" +
    "attempts/33333333-3333-4333-8333-333333333333/normalized/v1/result",
  contentType: "application/json",
  contentEncoding: null,
  byteCount: 27,
  checksumHex: "ab".repeat(32),
  eTag: '"etag-1"',
};

class RecordingStore implements ResultObjectStore {
  public readonly puts: PutResultObjectInput[] = [];
  public failure: Error | null = null;

  public async putImmutable(input: PutResultObjectInput): Promise<ResultObjectReceipt> {
    this.puts.push(input);
    if (this.failure) throw this.failure;
    return {
      ...receipt,
      objectKey: createResultObjectKey(input.identity),
      contentType: input.contentType,
      contentEncoding: input.contentEncoding,
    };
  }

  public async head(): Promise<ResultObjectReceipt | null> {
    return receipt;
  }

  public async open() {
    return { receipt, bytes: Readable.from([]) };
  }
}

class RecordingFinalizer implements ResultArtifactFinalizer {
  public readonly calls: FinalizeResultArtifactInput[] = [];
  public failure: Error | null = null;

  public async finalize(input: FinalizeResultArtifactInput) {
    this.calls.push(input);
    if (this.failure) throw this.failure;
    return {
      artifactId: "44444444-4444-4444-8444-444444444444",
      replayed: false,
    };
  }
}

describe("ResultIngestionService", () => {
  it("stores normalized bytes before finalizing a validated Artifact", async () => {
    const store = new RecordingStore();
    const finalizer = new RecordingFinalizer();
    const service = createResultIngestionService({ store, finalizer, maxBytes: 1_024 });

    const outcome = await service.ingest({
      identity,
      bytes: Readable.from('{"synthetic":true}'),
      contentType: "application/json",
      contentEncoding: null,
      schemaVersion: "amazon.synthetic.v1",
      recordCount: 2,
      expiresAt: null,
    });

    expect(store.puts).toHaveLength(1);
    expect(finalizer.calls).toEqual([
      {
        identity,
        receipt,
        artifactState: "validated",
        schemaVersion: "amazon.synthetic.v1",
        recordCount: 2,
        expiresAt: null,
      },
    ]);
    expect(outcome).toEqual({
      receipt,
      artifactId: "44444444-4444-4444-8444-444444444444",
      replayed: false,
    });
  });

  it("records a raw result as durable, never validated", async () => {
    const store = new RecordingStore();
    const finalizer = new RecordingFinalizer();
    const service = createResultIngestionService({ store, finalizer, maxBytes: 1_024 });

    await service.ingest({
      identity: { ...identity, kind: "raw" },
      bytes: Readable.from("raw"),
      contentType: "application/octet-stream",
      contentEncoding: null,
      schemaVersion: null,
      recordCount: null,
      expiresAt: null,
    });

    expect(finalizer.calls[0]?.artifactState).toBe("durable");
  });

  it("does not touch PostgreSQL when object storage fails", async () => {
    const store = new RecordingStore();
    store.failure = new Error("storage failed");
    const finalizer = new RecordingFinalizer();
    const service = createResultIngestionService({ store, finalizer, maxBytes: 1_024 });

    await expect(
      service.ingest({
        identity,
        bytes: Readable.from("bytes"),
        contentType: "application/json",
        contentEncoding: null,
        schemaVersion: null,
        recordCount: null,
        expiresAt: null,
      }),
    ).rejects.toThrow("storage failed");
    expect(finalizer.calls).toHaveLength(0);
  });

  it("leaves an undisclosed deterministic object for reconciliation if DB finalization fails", async () => {
    const store = new RecordingStore();
    const finalizer = new RecordingFinalizer();
    finalizer.failure = new Error("database failed");
    const service = createResultIngestionService({ store, finalizer, maxBytes: 1_024 });

    await expect(
      service.ingest({
        identity,
        bytes: Readable.from("bytes"),
        contentType: "application/json",
        contentEncoding: null,
        schemaVersion: null,
        recordCount: null,
        expiresAt: null,
      }),
    ).rejects.toThrow("database failed");
    expect(store.puts).toHaveLength(1);
    expect(finalizer.calls).toHaveLength(1);
  });
});
