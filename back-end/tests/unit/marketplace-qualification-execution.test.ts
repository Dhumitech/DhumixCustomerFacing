import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  MarketplaceFilterBoundaryError,
  type MarketplaceFilterClient,
} from "../../src/services/brightdata/marketplace/marketplaceFilterClient.js";
import type { ProviderReferenceProtector } from
  "../../src/services/brightdata/providerReferenceProtector.js";
import type { SecretProvider } from "../../src/services/secrets/secretProvider.js";
import type { QualificationEvidenceStore } from
  "../../src/services/qualification/qualificationEvidenceStore.js";
import type { MarketplaceQualificationExecutionRepository } from
  "../../src/services/marketplaceQualification/marketplaceQualificationExecutionRepository.js";
import {
  createMarketplaceQualificationExecutionService,
  MarketplaceQualificationExecutionError,
} from "../../src/services/marketplaceQualification/marketplaceQualificationExecutionService.js";

const packetId = randomUUID();
const candidateId = randomUUID();
const requestFingerprint = Buffer.alloc(32, 0x42);
const datasetFingerprint = Buffer.alloc(32, 0x31);

function checksum(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function repository(plan: Readonly<Record<string, unknown>> = {}) {
  const value: MarketplaceQualificationExecutionRepository = {
    claim: vi.fn(async () => ({
      packetId,
      candidateId,
      environment: "local" as const,
      operationCode: "marketplace.dataset.filter" as const,
      providerResourceCiphertext: Buffer.alloc(40, 0x11),
      providerResourceFingerprint: datasetFingerprint,
      exactRequest: {
        records_limit: 1,
        selected_fields: ["url", "text"],
        filter: { name: "url", operator: "is_not_null" },
      },
      maximumEstimatedCostMicros: 2_500,
      currencyCode: "USD" as const,
      pollDeadlineMs: 300_000,
      ...plan,
    })),
    recordSubmissionStart: vi.fn(async () => undefined),
    recordSnapshotReference: vi.fn(async () => undefined),
    recordPollCheckpoint: vi.fn(async () => undefined),
    completeSuccess: vi.fn(async () => undefined),
    completeFailure: vi.fn(async () => undefined),
  };
  return value;
}

function evidenceStore(): QualificationEvidenceStore {
  return {
    putImmutable: vi.fn(async (input) => ({
      objectKey: input.objectKey,
      checksumHex: checksum(input.bytes),
      byteCount: input.bytes.byteLength,
      contentType: input.contentType,
      eTag: '"fixture"',
    })),
  };
}

function protector(): ProviderReferenceProtector {
  return {
    reveal: vi.fn(async () => "gd_private_linkedin_posts"),
    protect: vi.fn(async () => ({
      ciphertext: Buffer.alloc(40, 0x22),
      fingerprint: Buffer.alloc(32, 0x23),
    })),
  };
}

function secretProvider(): SecretProvider {
  return { getSecret: vi.fn(async () => "provider-secret-for-tests") };
}

function client(overrides: Partial<MarketplaceFilterClient> = {}): MarketplaceFilterClient {
  return {
    transport: "provider",
    submit: vi.fn(async () => ({ snapshotReference: "snap_private" })),
    getSnapshotMetadata: vi.fn()
      .mockResolvedValueOnce({
        id: "snap_private",
        status: "scheduled",
        datasetId: "gd_private_linkedin_posts",
        datasetSize: null,
        fileSize: null,
        cost: null,
      })
      .mockResolvedValueOnce({
        id: "snap_private",
        status: "ready",
        datasetId: "gd_private_linkedin_posts",
        datasetSize: 1,
        fileSize: 127,
        cost: 0.0025,
      }),
    downloadSnapshot: vi.fn(async () => ({
      bytes: Readable.from([
        JSON.stringify([{
          url: "https://www.linkedin.com/posts/example-001",
          text: "Qualification record",
          provider_only: "not projected",
        }]),
      ]),
      contentType: "application/json" as const,
      contentEncoding: null,
    })),
    ...overrides,
  };
}

function create(input: {
  repository?: MarketplaceQualificationExecutionRepository;
  client?: MarketplaceFilterClient;
  now?: () => number;
}) {
  return createMarketplaceQualificationExecutionService({
    repository: input.repository ?? repository(),
    client: input.client ?? client(),
    protector: protector(),
    secretProvider: secretProvider(),
    evidenceStore: evidenceStore(),
    evidenceMaxBytes: 1_000_000,
    pollIntervalMs: 1,
    maximumPollFailures: 3,
    wait: vi.fn(async () => undefined),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}

describe("M9 bounded Marketplace live qualification", () => {
  it("makes one submission and stores protected, raw, normalized, poll and cost evidence", async () => {
    const repo = repository();
    const provider = client();
    const service = create({ repository: repo, client: provider });

    const result = await service.execute({
      confirmedExactAuthorizedPacket: true,
      packetId,
      requestFingerprint: requestFingerprint.toString("hex"),
      actor: "m9.qualification.test",
      signal: new AbortController().signal,
    });

    expect(result).toEqual(expect.objectContaining({
      packet_id: packetId,
      execution_state: "succeeded",
      record_count: 1,
      observed_cost_micros: 2_500,
      currency_code: "USD",
      provider_submissions: 1,
    }));
    expect(result).not.toHaveProperty("dataset_id");
    expect(result).not.toHaveProperty("snapshot_id");
    expect(provider.submit).toHaveBeenCalledTimes(1);
    expect(provider.submit).toHaveBeenCalledWith(expect.objectContaining({
      request: {
        dataset_id: "gd_private_linkedin_posts",
        records_limit: 1,
        filter: { name: "url", operator: "is_not_null" },
      },
    }));
    expect(repo.recordSubmissionStart).toHaveBeenCalledTimes(1);
    expect(repo.recordSnapshotReference).toHaveBeenCalledTimes(1);
    expect(repo.recordPollCheckpoint).toHaveBeenCalledTimes(2);
    expect(repo.completeSuccess).toHaveBeenCalledWith(expect.objectContaining({
      rawRecordCount: 1,
      normalizedRecordCount: 1,
      observedCostMicros: 2_500,
      currencyCode: "USD",
    }));
  });

  it("permits one bounded five-record packet with a proportional cost ceiling", async () => {
    const rawRecords = Array.from({ length: 5 }, (_, index) => ({
      url: `https://www.linkedin.com/posts/example-00${index + 1}`,
      text: `Qualification record ${index + 1}`,
    }));
    const repo = repository({
      exactRequest: {
        records_limit: 5,
        selected_fields: ["url", "text"],
        filter: { name: "url", operator: "is_not_null" },
      },
      maximumEstimatedCostMicros: 12_500,
    });
    const provider = client({
      getSnapshotMetadata: vi.fn(async () => ({
        id: "snap_private",
        status: "ready" as const,
        datasetId: "gd_private_linkedin_posts",
        datasetSize: 5,
        fileSize: 500,
        cost: 0.0125,
      })),
      downloadSnapshot: vi.fn(async () => ({
        bytes: Readable.from([JSON.stringify(rawRecords)]),
        contentType: "application/json" as const,
        contentEncoding: null,
      })),
    });
    const service = create({ repository: repo, client: provider });

    const result = await service.execute({
      confirmedExactAuthorizedPacket: true,
      packetId,
      requestFingerprint: requestFingerprint.toString("hex"),
      actor: "m9.qualification.test",
      signal: new AbortController().signal,
    });

    expect(result).toEqual(expect.objectContaining({
      record_count: 5,
      observed_cost_micros: 12_500,
      provider_submissions: 1,
    }));
    expect(provider.submit).toHaveBeenCalledTimes(1);
    expect(provider.submit).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ records_limit: 5 }),
    }));
  });

  it("never retries an uncertain submission and records manual reconciliation", async () => {
    const repo = repository();
    const provider = client({
      submit: vi.fn(async () => {
        throw new MarketplaceFilterBoundaryError({
          code: "MARKETPLACE_FILTER_SUBMISSION_UNCERTAIN",
          retryable: false,
          submissionOutcome: "uncertain",
        });
      }),
    });
    const service = create({ repository: repo, client: provider });

    await expect(service.execute({
      confirmedExactAuthorizedPacket: true,
      packetId,
      requestFingerprint: requestFingerprint.toString("hex"),
      actor: "m9.qualification.test",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "MARKETPLACE_QUALIFICATION_SUBMISSION_UNCERTAIN" });

    expect(provider.submit).toHaveBeenCalledTimes(1);
    expect(repo.completeFailure).toHaveBeenCalledWith(expect.objectContaining({
      executionState: "uncertain",
      safeErrorCode: "MARKETPLACE_QUALIFICATION_SUBMISSION_UNCERTAIN",
    }));
  });

  it("records uncertainty when the provider accepted work but its snapshot cannot be persisted", async () => {
    const repo = repository();
    const brokenProtector = protector();
    vi.mocked(brokenProtector.protect).mockRejectedValueOnce(new Error("storage unavailable"));
    const provider = client();
    const service = createMarketplaceQualificationExecutionService({
      repository: repo,
      client: provider,
      protector: brokenProtector,
      secretProvider: secretProvider(),
      evidenceStore: evidenceStore(),
      evidenceMaxBytes: 1_000_000,
      pollIntervalMs: 1,
      maximumPollFailures: 3,
      wait: vi.fn(async () => undefined),
    });

    await expect(service.execute({
      confirmedExactAuthorizedPacket: true,
      packetId,
      requestFingerprint: requestFingerprint.toString("hex"),
      actor: "m9.qualification.test",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: "MARKETPLACE_QUALIFICATION_SUBMISSION_UNCERTAIN",
      executionState: "uncertain",
    });

    expect(provider.submit).toHaveBeenCalledTimes(1);
    expect(repo.recordSnapshotReference).not.toHaveBeenCalled();
    expect(repo.completeFailure).toHaveBeenCalledWith(expect.objectContaining({
      executionState: "uncertain",
      safeErrorCode: "MARKETPLACE_QUALIFICATION_SUBMISSION_UNCERTAIN",
    }));
  });

  it("fails closed when provider cost exceeds the exact packet ceiling", async () => {
    const repo = repository();
    const provider = client({
      getSnapshotMetadata: vi.fn(async () => ({
        id: "snap_private",
        status: "ready" as const,
        datasetId: "gd_private_linkedin_posts",
        datasetSize: 1,
        fileSize: 127,
        cost: 0.01,
      })),
    });
    const service = create({ repository: repo, client: provider });

    await expect(service.execute({
      confirmedExactAuthorizedPacket: true,
      packetId,
      requestFingerprint: requestFingerprint.toString("hex"),
      actor: "m9.qualification.test",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "MARKETPLACE_QUALIFICATION_COST_CEILING_EXCEEDED" });

    expect(provider.downloadSnapshot).not.toHaveBeenCalled();
    expect(repo.completeFailure).toHaveBeenCalledWith(expect.objectContaining({
      executionState: "failed",
      safeErrorCode: "MARKETPLACE_QUALIFICATION_COST_CEILING_EXCEEDED",
      observedCostMicros: 10_000,
    }));
  });

  it("rejects an unsafe packet ceiling before reading the secret or submitting", async () => {
    const repo = repository({ maximumEstimatedCostMicros: 2_501 });
    const provider = client();
    const secrets = secretProvider();
    const service = createMarketplaceQualificationExecutionService({
      repository: repo,
      client: provider,
      protector: protector(),
      secretProvider: secrets,
      evidenceStore: evidenceStore(),
      evidenceMaxBytes: 1_000_000,
      pollIntervalMs: 1,
      maximumPollFailures: 3,
      wait: vi.fn(async () => undefined),
    });

    await expect(service.execute({
      confirmedExactAuthorizedPacket: true,
      packetId,
      requestFingerprint: requestFingerprint.toString("hex"),
      actor: "m9.qualification.test",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: "MARKETPLACE_QUALIFICATION_SAFETY_LIMIT_EXCEEDED",
    });

    expect(secrets.getSecret).not.toHaveBeenCalled();
    expect(provider.submit).not.toHaveBeenCalled();
    expect(repo.recordSubmissionStart).not.toHaveBeenCalled();
  });

  it("rejects more than five requested records before provider submission", async () => {
    const repo = repository({
      exactRequest: {
        records_limit: 6,
        selected_fields: ["url", "text"],
        filter: { name: "url", operator: "is_not_null" },
      },
    });
    const provider = client();
    const service = create({ repository: repo, client: provider });

    await expect(service.execute({
      confirmedExactAuthorizedPacket: true,
      packetId,
      requestFingerprint: requestFingerprint.toString("hex"),
      actor: "m9.qualification.test",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: "MARKETPLACE_QUALIFICATION_SAFETY_LIMIT_EXCEEDED",
    });

    expect(provider.submit).not.toHaveBeenCalled();
    expect(repo.recordSubmissionStart).not.toHaveBeenCalled();
  });

  it("rejects a cost ceiling that is not proportional to the requested records", async () => {
    const repo = repository({
      exactRequest: {
        records_limit: 5,
        selected_fields: ["url", "text"],
        filter: { name: "url", operator: "is_not_null" },
      },
      maximumEstimatedCostMicros: 12_501,
    });
    const provider = client();
    const secrets = secretProvider();
    const service = createMarketplaceQualificationExecutionService({
      repository: repo,
      client: provider,
      protector: protector(),
      secretProvider: secrets,
      evidenceStore: evidenceStore(),
      evidenceMaxBytes: 1_000_000,
      pollIntervalMs: 1,
      maximumPollFailures: 3,
      wait: vi.fn(async () => undefined),
    });

    await expect(service.execute({
      confirmedExactAuthorizedPacket: true,
      packetId,
      requestFingerprint: requestFingerprint.toString("hex"),
      actor: "m9.qualification.test",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: "MARKETPLACE_QUALIFICATION_SAFETY_LIMIT_EXCEEDED",
    });

    expect(secrets.getSecret).not.toHaveBeenCalled();
    expect(provider.submit).not.toHaveBeenCalled();
    expect(repo.recordSubmissionStart).not.toHaveBeenCalled();
  });

  it("stops before download when interim metadata exceeds the cost ceiling", async () => {
    const repo = repository();
    const provider = client({
      getSnapshotMetadata: vi.fn(async () => ({
        id: "snap_private",
        status: "building" as const,
        datasetId: "gd_private_linkedin_posts",
        datasetSize: 1,
        fileSize: null,
        cost: 0.01,
      })),
    });
    const service = create({ repository: repo, client: provider });

    await expect(service.execute({
      confirmedExactAuthorizedPacket: true,
      packetId,
      requestFingerprint: requestFingerprint.toString("hex"),
      actor: "m9.qualification.test",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: "MARKETPLACE_QUALIFICATION_COST_CEILING_EXCEEDED",
    });

    expect(provider.getSnapshotMetadata).toHaveBeenCalledTimes(1);
    expect(provider.downloadSnapshot).not.toHaveBeenCalled();
    expect(repo.completeFailure).toHaveBeenCalledWith(expect.objectContaining({
      observedCostMicros: 10_000,
    }));
  });

  it("rounds fractional provider cost upward and fails closed above the ceiling", async () => {
    const repo = repository();
    const provider = client({
      getSnapshotMetadata: vi.fn(async () => ({
        id: "snap_private",
        status: "building" as const,
        datasetId: "gd_private_linkedin_posts",
        datasetSize: 1,
        fileSize: null,
        cost: 0.0025001,
      })),
    });
    const service = create({ repository: repo, client: provider });

    await expect(service.execute({
      confirmedExactAuthorizedPacket: true,
      packetId,
      requestFingerprint: requestFingerprint.toString("hex"),
      actor: "m9.qualification.test",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: "MARKETPLACE_QUALIFICATION_COST_CEILING_EXCEEDED",
    });

    expect(provider.getSnapshotMetadata).toHaveBeenCalledTimes(1);
    expect(provider.downloadSnapshot).not.toHaveBeenCalled();
    expect(repo.completeFailure).toHaveBeenCalledWith(expect.objectContaining({
      observedCostMicros: 2_501,
    }));
  });

  it("stops before download when metadata exceeds the packet record ceiling", async () => {
    const repo = repository();
    const provider = client({
      getSnapshotMetadata: vi.fn(async () => ({
        id: "snap_private",
        status: "building" as const,
        datasetId: "gd_private_linkedin_posts",
        datasetSize: 2,
        fileSize: null,
        cost: null,
      })),
    });
    const service = create({ repository: repo, client: provider });

    await expect(service.execute({
      confirmedExactAuthorizedPacket: true,
      packetId,
      requestFingerprint: requestFingerprint.toString("hex"),
      actor: "m9.qualification.test",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: "MARKETPLACE_QUALIFICATION_RECORD_CEILING_EXCEEDED",
    });

    expect(provider.getSnapshotMetadata).toHaveBeenCalledTimes(1);
    expect(provider.downloadSnapshot).not.toHaveBeenCalled();
  });

  it("rejects fixture transport and missing exact confirmation before claiming", async () => {
    const repo = repository();
    expect(() => createMarketplaceQualificationExecutionService({
      repository: repo,
      client: { ...client(), transport: "fixture" },
      protector: protector(),
      secretProvider: secretProvider(),
      evidenceStore: evidenceStore(),
      evidenceMaxBytes: 1_000_000,
      pollIntervalMs: 1,
      maximumPollFailures: 3,
    })).toThrow(MarketplaceQualificationExecutionError);

    const service = create({ repository: repo });
    await expect(service.execute({
      confirmedExactAuthorizedPacket: false as true,
      packetId,
      requestFingerprint: requestFingerprint.toString("hex"),
      actor: "m9.qualification.test",
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(MarketplaceQualificationExecutionError);
    expect(repo.claim).not.toHaveBeenCalled();
  });
});
