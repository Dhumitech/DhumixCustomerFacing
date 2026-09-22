import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  AmazonQualificationError,
  createAmazonQualificationService,
} from "../../src/services/qualification/amazonQualificationService.js";
import type { AmazonQualificationRepository } from "../../src/services/qualification/amazonQualificationRepository.js";
import type {
  QualificationEvidenceStore,
} from "../../src/services/qualification/qualificationEvidenceStore.js";
import type { BrightDataIntegrationClient } from "../../src/services/brightdata/brightDataIntegrationClient.js";
import { BrightDataBoundaryError } from "../../src/services/brightdata/brightDataIntegrationClient.js";
import { createLocalProviderReferenceProtector } from "../../src/services/brightdata/providerReferenceProtector.js";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CANDIDATE_ID = "71000000-0000-4000-8000-000000000001";
const PRODUCT_RESULT = Buffer.from(JSON.stringify([{
  asin: "B000000000",
  title: "Evidence-backed product shape",
  url: "https://www.amazon.com/dp/B000000000",
  domain: "amazon.com",
  currency: "USD",
  final_price: 10,
  initial_price: 12,
  rating: 4.2,
  reviews_count: 100,
  availability: "In Stock",
  brand: "Example",
  image_url: "https://m.media-amazon.com/images/I/example.jpg",
  timestamp: "2026-08-30T08:56:31.000Z",
}]), "utf8");

function receipt(objectKey: string, bytes: Buffer, contentType: string) {
  return {
    objectKey,
    checksumHex: createHash("sha256").update(bytes).digest("hex"),
    byteCount: bytes.byteLength,
    contentType,
    eTag: '"test"',
  };
}

async function harness(overrides: Partial<BrightDataIntegrationClient> = {}) {
  const protector = createLocalProviderReferenceProtector("test", KEY);
  const candidate = await protector.protect(
    "gd_12345678",
    Buffer.from("dhumi:catalog-candidate:v1:" + CANDIDATE_ID, "utf8"),
  );
  const repository: AmazonQualificationRepository = {
    beginImport: vi.fn(async () => undefined),
    completeImport: vi.fn(async (input) => input.candidates.length),
    failImport: vi.fn(async () => undefined),
    reviewCandidate: vi.fn(async () => undefined),
    resolveCandidate: vi.fn(async () => ({
      candidateCiphertext: candidate.ciphertext,
      candidateFingerprint: candidate.fingerprint,
      serviceTemplateVersionId: "71000000-0000-4000-8000-000000000002",
      adapterVersionId: "71000000-0000-4000-8000-000000000003",
      providerCredentialId: "71000000-0000-4000-8000-000000000004",
    })),
    beginQualification: vi.fn(async () => undefined),
    resolveAcceptance: vi.fn(async () => ({
      candidateId: CANDIDATE_ID,
      operationCode: "amazon.products.discover_by_keyword",
      environment: "test" as const,
      providerExecutionMode: "scrape" as const,
      candidateCiphertext: candidate.ciphertext,
      candidateFingerprint: candidate.fingerprint,
    })),
    completeQualification: vi.fn(async () => undefined),
    acceptQualification: vi.fn(async (input) => ({
      mappingId: input.mappingId,
      launchEvidenceId: "71000000-0000-4000-8000-000000000005",
    })),
    rejectQualification: vi.fn(async () => undefined),
  };
  const evidenceStore: QualificationEvidenceStore = {
    putImmutable: vi.fn(async (input) => receipt(input.objectKey, input.bytes, input.contentType)),
  };
  const client: BrightDataIntegrationClient = {
    listScrapers: vi.fn(async () => [{ id: "gd_12345678", name: "Amazon products" }]),
    submit: vi.fn(async () => ({
      kind: "inline" as const,
      bytes: Readable.from(PRODUCT_RESULT),
      contentType: "application/json",
      contentEncoding: null,
    })),
    trigger: vi.fn(async () => ({ snapshotReference: "s_12345678" })),
    getProgress: vi.fn(async () => ({ status: "ready" as const })),
    getParts: vi.fn(async () => ({ parts: 1 })),
    download: vi.fn(async () => ({
      kind: "inline" as const,
      bytes: Readable.from(PRODUCT_RESULT),
      contentType: "application/json",
      contentEncoding: null,
    })),
    cancel: vi.fn(async () => undefined),
    ...overrides,
  };
  const service = createAmazonQualificationService({
    repository,
    evidenceStore,
    client,
    secretProvider: { getSecret: vi.fn(async () => "qualification-secret") },
    protector,
    evidenceMaxBytes: 1_000_000,
    pollIntervalMs: 10,
    pollMaxElapsedMs: 100,
    now: vi.fn().mockReturnValueOnce(0).mockReturnValue(10),
    wait: vi.fn(async () => undefined),
  });
  return { service, repository, evidenceStore, client };
}

