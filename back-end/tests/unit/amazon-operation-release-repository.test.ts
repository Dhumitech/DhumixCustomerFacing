import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createAmazonOperationReleaseRepository } from
  "../../src/services/release/amazonOperationReleaseRepository.js";

describe("Amazon operation release repository", () => {
  it("assumes the restricted operator capability before publishing", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{
          operation_code: "amazon.products.collect_by_url",
          template_slug: "amazon-products-collect-by-url",
          template_version: 3,
          environment: "local",
          release_outcome: "published",
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const release = vi.fn();
    const pool = {
      connect: vi.fn(async () => ({ query, release })),
    } as unknown as Pool;

    const result = await createAmazonOperationReleaseRepository(pool).publish({
      expectedEnvironment: "local",
      qualificationId: "33994c2b-845d-455c-a72c-adba4bd8f143",
      restrictedReference: "restricted://amazon/products/local-e2e",
      evidenceHash: Buffer.alloc(32, 1),
      reviewer: "project.owner.local",
      reason: "local_customer_e2e",
      expiresAt: null,
    });

    expect(result).toEqual({
      operationCode: "amazon.products.collect_by_url",
      templateSlug: "amazon-products-collect-by-url",
      templateVersion: 3,
      environment: "local",
      outcome: "published",
    });
    expect(query.mock.calls[0]).toEqual(["BEGIN"]);
    expect(query.mock.calls[1]).toEqual(["SET LOCAL ROLE dhumi_operator"]);
    expect(String(query.mock.calls[2]?.[0])).toContain(
      "app.publish_qualified_amazon_operation_v1",
    );
    expect(query.mock.calls[3]).toEqual(["COMMIT"]);
    expect(release).toHaveBeenCalledWith(undefined);
  });

  it("reuses the restricted operator transaction for the offline v4 contract release", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{
          operation_code: "amazon.products.collect_by_url",
          template_slug: "amazon-products-collect-by-url",
          template_version: 4,
          environment: "local",
          release_outcome: "published",
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const release = vi.fn();
    const pool = {
      connect: vi.fn(async () => ({ query, release })),
    } as unknown as Pool;

    const result = await createAmazonOperationReleaseRepository(pool)
      .upgradeProductsInputContract({
        expectedEnvironment: "local",
        restrictedReference: "restricted://amazon/products/input-v4",
        evidenceHash: Buffer.alloc(32, 2),
        reviewer: "project.owner.local",
        reason: "products_input_v4_approved",
        expiresAt: null,
      });

    expect(result.templateVersion).toBe(4);
    expect(query.mock.calls[0]).toEqual(["BEGIN"]);
    expect(query.mock.calls[1]).toEqual(["SET LOCAL ROLE dhumi_operator"]);
    expect(String(query.mock.calls[2]?.[0])).toContain(
      "app.publish_amazon_products_input_contract_v4",
    );
    expect(query.mock.calls[3]).toEqual(["COMMIT"]);
  });
});
