import { randomBytes, randomUUID } from "node:crypto";
import { BlobServiceClient } from "@azure/storage-blob";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createBrightDataIntegrationClient,
  type BrightDataFetch,
} from "../../src/services/brightdata/brightDataIntegrationClient.js";
import { createBrightDataRunExecutor } from "../../src/services/brightdata/brightDataRunExecutor.js";
import {
  providerDatasetAad,
  providerSnapshotAad,
  type ProviderExecutionPlan,
  type ProviderExecutionPlanRepository,
} from "../../src/services/brightdata/providerExecutionPlanRepository.js";
import { createLocalProviderReferenceProtector } from "../../src/services/brightdata/providerReferenceProtector.js";
import type { SecretProvider } from "../../src/services/secrets/secretProvider.js";
import type {
  FinalizeResultArtifactInput,
  ResultArtifactFinalizer,
} from "../../src/services/storage/resultArtifactFinalizer.js";
import { createResultIngestionService } from "../../src/services/storage/resultIngestionService.js";
import { createAzuriteResultObjectStore } from "../../src/services/storage/azuriteResultObjectStore.js";

const enabled = process.env.RUN_AZURITE_INTEGRATION_TESTS === "true";
const connectionString = process.env.RESULT_STORAGE_CONNECTION_STRING;
const containerName = `dhumi-pattern5-${randomUUID()}`;

function serviceClient(): BlobServiceClient {
  if (!connectionString) throw new Error("RESULT_STORAGE_CONNECTION_STRING is required");
  return BlobServiceClient.fromConnectionString(connectionString);
}

async function readAll(bytes: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of bytes) {
    chunks.push(
      Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === "string"
          ? Buffer.from(chunk, "utf8")
          : Buffer.from(chunk as Uint8Array),
    );
  }
  return Buffer.concat(chunks);
}

async function fixture(providerFetch: BrightDataFetch) {
  const tenantId = randomUUID();
  const runId = randomUUID();
  const attemptId = randomUUID();
  const fenceToken = randomUUID();
  const templateVersionId = randomUUID();
  const protector = createLocalProviderReferenceProtector(
    "test",
    randomBytes(32).toString("base64url"),
  );
  const protectedMapping = await protector.protect(
    "gd_l7q7dkf244hwjntr0",
    providerDatasetAad(templateVersionId),
  );
  const plan: ProviderExecutionPlan = {
    templateVersionId,
    validatedInput: {
      targets: [
        {
          url: "https://www.amazon.com/dp/B0CRMZHDG8",
          zipcode: "94107",
          language: "EN",
          all_variations: true,
        },
      ],
    },
    operationCode: "amazon.products.collect_by_url",
    datasetCiphertext: protectedMapping.ciphertext,
    datasetFingerprint: protectedMapping.fingerprint,
    outputPolicy: {
      provider_request: { mode: "collect", limit_per_input: null },
      snapshot: {
        enabled: true,
        cancel_enabled: true,
        multipart_enabled: false,
        format: "json",
      },
      normalizer_code: "amazon.products.collect-by-url.projected-array",
      normalizer_version: 2,
      normalized_schema_version: "amazon.products.collect-by-url.output.v1",
    },
    definitionConfigVersion: "amazon-v1",
    providerCode: "bright_data",
    providerEnvironment: "test",
    secretReference: "BRIGHTDATA_API_KEY",
  };
  const recordedReferences: Array<{
    readonly ciphertext: Buffer;
    readonly fingerprint: Buffer;
  }> = [];
  const repository: ProviderExecutionPlanRepository = {
    resolveExecutorKind: vi.fn(async () => "amazon" as const),
    checkpointPoll: vi.fn(async () => ({ remainingMs: 5000, waitMs: 0, consecutiveFailures: 0 })),
    resolveSubmission: vi.fn(async () => plan),
    recordProviderReference: vi.fn(async (input) => {
      recordedReferences.push({
        ciphertext: input.ciphertext,
        fingerprint: input.fingerprint,
      });
    }),
    resolveReconciliation: vi.fn(async () => {
      throw new Error("not used by the storage fixture");
    }),
    resolveNormalization: vi.fn(async () => ({
      operationCode: plan.operationCode,
      outputPolicy: plan.outputPolicy,
    })),
    isCancellationRequested: vi.fn(async () => false),
  };
  const secretProvider: SecretProvider = {
    getSecret: vi.fn(async () => "private-pattern5-test-key"),
  };
  const finalized: FinalizeResultArtifactInput[] = [];
  const finalizer: ResultArtifactFinalizer = {
    finalize: vi.fn(async (input) => {
      finalized.push(input);
      return { artifactId: randomUUID(), replayed: false };
    }),
  };
  const store = createAzuriteResultObjectStore(
    serviceClient().getContainerClient(containerName),
  );
  const ingestion = createResultIngestionService({
    store,
    finalizer,
    maxBytes: 4096,
  });
  const executor = createBrightDataRunExecutor({
    repository,
    secretProvider,
    protector,
    client: createBrightDataIntegrationClient({
      requestTimeoutMs: 1000,
      controlResponseMaxBytes: 4096,
      catalogueResponseMaxBytes: 4096,
      resultMaxBytes: 4096,
      fetch: providerFetch,
    }),
    ingestion,
    store,
    maxBytes: 4096,
    pollIntervalMs: 100,
    pollMaxElapsedMs: 5000,
    providerEnvironment: "test",
    wait: vi.fn(async () => undefined),
  });
  const execution = {
    tenantId,
    runId,
    attemptId,
    fenceToken,
    signal: new AbortController().signal,
  } as const;
  return {
    executor,
    execution,
    protector,
    recordedReferences,
    finalized,
    store,
  };
}