describe("Pattern 7 Amazon qualification service", () => {
  it("discovers account scrapers into protected pending candidates and a redacted manifest", async () => {
    const { service, repository, evidenceStore } = await harness();
    const result = await service.discover({
      confirmedLiveRequest: true,
      environment: "test",
      actor: "operator@example.test",
      restrictedReference: "restricted://pattern7/discovery",
      signal: new AbortController().signal,
    });

    expect(result.candidateCount).toBe(1);
    expect(result.candidates[0]?.name).toBe("Amazon products");
    expect(repository.completeImport).toHaveBeenCalledOnce();
    const completed = vi.mocked(repository.completeImport).mock.calls[0]?.[0];
    expect(completed?.candidates[0]?.ciphertext.toString("utf8")).not.toContain("gd_12345678");
    const stored = vi.mocked(evidenceStore.putImmutable).mock.calls[0]?.[0].bytes.toString("utf8");
    expect(stored).toContain("Amazon products");
    expect(stored).not.toContain("gd_12345678");
  });

  it("requires a separate live confirmation before scraper discovery", async () => {
    const { service, client } = await harness();
    await expect(service.discover({
      confirmedLiveRequest: false as true,
      environment: "test",
      actor: "operator@example.test",
      restrictedReference: "restricted://pattern7/discovery",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "QUALIFICATION_LIVE_CONFIRMATION_REQUIRED" });
    expect(client.listScrapers).not.toHaveBeenCalled();
  });

  it("preserves safe catalogue byte diagnostics through qualification failure mapping", async () => {
    const boundaryError = new BrightDataBoundaryError({
      code: "PROVIDER_RESPONSE_INVALID",
      submissionOutcome: "not_applicable",
      retryable: false,
      safeReason: "PROVIDER_CONTROL_TOO_LARGE",
      observedByteCount: 1_234_567,
      maximumByteCount: 1_048_576,
    });
    const { service } = await harness({
      listScrapers: vi.fn(async () => { throw boundaryError; }),
    });

    await expect(service.discover({
      confirmedLiveRequest: true,
      environment: "test",
      actor: "operator@example.test",
      restrictedReference: "restricted://pattern7/discovery",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: "PROVIDER_RESPONSE_INVALID",
      safeReason: "PROVIDER_CONTROL_TOO_LARGE",
      observedByteCount: 1_234_567,
      maximumByteCount: 1_048_576,
    });
  });

  it("captures and validates an inline qualification response without exposing a provider ID", async () => {
    const { service, repository, client } = await harness();
    const result = await service.qualify({
      confirmedBillableRequest: true,
      environment: "test",
      candidateId: CANDIDATE_ID,
      operationCode: "amazon.products.collect_by_url",
      executionMode: "scrape",
      validatedInput: { targets: [{ url: "https://www.amazon.com/dp/B000000000" }] },
      actor: "operator@example.test",
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      operationCode: "amazon.products.collect_by_url",
      submissionMode: "inline",
      recordCount: 1,
      reviewState: "pending",
    });
    expect(client.submit).toHaveBeenCalledOnce();
    expect(repository.completeQualification).toHaveBeenCalledWith(expect.objectContaining({
      state: "succeeded",
      submissionMode: "inline",
      safeErrorCode: null,
    }));
    expect(JSON.stringify(result)).not.toContain("gd_12345678");
  });

  it("stores an inline provider-error response before failing qualification", async () => {
    const errorBytes = Buffer.from(JSON.stringify([{
      error: "private provider diagnostic",
      error_code: "private_code",
      input: { url: "https://www.amazon.com/sp?seller=missing" },
      timestamp: "2026-08-30T08:49:23.000Z",
    }]));
    const { service, repository, evidenceStore } = await harness({
      submit: vi.fn(async () => ({
        kind: "inline" as const,
        bytes: Readable.from(errorBytes),
        contentType: "application/json",
        contentEncoding: null,
      })),
    });

    await expect(service.qualify({
      confirmedBillableRequest: true,
      environment: "test",
      candidateId: CANDIDATE_ID,
      operationCode: "amazon.sellers.collect_by_url",
      executionMode: "scrape",
      validatedInput: {
        targets: [{ url: "https://www.amazon.com/sp?seller=AXXXXXXXXXXX" }],
      },
      actor: "operator@example.test",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "QUALIFICATION_PROVIDER_ERROR_RECORDS" });

    expect(evidenceStore.putImmutable).toHaveBeenCalledWith(expect.objectContaining({
      objectKey: expect.stringMatching(/\/response\.json$/),
      bytes: errorBytes,
    }));
    expect(repository.completeQualification).toHaveBeenCalledWith(expect.objectContaining({
      state: "failed",
      responseObjectKey: expect.stringMatching(/\/response\.json$/),
      responseChecksum: expect.any(Buffer),
      responseByteCount: errorBytes.byteLength,
      safeErrorCode: "QUALIFICATION_PROVIDER_ERROR_RECORDS",
    }));
  });

  it("stores a supported response before rejecting an exact-contract mismatch", async () => {
    const invalidBytes = Buffer.from('[{"asin":"B000000000"}]', "utf8");
    const { service, repository, evidenceStore } = await harness({
      submit: vi.fn(async () => ({
        kind: "inline" as const,
        bytes: Readable.from(invalidBytes),
        contentType: "application/json",
        contentEncoding: null,
      })),
    });

    await expect(service.qualify({
      confirmedBillableRequest: true,
      environment: "test",
      candidateId: CANDIDATE_ID,
      operationCode: "amazon.products.collect_by_url",
      executionMode: "scrape",
      validatedInput: { targets: [{ url: "https://www.amazon.com/dp/B000000000" }] },
      actor: "operator@example.test",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "QUALIFICATION_PROVIDER_RESPONSE_INVALID" });

    expect(evidenceStore.putImmutable).toHaveBeenCalledWith(expect.objectContaining({
      objectKey: expect.stringMatching(/\/response\.json$/),
      bytes: invalidBytes,
    }));
    expect(repository.completeQualification).toHaveBeenCalledWith(expect.objectContaining({
      state: "failed",
      responseObjectKey: expect.stringMatching(/\/response\.json$/),
      safeErrorCode: "QUALIFICATION_PROVIDER_RESPONSE_INVALID",
    }));
  });

  it("captures every snapshot part and records one manifest receipt", async () => {
    let progress = 0;
    const { service, client, repository, evidenceStore } = await harness({
      submit: vi.fn(async () => ({ kind: "snapshot" as const, snapshotReference: "s_12345678" })),
      getProgress: vi.fn(async () => ({
        status: (++progress === 1 ? "running" : "ready") as "running" | "ready",
      })),
      getParts: vi.fn(async () => ({ parts: 2 })),
      download: vi.fn(async (input) => ({
        kind: "inline" as const,
        bytes: Readable.from(Buffer.from('[{"part":' + String(input.part) + "}]")),
        contentType: "application/json",
        contentEncoding: null,
      })),
    });
    const result = await service.qualify({
      confirmedBillableRequest: true,
      environment: "test",
      candidateId: CANDIDATE_ID,
      operationCode: "amazon.reviews.collect_by_url",
      executionMode: "scrape",
      validatedInput: { targets: [{ url: "https://www.amazon.com/dp/B000000000" }] },
      actor: "operator@example.test",
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ submissionMode: "snapshot", recordCount: 2 });
    expect(client.download).toHaveBeenCalledTimes(2);
    expect(evidenceStore.putImmutable).toHaveBeenCalledTimes(4);
    expect(repository.completeQualification).toHaveBeenCalledWith(expect.objectContaining({
      state: "succeeded",
      submissionMode: "snapshot",
      snapshotCiphertext: expect.any(Buffer),
      snapshotFingerprint: expect.any(Buffer),
    }));
  });

  it("qualifies an explicitly selected trigger endpoint without calling scrape", async () => {
    const submit = vi.fn(async () => {
      throw new Error("scrape must not be called for trigger qualification");
    });
    const trigger = vi.fn(async () => ({ snapshotReference: "s_12345678" }));
    const { service, repository } = await harness({ submit, trigger });

    const result = await service.qualify({
      confirmedBillableRequest: true,
      environment: "test",
      candidateId: CANDIDATE_ID,
      operationCode: "amazon.products.discover_by_keyword",
      executionMode: "trigger",
      validatedInput: { targets: [{ keyword: "wireless mouse" }] },
      actor: "operator@example.test",
      signal: new AbortController().signal,
    });

    expect(result.submissionMode).toBe("snapshot");
    expect(trigger).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
    expect(repository.beginQualification).toHaveBeenCalledWith(expect.objectContaining({
      providerExecutionMode: "trigger",
    }));
  });

  it("records an ambiguous provider POST once and never retries it", async () => {
    const submit = vi.fn(async () => {
      throw new BrightDataBoundaryError({
        code: "PROVIDER_SUBMISSION_UNCERTAIN",
        submissionOutcome: "uncertain",
        retryable: false,
      });
    });
    const { service, repository } = await harness({ submit });
    await expect(service.qualify({
      confirmedBillableRequest: true,
      environment: "test",
      candidateId: CANDIDATE_ID,
      operationCode: "amazon.products.collect_by_url",
      executionMode: "scrape",
      validatedInput: { targets: [{ url: "https://www.amazon.com/dp/B000000000" }] },
      actor: "operator@example.test",
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(AmazonQualificationError);

    expect(submit).toHaveBeenCalledOnce();
    expect(repository.completeQualification).toHaveBeenCalledWith(expect.objectContaining({
      state: "uncertain",
      safeErrorCode: "PROVIDER_SUBMISSION_UNCERTAIN",
    }));
  });

  it("accepts only a precise reviewed output contract into a disabled mapping", async () => {
    const { service, repository } = await harness();
    const protectedCandidate = await createLocalProviderReferenceProtector("test", KEY).protect(
      "gd_12345678",
      Buffer.from("dhumi:catalog-candidate:v1:" + CANDIDATE_ID, "utf8"),
    );
    vi.mocked(repository.resolveAcceptance).mockResolvedValueOnce({
      candidateId: CANDIDATE_ID,
      operationCode: "amazon.products.collect_by_url",
      environment: "test",
      providerExecutionMode: "scrape",
      candidateCiphertext: protectedCandidate.ciphertext,
      candidateFingerprint: protectedCandidate.fingerprint,
    });
    const result = await service.accept({
      qualificationId: "71000000-0000-4000-8000-000000000006",
      commercialConfigVersion: "pending-rate-card-v1",
      configVersion: "amazon-keyword-v1",
      restrictedReference: "restricted://pattern7/qualification/6",
      evidenceHashHex: "a".repeat(64),
      reviewer: "reviewer@example.test",
      expiresAt: null,
    });

    expect(result.mappingState).toBe("disabled");
    expect(repository.acceptQualification).toHaveBeenCalledWith(expect.objectContaining({
      outputPolicy: expect.objectContaining({
        normalizer_code: "amazon.products.collect-by-url.projected-array",
        normalizer_version: 2,
        normalized_schema_version: "amazon.products.collect-by-url.output.v1",
        provider_submission: { endpoint: "scrape" },
        provider_request: {
          mode: "collect",
          limit_per_input: null,
        },
      }),
    }));
  });

  it("blocks acceptance when no precise output contract exists", async () => {
    const { service, repository } = await harness();
    await expect(service.accept({
      qualificationId: "71000000-0000-4000-8000-000000000006",
      commercialConfigVersion: "pending-rate-card-v1",
      configVersion: "amazon-keyword-v1",
      restrictedReference: "restricted://pattern7/qualification/6",
      evidenceHashHex: "a".repeat(64),
      reviewer: "reviewer@example.test",
      expiresAt: null,
    })).rejects.toMatchObject({ code: "QUALIFICATION_OUTPUT_CONTRACT_UNAVAILABLE" });
    expect(repository.acceptQualification).not.toHaveBeenCalled();
  });
});
