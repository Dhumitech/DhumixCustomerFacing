import { describe, expect, it, vi } from "vitest";
import {
  AmazonOperationReleaseError,
  createAmazonOperationReleaseService,
} from "../../src/services/release/amazonOperationReleaseService.js";
import type { AmazonOperationReleaseRepository } from "../../src/services/release/amazonOperationReleaseRepository.js";

const input = {
  confirmedPublication: true as const,
  expectedEnvironment: "test" as const,
  qualificationId: "81000000-0000-4000-8000-000000000001",
  restrictedReference: "restricted://amazon/releases/products-v2",
  evidenceHashHex: "a".repeat(64),
  reviewer: "release.reviewer@example.test",
  reason: "products-v2-evidence-approved",
  expiresAt: null,
};

function harness() {
  const repository: AmazonOperationReleaseRepository = {
    publish: vi.fn(async () => ({
      operationCode: "amazon.products.collect_by_url",
      templateSlug: "amazon-products-collect-by-url",
      templateVersion: 2,
      environment: "test" as const,
      outcome: "published" as const,
    })),
    upgradeProductsInputContract: vi.fn(async () => ({
      operationCode: "amazon.products.collect_by_url",
      templateSlug: "amazon-products-collect-by-url",
      templateVersion: 4,
      environment: "test" as const,
      outcome: "published" as const,
    })),
  };
  return {
    repository,
    service: createAmazonOperationReleaseService({ repository }),
  };
}

describe("controlled Amazon operation release", () => {
  it("publishes only after explicit confirmation and returns provider-safe fields", async () => {
    const { service, repository } = harness();

    const result = await service.publish(input);

    expect(result).toEqual({
      operationCode: "amazon.products.collect_by_url",
      templateSlug: "amazon-products-collect-by-url",
      templateVersion: 2,
      environment: "test",
      outcome: "published",
    });
    expect(repository.publish).toHaveBeenCalledWith({
      expectedEnvironment: "test",
      qualificationId: input.qualificationId,
      restrictedReference: input.restrictedReference,
      evidenceHash: Buffer.from(input.evidenceHashHex, "hex"),
      reviewer: input.reviewer,
      reason: input.reason,
      expiresAt: null,
    });
    expect(JSON.stringify(result)).not.toMatch(/dataset|credential|mapping_id|snapshot/i);
  });

  it("rejects a missing publication confirmation without touching PostgreSQL", async () => {
    const { service, repository } = harness();

    await expect(service.publish({
      ...input,
      confirmedPublication: false as true,
    })).rejects.toMatchObject({ code: "AMAZON_RELEASE_CONFIRMATION_REQUIRED" });
    expect(repository.publish).not.toHaveBeenCalled();
  });

  it("rejects malformed evidence, reviewer, reason and expiry", async () => {
    const { service, repository } = harness();
    const invalidInputs = [
      { ...input, evidenceHashHex: "not-a-hash" },
      { ...input, restrictedReference: "short" },
      { ...input, reviewer: "?" },
      { ...input, reason: "contains spaces" },
      { ...input, expiresAt: new Date(0) },
    ];

    for (const invalid of invalidInputs) {
      await expect(service.publish(invalid)).rejects.toBeInstanceOf(AmazonOperationReleaseError);
    }
    expect(repository.publish).not.toHaveBeenCalled();
  });

  it("publishes the offline v4 contract through the same restricted operator", async () => {
    const { service, repository } = harness();

    const result = await service.upgradeProductsInputContract({
      confirmedPublication: true,
      expectedEnvironment: "test",
      restrictedReference: input.restrictedReference,
      evidenceHashHex: input.evidenceHashHex,
      reviewer: input.reviewer,
      reason: "products_input_v4_approved",
      expiresAt: null,
    });

    expect(result.templateVersion).toBe(4);
    expect(repository.upgradeProductsInputContract).toHaveBeenCalledWith({
      expectedEnvironment: "test",
      restrictedReference: input.restrictedReference,
      evidenceHash: Buffer.from(input.evidenceHashHex, "hex"),
      reviewer: input.reviewer,
      reason: "products_input_v4_approved",
      expiresAt: null,
    });
  });

  it("requires confirmation before the v4 contract release", async () => {
    const { service, repository } = harness();

    await expect(service.upgradeProductsInputContract({
      confirmedPublication: false,
      expectedEnvironment: "test",
      restrictedReference: input.restrictedReference,
      evidenceHashHex: input.evidenceHashHex,
      reviewer: input.reviewer,
      reason: "products_input_v4_approved",
      expiresAt: null,
    })).rejects.toMatchObject({ code: "AMAZON_RELEASE_CONFIRMATION_REQUIRED" });
    expect(repository.upgradeProductsInputContract).not.toHaveBeenCalled();
  });
});
