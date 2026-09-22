import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ProviderReferenceProtector } from
  "../../src/services/brightdata/providerReferenceProtector.js";
import type { MarketplaceContactContractRepository } from
  "../../src/services/marketplacePeople/marketplaceContactContractRepository.js";
import {
  createMarketplaceContactContractService,
} from "../../src/services/marketplacePeople/marketplaceContactContractService.js";

const candidateId = "f60af142-3f00-4b0f-b159-86b41ff74b7f";
const templateVersionId = "8c000000-0000-4000-8000-000000000001";
const packetId = "8c000000-0000-4000-8000-000000000002";
const contactDatasetId = "gd_me5ppxjr2ge6icjuh0";
const faqSourceUri = "https://docs.brightdata.com/products/marketplace/faqs";
const searchSourceUri =
  "https://docs.brightdata.com/api-reference/marketplace-dataset-api/search-dataset";

const faqBytes = Buffer.from(`
Does the "LinkedIn People Profiles" dataset include email addresses or phone numbers?
Standard LinkedIn profile data: No contact info.
Contact data coverage may vary by profile and use case.
Standard Profiles + Enriched with Business Contact Info
Only Profiles with Business Contact Info
Receive available business emails and phone numbers where provided via RevenueBase.
`);

const searchBytes = Buffer.from(`
Send a POST request to /datasets/search/:dataset_id
LinkedIn people profiles, contact-enriched | ${contactDatasetId}
Search returns the records inline using hits and total_hits.
`);

function dependencies(existing: Awaited<ReturnType<
  MarketplaceContactContractRepository["findContract"]
>> = undefined) {
  const repository: MarketplaceContactContractRepository = {
    resolveStandardPeopleCandidate: vi.fn(async () => ({
      candidateId,
      environment: "local" as const,
      templateVersionId,
      templateVersion: 1 as const,
      metadataChecksum: Buffer.alloc(32, 3),
      sampleVersion: 1 as const,
    })),
    findContract: vi.fn(async () => existing),
    recordContract: vi.fn(async (input) => ({
      packetId: input.packetId,
      templateVersionId: input.templateVersionId,
      contractVersion: input.contractVersion,
      governanceState: "fulfillment_evidence_pending" as const,
      fulfillmentState: "not_enabled" as const,
      registeredAt: new Date("2026-09-13T18:00:00.000Z"),
      disposition: "created" as const,
    })),
  };
  const evidenceStore = {
    putImmutable: vi.fn(async (input: {
      objectKey: string;
      bytes: Buffer;
      contentType: string;
    }) => ({
      objectKey: input.objectKey,
      checksumHex: createHash("sha256").update(input.bytes).digest("hex"),
      byteCount: input.bytes.byteLength,
      contentType: input.contentType,
      eTag: "etag",
    })),
  };
  const protector: ProviderReferenceProtector = {
    protect: vi.fn(async () => ({
      ciphertext: Buffer.alloc(48, 4),
      fingerprint: Buffer.alloc(32, 5),
    })),
    reveal: vi.fn(),
  };
  return { repository, evidenceStore, protector };
}

