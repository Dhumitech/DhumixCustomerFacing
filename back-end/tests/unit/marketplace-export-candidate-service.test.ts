import { describe, expect, it, vi } from "vitest";
import type { ProviderReferenceProtector } from
  "../../src/services/brightdata/providerReferenceProtector.js";
import {
  createMarketplaceExportCandidateService,
} from "../../src/services/marketplaceExportCandidate/marketplaceExportCandidateService.js";
import type {
  MarketplaceExportCandidateRepository,
} from "../../src/services/marketplaceExportCandidate/marketplaceExportCandidateRepository.js";

const PACKET_ID = "2e1560c3-ca8b-40a0-b578-c9e71ecf27cd";
const MAPPING_ID = "92000000-0000-4000-8000-000000000001";

function dependencies() {
  const repository: MarketplaceExportCandidateRepository = {
    resolveSource: vi.fn().mockResolvedValue({
      packetId: PACKET_ID,
      candidateId: "92000000-0000-4000-8000-000000000002",
      environment: "test",
      resourceCode: "linkedin.posts",
      providerResourceCiphertext: Buffer.alloc(40, 1),
      providerResourceFingerprint: Buffer.alloc(32, 2),
    }),
    register: vi.fn().mockResolvedValue({
      mappingId: MAPPING_ID,
      templateSlug: "linkedin-posts",
      templateVersion: 2,
      mappingState: "disabled",
      disposition: "registered",
    }),
  };
  const protector: ProviderReferenceProtector = {
    reveal: vi.fn().mockResolvedValue("gd_test_linkedin_posts"),
    protect: vi.fn().mockResolvedValue({
      ciphertext: Buffer.alloc(48, 3),
      fingerprint: Buffer.alloc(32, 4),
    }),
  };
  return { repository, protector, expectedEnvironment: "test" as const };
}

describe("M10 Marketplace export candidate service", () => {
  it("re-protects catalogue identity for the immutable mapping ID and registers disabled", async () => {
    const deps = dependencies();
    const service = createMarketplaceExportCandidateService(deps);

    const result = await service.register({
      packetId: PACKET_ID,
      mappingId: MAPPING_ID,
      actor: "m10.release.owner",
      evidenceReference: "checkpoint://dataset-market/m10/technical-acceptance",
      reason: "Accept exact M9 LinkedIn Posts evidence as a disabled candidate",
    });

    expect(deps.protector.reveal).toHaveBeenCalledWith(
      Buffer.alloc(40, 1),
      Buffer.alloc(32, 2),
      Buffer.from("dhumi:marketplace-catalogue:v1:test:linkedin.posts", "utf8"),
    );
    expect(deps.protector.protect).toHaveBeenCalledWith(
      "gd_test_linkedin_posts",
      Buffer.from(`dhumi:provider-mapping:v1:${MAPPING_ID}`, "utf8"),
    );
    expect(deps.repository.register).toHaveBeenCalledWith(expect.objectContaining({
      packetId: PACKET_ID,
      mappingId: MAPPING_ID,
      providerResourceCiphertext: Buffer.alloc(48, 3),
      providerResourceFingerprint: Buffer.alloc(32, 4),
    }));
    expect(result).toEqual(expect.objectContaining({
      mapping_state: "disabled",
      customer_execution_enabled: false,
      provider_calls: 0,
    }));
  });

  it("fails before repository or protection work for malformed operator input", async () => {
    const deps = dependencies();
    const service = createMarketplaceExportCandidateService(deps);

    await expect(service.register({
      packetId: "not-a-uuid",
      mappingId: MAPPING_ID,
      actor: "m10.release.owner",
      evidenceReference: "checkpoint://dataset-market/m10/technical-acceptance",
      reason: "Accept exact M9 LinkedIn Posts evidence as a disabled candidate",
    })).rejects.toMatchObject({
      code: "MARKETPLACE_EXPORT_CANDIDATE_INPUT_INVALID",
    });
    expect(deps.repository.resolveSource).not.toHaveBeenCalled();
    expect(deps.protector.reveal).not.toHaveBeenCalled();
  });

  it("fails closed before decryption when the packet environment differs", async () => {
    const deps = dependencies();
    deps.repository.resolveSource = vi.fn().mockResolvedValue({
      packetId: PACKET_ID,
      candidateId: "92000000-0000-4000-8000-000000000002",
      environment: "local",
      resourceCode: "linkedin.posts",
      providerResourceCiphertext: Buffer.alloc(40, 1),
      providerResourceFingerprint: Buffer.alloc(32, 2),
    });
    const service = createMarketplaceExportCandidateService(deps);

    await expect(service.register({
      packetId: PACKET_ID,
      mappingId: MAPPING_ID,
      actor: "m10.release.owner",
      evidenceReference: "checkpoint://dataset-market/m10/technical-acceptance",
      reason: "Accept exact M9 LinkedIn Posts evidence as a disabled candidate",
    })).rejects.toMatchObject({
      code: "MARKETPLACE_EXPORT_CANDIDATE_FAILED",
    });
    expect(deps.protector.reveal).not.toHaveBeenCalled();
    expect(deps.repository.register).not.toHaveBeenCalled();
  });
});
