import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getAmazonOperationDefinition,
} from "../../src/services/brightdata/amazon/amazonOperationDefinitions.js";
import {
  AmazonOperationContractError,
  serializeAmazonProviderRequest,
} from "../../src/services/brightdata/amazon/amazonOperationSerializer.js";

const cases = [
  ["amazon.products.collect_by_url", "amazon-products-collect-by-url.json"],
  ["amazon.products_global.collect_by_url", "amazon-products-global-collect-by-url.json"],
  ["amazon.products_search.collect_by_url", "amazon-products-search-collect-by-url.json"],
  ["amazon.reviews.collect_by_url", "amazon-reviews-collect-by-url.json"],
  ["amazon.sellers.collect_by_url", "amazon-sellers-collect-by-url.json"],
  ["amazon.products_global.discover_by_category_url", "amazon-products-global-discover-by-category-url.json"],
  ["amazon.products.discover_by_category_url", "amazon-products-discover-by-category-url.json"],
  ["amazon.products.discover_by_keyword", "amazon-products-discover-by-keyword.json"],
  ["amazon.products.discover_by_upc", "amazon-products-discover-by-upc.json"],
  ["amazon.products.discover_by_best_sellers_url", "amazon-products-discover-by-best-sellers-url.json"],
  ["amazon.products_global.discover_by_brand", "amazon-products-global-discover-by-brand.json"],
  ["amazon.products_global.discover_by_keyword", "amazon-products-global-discover-by-keyword.json"],
  ["amazon.products_global.discover_by_seller", "amazon-products-global-discover-by-seller.json"],
] as const;

function document(fileName: string): Readonly<Record<string, unknown>> {
  return JSON.parse(readFileSync(resolve(
    "tests/privileged/pattern7-live-qualification/inputs",
    fileName,
  ), "utf8")) as Readonly<Record<string, unknown>>;
}

describe("Pattern 7 reviewed live-input matrix", () => {
  it.each(cases)("contains no documentation placeholder in %s", (operationCode, fileName) => {
    expect(getAmazonOperationDefinition(operationCode)).toBeDefined();
    const evidence = JSON.stringify(document(fileName));
    expect(evidence).not.toMatch(/BrandName|12345678-ABCD-1234-EFGH-123456789012|<string>/i);
  });

  it.each(cases)("offline-validates %s before provider egress", (operationCode, fileName) => {
    const definition = getAmazonOperationDefinition(operationCode);
    expect(definition).toBeDefined();
    const serialized = serializeAmazonProviderRequest({
      operationCode,
      validatedInput: document(fileName),
      providerRequest: definition!.providerRequest,
    });
    expect(serialized.targets.length).toBeGreaterThanOrEqual(1);
    expect(serialized.targets.length).toBeLessThanOrEqual(15);
    expect(JSON.stringify(serialized)).not.toMatch(/dataset_id|snapshot_id|authorization/i);
  });

  it("accepts 20 targets at the public schema boundary and rejects 21", () => {
    const definition = getAmazonOperationDefinition("amazon.products.collect_by_url")!;
    const target = { url: "https://www.amazon.com/dp/B0CHHSFMRL" };
    expect(() => serializeAmazonProviderRequest({
      operationCode: definition.operationCode,
      validatedInput: { targets: Array.from({ length: 20 }, () => ({ ...target })) },
      providerRequest: definition.providerRequest,
    })).not.toThrow();
    expect(() => serializeAmazonProviderRequest({
      operationCode: definition.operationCode,
      validatedInput: { targets: Array.from({ length: 21 }, () => ({ ...target })) },
      providerRequest: definition.providerRequest,
    })).toThrow(AmazonOperationContractError);
  });

  it.each([
    ["missing targets", {}],
    ["empty targets", { targets: [] }],
    ["missing required field", { targets: [{ zipcode: "94107" }] }],
    ["unknown field", { targets: [{ url: "https://www.amazon.com/dp/B0CHHSFMRL", injected: true }] }],
    ["wrong optional type", { targets: [{ url: "https://www.amazon.com/dp/B0CHHSFMRL", all_variations: "true" }] }],
    ["non-Amazon URL", { targets: [{ url: "https://example.test/dp/B0CHHSFMRL" }] }],
    ["wrong URL role", { targets: [{ url: "https://www.amazon.com/s?k=mouse" }] }],
  ])("rejects %s locally without a billable request", (_name, validatedInput) => {
    const definition = getAmazonOperationDefinition("amazon.products.collect_by_url")!;
    expect(() => serializeAmazonProviderRequest({
      operationCode: definition.operationCode,
      validatedInput,
      providerRequest: definition.providerRequest,
    })).toThrow(AmazonOperationContractError);
  });
});