describe("LinkedIn People contact-contract evidence service", () => {
  it("registers only the documented contact choices and leaves fulfillment disabled", async () => {
    const deps = dependencies();
    const service = createMarketplaceContactContractService({
      ...deps,
      evidenceMaxBytes: 1_000_000,
      uuid: () => packetId,
      now: () => new Date("2026-09-13T18:00:00.000Z"),
    });

    const result = await service.register({
      standardPeopleCandidateId: candidateId,
      actor: "marketplace.people.contact.local",
      restrictedReference: "checkpoint://dataset-market/linkedin-people/contact-contract-v1",
      faq: { sourceUri: faqSourceUri, bytes: faqBytes },
      search: { sourceUri: searchSourceUri, bytes: searchBytes },
      confirmedOfflineEvidence: true,
    });

    expect(deps.protector.protect).toHaveBeenCalledWith(
      contactDatasetId,
      Buffer.from("dhumi:marketplace-contact-contract:v1:local:linkedin.people.contact-enriched"),
    );
    expect(deps.evidenceStore.putImmutable).toHaveBeenCalledTimes(3);
    expect(deps.repository.recordContract).toHaveBeenCalledWith(expect.objectContaining({
      packetId,
      candidateId,
      templateVersionId,
      contractVersion: 1,
      faqEvidenceObjectKey:
        `qualification/contact-contracts/${packetId}/marketplace-faq.md`,
      searchEvidenceObjectKey:
        `qualification/contact-contracts/${packetId}/search-contract.md`,
      contactModes: [
        expect.objectContaining({ code: "standard", previewState: "available" }),
        expect.objectContaining({
          code: "enriched_when_available",
          previewState: "not_enabled",
        }),
        expect.objectContaining({ code: "contacts_only", previewState: "not_enabled" }),
      ],
      governanceState: "fulfillment_evidence_pending",
      fulfillmentState: "not_enabled",
      providerCalls: 0,
    }));
    expect(result).toMatchObject({
      packetId,
      contractVersion: 1,
      governanceState: "fulfillment_evidence_pending",
      fulfillmentState: "not_enabled",
      providerCalls: 0,
      disposition: "created",
    });
    expect(JSON.stringify(result)).not.toContain(contactDatasetId);
    expect(JSON.stringify(result)).not.toContain("qualification/contact-contracts");
  });

  it("fails closed when evidence is unconfirmed or does not contain the documented choices", async () => {
    const deps = dependencies();
    const service = createMarketplaceContactContractService({
      ...deps,
      evidenceMaxBytes: 1_000_000,
      uuid: () => packetId,
    });

    await expect(service.register({
      standardPeopleCandidateId: candidateId,
      actor: "marketplace.people.contact.local",
      restrictedReference: "checkpoint://dataset-market/linkedin-people/contact-contract-v1",
      faq: { sourceUri: faqSourceUri, bytes: faqBytes },
      search: { sourceUri: searchSourceUri, bytes: searchBytes },
    })).rejects.toMatchObject({
      code: "MARKETPLACE_CONTACT_CONTRACT_CONFIRMATION_REQUIRED",
    });

    await expect(service.register({
      standardPeopleCandidateId: candidateId,
      actor: "marketplace.people.contact.local",
      restrictedReference: "checkpoint://dataset-market/linkedin-people/contact-contract-v1",
      faq: { sourceUri: faqSourceUri, bytes: Buffer.from("incomplete") },
      search: { sourceUri: searchSourceUri, bytes: searchBytes },
      confirmedOfflineEvidence: true,
    })).rejects.toMatchObject({ code: "MARKETPLACE_CONTACT_CONTRACT_EVIDENCE_INVALID" });

    expect(deps.evidenceStore.putImmutable).not.toHaveBeenCalled();
    expect(deps.repository.recordContract).not.toHaveBeenCalled();
  });

  it("replays an identical contract without writing another evidence object", async () => {
    const faqChecksum = createHash("sha256").update(faqBytes).digest();
    const searchChecksum = createHash("sha256").update(searchBytes).digest();
    const deps = dependencies({
      packetId,
      templateVersionId,
      contractVersion: 1,
      faqChecksum,
      searchChecksum,
      providerResourceFingerprint: Buffer.alloc(32, 5),
      governanceState: "fulfillment_evidence_pending",
      fulfillmentState: "not_enabled",
      registeredAt: new Date("2026-09-13T18:00:00.000Z"),
    });
    const service = createMarketplaceContactContractService({
      ...deps,
      evidenceMaxBytes: 1_000_000,
      uuid: () => "8c000000-0000-4000-8000-000000000099",
    });

    const result = await service.register({
      standardPeopleCandidateId: candidateId,
      actor: "marketplace.people.contact.local",
      restrictedReference: "checkpoint://dataset-market/linkedin-people/contact-contract-v1",
      faq: { sourceUri: faqSourceUri, bytes: faqBytes },
      search: { sourceUri: searchSourceUri, bytes: searchBytes },
      confirmedOfflineEvidence: true,
    });

    expect(result.disposition).toBe("existing");
    expect(deps.evidenceStore.putImmutable).not.toHaveBeenCalled();
    expect(deps.repository.recordContract).not.toHaveBeenCalled();
  });
});
