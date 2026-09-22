import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  MarketplaceQualificationPreflightRepository,
} from "../../src/services/marketplaceQualification/marketplaceQualificationPreflightRepository.js";
import {
  MarketplaceQualificationPreflightError,
  createMarketplaceQualificationPreflightService,
} from "../../src/services/marketplaceQualification/marketplaceQualificationPreflightService.js";

const candidateId = randomUUID();
const packetId = randomUUID();
const templateVersionId = randomUUID();
const filterAdapterVersionId = randomUUID();
const providerResourceFingerprint = Buffer.alloc(32, 0x31);

function repository(): MarketplaceQualificationPreflightRepository {
  return {
    resolveContext: vi.fn(async () => ({
      candidateId,
      templateVersionId,
      filterAdapterVersionId,
      providerResourceFingerprint,
      outputSchema: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            url: { type: "string", format: "uri" },
            text: { type: ["string", "null"] },
            posted_at: { type: ["string", "null"], format: "date-time" },
          },
        },
      },
    })),
    prepare: vi.fn(async (input) => ({
      packetId: input.packetId,
      requestFingerprint: Buffer.alloc(32, 0x42),
      authorizationState: "not_authorized" as const,
    })),
    authorize: vi.fn(async () => ({ authorizationState: "authorized" as const })),
  };
}

function validInput() {
  return {
    packetId,
    candidateId,
    environment: "local" as const,
    filter: { name: "posted_at", operator: ">=", value: "2026-01-01T00:00:00.000Z" },
    selectedFields: ["url", "text", "posted_at"] as const,
    recordsLimit: 100,
    maximumEstimatedCostMicros: 250_000,
    currencyCode: "USD" as const,
    maximumProviderSubmissions: 1 as const,
    automaticSubmissionRetries: 0 as const,
    pollDeadlineMs: 300_000,
    actor: "m9.preflight.test",
  };
}

describe("M9 Marketplace qualification packet preflight", () => {
  it("freezes a reviewed request without revealing the protected Dataset identity", async () => {
    const repo = repository();
    const service = createMarketplaceQualificationPreflightService(repo);

    const result = await service.prepare(validInput());

    expect(result).toEqual({
      packet_id: packetId,
      request_fingerprint: Buffer.alloc(32, 0x42).toString("hex"),
      authorization_state: "not_authorized",
      provider_calls: 0,
    });
    expect(repo.prepare).toHaveBeenCalledWith(expect.objectContaining({
      packetId,
      candidateId,
      templateVersionId,
      filterAdapterVersionId,
      providerResourceFingerprint,
      exactRequest: {
        records_limit: 100,
        selected_fields: ["url", "text", "posted_at"],
        filter: { name: "posted_at", operator: ">=", value: "2026-01-01T00:00:00.000Z" },
      },
      expectedArtifactKinds: ["raw", "normalized"],
      maximumProviderSubmissions: 1,
      automaticSubmissionRetries: 0,
    }));
    expect(JSON.stringify(result)).not.toContain("gd_");
  });

  it.each([
    ["records", { recordsLimit: 0 }],
    ["cost", { maximumEstimatedCostMicros: 0 }],
    ["currency", { currencyCode: "EUR" }],
    ["submissions", { maximumProviderSubmissions: 2 }],
    ["retries", { automaticSubmissionRetries: 1 }],
    ["deadline", { pollDeadlineMs: 300_001 }],
    ["fields", { selectedFields: ["provider_only"] }],
    ["duplicate fields", { selectedFields: ["url", "url"] }],
    ["filter", { filter: { name: "provider_only", operator: "is_not_null" } }],
  ])("rejects an invalid %s boundary before persistence", async (_name, change) => {
    const repo = repository();
    const service = createMarketplaceQualificationPreflightService(repo);
    await expect(service.prepare({ ...validInput(), ...change } as never))
      .rejects.toBeInstanceOf(MarketplaceQualificationPreflightError);
    expect(repo.prepare).not.toHaveBeenCalled();
  });

  it("authorizes only the exact prepared fingerprint and bounded authority", async () => {
    const repo = repository();
    const service = createMarketplaceQualificationPreflightService(repo);
    const fingerprint = Buffer.alloc(32, 0x42).toString("hex");
    const authorizationHash = Buffer.alloc(32, 0x51).toString("hex");

    const result = await service.authorize({
      packetId,
      requestFingerprint: fingerprint,
      recordsLimit: 100,
      maximumEstimatedCostMicros: 250_000,
      currencyCode: "USD",
      maximumProviderSubmissions: 1,
      automaticSubmissionRetries: 0,
      authorizationReference: "checkpoint://dataset-market/m9/authorization/0001",
      authorizationHash,
      issuer: "dhumi.release.owner",
      effectiveAt: new Date("2026-09-12T12:00:00.000Z"),
      expiresAt: new Date("2026-09-12T13:00:00.000Z"),
    });

    expect(result).toEqual({
      packet_id: packetId,
      authorization_state: "authorized",
      provider_calls: 0,
    });
    expect(repo.authorize).toHaveBeenCalledWith(expect.objectContaining({
      requestFingerprint: Buffer.alloc(32, 0x42),
      authorizationHash: Buffer.alloc(32, 0x51),
      maximumProviderSubmissions: 1,
      automaticSubmissionRetries: 0,
    }));
  });

  it("rejects malformed, expired or unbounded authorization before persistence", async () => {
    const repo = repository();
    const service = createMarketplaceQualificationPreflightService(repo);
    const base = {
      packetId,
      requestFingerprint: Buffer.alloc(32, 0x42).toString("hex"),
      recordsLimit: 100,
      maximumEstimatedCostMicros: 250_000,
      currencyCode: "USD" as const,
      maximumProviderSubmissions: 1 as const,
      automaticSubmissionRetries: 0 as const,
      authorizationReference: "checkpoint://dataset-market/m9/authorization/0001",
      authorizationHash: Buffer.alloc(32, 0x51).toString("hex"),
      issuer: "dhumi.release.owner",
      effectiveAt: new Date("2026-09-12T12:00:00.000Z"),
      expiresAt: new Date("2026-09-12T13:00:00.000Z"),
    };
    for (const change of [
      { requestFingerprint: "bad" },
      { maximumProviderSubmissions: 2 },
      { automaticSubmissionRetries: 1 },
      { authorizationReference: "not-a-governed-reference" },
      { expiresAt: new Date("2026-09-12T11:59:59.000Z") },
    ]) {
      await expect(service.authorize({ ...base, ...change } as never))
        .rejects.toBeInstanceOf(MarketplaceQualificationPreflightError);
    }
    expect(repo.authorize).not.toHaveBeenCalled();
  });
});
