import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { vi } from "vitest";
import type { BrightDataIntegrationClient } from "../../src/services/brightdata/brightDataIntegrationClient.js";
import { createSharedScraperRunExecutor } from "../../src/services/brightdata/scrapers/sharedScraperRunExecutor.js";
import { createScraperProcessing, scraperContractHash, type ScraperOperationContract } from "../../src/services/scrapers/scraperProcessing.js";
import type { ScraperExecutionPlan, ScraperExecutionRepository } from "../../src/services/brightdata/scrapers/scraperExecutionRepository.js";
import type { ControlledRunExecutionInput } from "../../src/services/jobs/controlledRunExecutor.js";
import { SHARED_SCRAPER_ADAPTER_CODE, SHARED_SCRAPER_ADAPTER_VERSION, SHARED_SCRAPER_ARTIFACT_DIGEST } from "../../src/services/scrapers/sharedScraperVersion.js";
import { providerDatasetAad, providerSnapshotAad } from "../../src/services/brightdata/providerExecutionPlanRepository.js";
import { createLocalProviderReferenceProtector } from "../../src/services/brightdata/providerReferenceProtector.js";
import type { ResultIngestionService } from "../../src/services/storage/resultIngestionService.js";
import type { ResultObjectStore } from "../../src/services/storage/resultObjectStore.js";

export const execution: ControlledRunExecutionInput = { tenantId: "11111111-1111-4111-8111-111111111111", runId: "22222222-2222-4222-8222-222222222222",
  attemptId: "33333333-3333-4333-8333-333333333333", fenceToken: "44444444-4444-4444-8444-444444444444", signal: new AbortController().signal };
export const recoveryAttemptId = "66666666-6666-4666-8666-666666666666";
export async function sharedScraperFixture(options: {
  readonly name?: string; readonly records?: readonly unknown[]; readonly snapshot?: boolean;
  readonly endpoint?: "scrape" | "trigger"; readonly cancelEnabled?: boolean; readonly retryAfterMs?: number;
} = {}) {
  const fixture = JSON.parse(readFileSync(new URL(`../fixtures/scraper-operations/${options.name ?? "target"}.json`, import.meta.url), "utf8")) as {
    contract: ScraperOperationContract; input: Record<string, unknown>; records: Record<string, unknown>[];
  };
  if (options.endpoint) fixture.contract.processing.request.endpoint = options.endpoint;
  if (options.cancelEnabled) fixture.contract.processing.request.snapshot.cancelEnabled = true;
  const processing = createScraperProcessing();
  const protector = createLocalProviderReferenceProtector("test", randomBytes(32).toString("base64url"));
  const mappingId = "55555555-5555-4555-8555-555555555555";
  const protectedMapping = await protector.protect("gd_targetfixture12345", providerDatasetAad(mappingId));
  const snapshotReference = "sd_fixture123456";
  const protectedSnapshot = await protector.protect(snapshotReference, providerSnapshotAad({ ...execution, attemptId: recoveryAttemptId }));
  const plan: ScraperExecutionPlan = {
    identity: { code: SHARED_SCRAPER_ADAPTER_CODE, version: SHARED_SCRAPER_ADAPTER_VERSION, digest: SHARED_SCRAPER_ARTIFACT_DIGEST },
    contract: fixture.contract, contractHash: scraperContractHash(fixture.contract), validatedInput: fixture.input,
    providerEnvironment: "test", templateVersionId: mappingId,
    datasetCiphertext: protectedMapping.ciphertext, datasetFingerprint: protectedMapping.fingerprint,
    secretReference: "BRIGHTDATA_API_KEY", sourceAttemptId: execution.attemptId,
    sourceProviderReferenceCiphertext: null, sourceProviderReferenceFingerprint: null,
  };
  let clock = 0, failures = 0, nextPollAt = 0;
  const repository: ScraperExecutionRepository = {
    resolveIdentity: vi.fn(async () => plan.identity),
    resolvePlan: vi.fn(async (_input, phase, sourceAttemptId) => phase === "reconciliation"
      ? { ...plan, sourceAttemptId: recoveryAttemptId, sourceProviderReferenceCiphertext: protectedSnapshot.ciphertext, sourceProviderReferenceFingerprint: protectedSnapshot.fingerprint }
      : { ...plan, sourceAttemptId: sourceAttemptId ?? execution.attemptId }),
    checkpointPoll: vi.fn(async (input) => {
      if (input.failure === true) failures++;
      if (input.failure === false) failures = 0;
      if (input.status !== undefined) nextPollAt = clock + (input.delayMs ?? 0);
      return { remainingMs: 5000 - clock, waitMs: Math.max(0, nextPollAt - clock), consecutiveFailures: failures };
    }),
    recordProviderReference: vi.fn(async () => undefined),
    isCancellationRequested: vi.fn(async () => false),
  };
  const rawBytes = Buffer.from(JSON.stringify(options.records ?? fixture.records));
  const inline = () => ({ kind: "inline" as const, bytes: Readable.from([rawBytes]), contentType: "application/json", contentEncoding: null });
  const client: BrightDataIntegrationClient = {
    listScrapers: vi.fn(async () => []),
    submit: vi.fn(async () => options.snapshot ? { kind: "snapshot" as const, snapshotReference,
      ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }) } : inline()),
    trigger: vi.fn(async () => ({ snapshotReference })),
    getProgress: vi.fn(async () => ({ status: "ready" as const })),
    download: vi.fn(async () => inline()), getParts: vi.fn(async () => ({ parts: 1 })), cancel: vi.fn(async () => undefined),
  };
  const secretProvider = { getSecret: vi.fn(async () => "fixture-only-provider-secret") };
  const ingested: { kind: string; attemptId: string; bytes: Buffer; recordCount: number | null }[] = [];
  const ingestion: ResultIngestionService = { ingest: vi.fn(async (input) => {
    const chunks: Buffer[] = [];
    for await (const chunk of input.bytes) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    const bytes = Buffer.concat(chunks);
    ingested.push({ kind: input.identity.kind, attemptId: input.identity.attemptId, bytes, recordCount: input.recordCount });
    return { artifactId: `${input.identity.kind}-artifact`, replayed: false,
      receipt: { objectKey: "fixture-private-key", byteCount: bytes.length, checksumHex: "ab".repeat(32), eTag: "fixture-etag",
        contentType: input.contentType, contentEncoding: input.contentEncoding } };
  }) };
  const store: ResultObjectStore = {
    open: vi.fn(async () => ({ bytes: Readable.from([rawBytes]), receipt: { objectKey: "fixture-private-key", byteCount: rawBytes.length,
      checksumHex: "ab".repeat(32), eTag: "fixture-etag", contentType: "application/json", contentEncoding: null } })),
    head: vi.fn(async () => null), putImmutable: vi.fn(async () => { throw new Error("must use ingestion"); }),
  };
  const dependencies = { repository, processing, client, protector, secretProvider, ingestion, store,
    providerEnvironment: "test" as const, maxBytes: 65536, pollIntervalMs: 50, pollMaxElapsedMs: 5000, pollMaxConsecutiveFailures: 3,
    now: () => clock, wait: vi.fn(async (milliseconds: number, _signal: AbortSignal) => { clock += milliseconds; }) };
  return { ...dependencies, plan, rawBytes, ingested, fixture, executor: createSharedScraperRunExecutor(dependencies) };
}