describe.skipIf(!enabled)("Pattern 5 provider response to Azurite E2E", () => {
  beforeAll(async () => {
    await serviceClient().getContainerClient(containerName).create();
  });

  afterAll(async () => {
    await serviceClient().getContainerClient(containerName).deleteIfExists();
  });

  it("streams a private 200 response into exact raw and normalized objects", async () => {
    const expected = productBytes();
    const providerFetch = vi.fn<BrightDataFetch>(async (request, init) => {
      const url = new URL(request.toString());
      expect(url.origin).toBe("https://api.brightdata.com");
      expect(url.pathname).toBe("/datasets/v3/scrape");
      expect(url.searchParams.get("dataset_id")).toBe("gd_l7q7dkf244hwjntr0");
      expect(url.searchParams.get("notify")).toBe("false");
      expect(url.searchParams.get("include_errors")).toBe("true");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer private-pattern5-test-key",
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        input: [
          {
            url: "https://www.amazon.com/dp/B0CRMZHDG8",
            zipcode: "94107",
            language: "EN",
            all_variations: true,
          },
        ],
        limit_per_input: null,
      });
      return new Response(expected, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const parts = await fixture(providerFetch);

    await parts.executor.persistRaw(parts.execution);
    await parts.executor.persistNormalized(parts.execution);

    const raw = await parts.store.open(
      { ...parts.execution, kind: "raw", artifactVersion: 1 },
      4096,
    );
    const normalized = await parts.store.open(
      { ...parts.execution, kind: "normalized", artifactVersion: 1 },
      4096,
    );
    await expect(readAll(raw.bytes)).resolves.toEqual(expected);
    await expect(readAll(normalized.bytes)).resolves.toEqual(expected);
    expect(parts.finalized.map((entry) => entry.artifactState)).toEqual([
      "durable",
      "validated",
    ]);
    expect(parts.recordedReferences).toHaveLength(0);
    expect(providerFetch).toHaveBeenCalledOnce();
  });

  it("protects a private 202 reference then stores exact downloaded bytes", async () => {
    const snapshotReference = "s_m4x7enmven8djfqak";
    const expected = productBytes();
    let progressCalls = 0;
    const providerFetch = vi.fn<BrightDataFetch>(async (request) => {
      const url = new URL(request.toString());
      if (url.pathname === "/datasets/v3/scrape") {
        return Response.json({ snapshot_id: snapshotReference }, { status: 202 });
      }
      if (url.pathname === `/datasets/v3/progress/${snapshotReference}`) {
        progressCalls += 1;
        return Response.json({ status: progressCalls === 1 ? "running" : "ready" });
      }
      if (url.pathname === `/datasets/v3/snapshot/${snapshotReference}`) {
        return new Response(expected, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected private fixture path: ${url.pathname}`);
    });
    const parts = await fixture(providerFetch);

    await parts.executor.persistRaw(parts.execution);
    await parts.executor.persistNormalized(parts.execution);

    expect(parts.recordedReferences).toHaveLength(1);
    const recorded = parts.recordedReferences[0];
    expect(recorded?.ciphertext.toString("utf8")).not.toContain(snapshotReference);
    await expect(
      parts.protector.reveal(
        recorded?.ciphertext ?? Buffer.alloc(0),
        recorded?.fingerprint ?? Buffer.alloc(0),
        providerSnapshotAad(parts.execution),
      ),
    ).resolves.toBe(snapshotReference);
    const raw = await parts.store.open(
      { ...parts.execution, kind: "raw", artifactVersion: 1 },
      4096,
    );
    const normalized = await parts.store.open(
      { ...parts.execution, kind: "normalized", artifactVersion: 1 },
      4096,
    );
    await expect(readAll(raw.bytes)).resolves.toEqual(expected);
    await expect(readAll(normalized.bytes)).resolves.toEqual(expected);
    expect(parts.finalized.map((entry) => entry.artifactState)).toEqual([
      "durable",
      "validated",
    ]);
    expect(providerFetch).toHaveBeenCalledTimes(4);
  });
  it("retains exact all-error raw bytes and creates no normalized Artifact", async () => {
    const expected = Buffer.from('[{"input":{"url":"https://www.amazon.in/dp/B0H7S6LT9P"},"error":"private failure","error_code":"aborted_page"}]');
    const providerFetch = vi.fn<BrightDataFetch>(async () => new Response(expected, {
      status: 200, headers: { "content-type": "application/json" },
    }));
    const parts = await fixture(providerFetch);
    await parts.executor.persistRaw(parts.execution);
    await expect(parts.executor.persistNormalized(parts.execution)).rejects.toMatchObject({ customerErrorCode: "ALL_INPUTS_FAILED" });
    const raw = await parts.store.open({ ...parts.execution, kind: "raw", artifactVersion: 1 },4096);
    await expect(readAll(raw.bytes)).resolves.toEqual(expected);
    expect(parts.finalized).toHaveLength(1);
    expect(parts.finalized[0]?.artifactState).toBe("durable");
    expect(providerFetch).toHaveBeenCalledOnce();
  });
});

function productBytes(): Buffer {
  return Buffer.from(JSON.stringify([{
    asin: "B0CRMZHDG8", title: "Offline fixture", url: "https://www.amazon.com/dp/B0CRMZHDG8",
    domain: "amazon.com", currency: "USD", final_price: 45, initial_price: 50,
    rating: 4.7, reviews_count: 1200, availability: "In Stock", brand: "Example",
    image_url: "https://m.media-amazon.com/images/I/example.jpg", timestamp: "2026-09-05T00:00:00.000Z",
  }]));
}
