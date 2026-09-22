import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  AmazonResultContractUnavailableError,
  AmazonResultNormalizationError,
  inspectAmazonProviderResult,
  normalizeAmazonProviderResult,
} from "../../src/services/brightdata/amazon/amazonResultNormalizer.js";

describe("Pattern 8 Priority 4 Amazon result normalizers", () => {
  it("projects a minimized product contract and removes input/unknown fields", async () => {
    const source = [{
      asin: "B0CRMZHDG8",
      title: "Insulated tumbler",
      url: "https://www.amazon.com/dp/B0CRMZHDG8",
      domain: "amazon.com",
      currency: "USD",
      final_price: 45,
      initial_price: 50,
      rating: 4.7,
      reviews_count: 1200,
      availability: "In Stock",
      brand: "Example",
      image_url: "https://m.media-amazon.com/images/I/example.jpg",
      timestamp: "2026-08-30T08:56:31.000Z",
      input: { url: "https://www.amazon.com/dp/B0CRMZHDG8", zipcode: "94107" },
      provider_only_nested_field: { must_not_be_public: true },
    }];
    const result = await normalizeAmazonProviderResult({
      operationCode: "amazon.products.collect_by_url",
      bytes: Readable.from([JSON.stringify(source)]),
      contentType: "text/plain",
      contentEncoding: null,
      maxBytes: 4096,
    });
    expect(result.contentType).toBe("application/json");
    expect(result.contentEncoding).toBeNull();
    expect(result.schemaVersion).toBe("amazon.products.collect-by-url.output.v1");
    expect(result.recordCount).toBe(1);
    expect(JSON.parse(result.bytes.toString("utf8"))).toEqual([{
      asin: "B0CRMZHDG8",
      title: "Insulated tumbler",
      url: "https://www.amazon.com/dp/B0CRMZHDG8",
      domain: "amazon.com",
      currency: "USD",
      final_price: 45,
      initial_price: 50,
      rating: 4.7,
      reviews_count: 1200,
      availability: "In Stock",
      brand: "Example",
      image_url: "https://m.media-amazon.com/images/I/example.jpg",
      timestamp: "2026-08-30T08:56:31.000Z",
    }]);
  });

  it("uses a distinct search contract with the observed nullable fields", async () => {
    const source = [{
      asin: null,
      name: "Sponsored search result",
      url: "https://www.amazon.com/dp/B000000000",
      domain: "amazon.com",
      currency: "USD",
      final_price: 10,
      initial_price: 12,
      rating: 4.2,
      num_ratings: 100,
      brand: null,
      image: "https://m.media-amazon.com/images/I/search.jpg",
      page_number: 1,
      rank_on_page: 1,
      bought_past_month: 50,
      sold: 0,
      sponsored: "true",
      sponsored_video: null,
      total_results: 500,
      timestamp: "2026-08-30T08:48:01.000Z",
      input: { keyword: "private customer query" },
    }];
    const result = await normalizeAmazonProviderResult({
      operationCode: "amazon.products_search.collect_by_url",
      bytes: Readable.from([JSON.stringify(source)]),
      contentType: "application/json",
      contentEncoding: null,
      maxBytes: 4096,
    });
    expect(result.schemaVersion).toBe("amazon.products-search.collect-by-url.output.v1");
    expect(JSON.parse(result.bytes.toString("utf8"))[0]).not.toHaveProperty("input");
    expect(JSON.parse(result.bytes.toString("utf8"))[0]).toMatchObject({
      asin: null,
      brand: null,
      name: "Sponsored search result",
      rank_on_page: 1,
      sponsored: "true",
    });
  });

  it("accepts only the observed empty UPC result", async () => {
    const empty = await normalizeAmazonProviderResult({
      operationCode: "amazon.products.discover_by_upc",
      bytes: Readable.from(["[]"]),
      contentType: "application/json",
      contentEncoding: null,
      maxBytes: 4096,
    });
    expect(empty.recordCount).toBe(0);
    expect(empty.schemaVersion).toBe("amazon.products.discover-by-upc.output.empty-v1");

    await expect(normalizeAmazonProviderResult({
      operationCode: "amazon.products.discover_by_upc",
      bytes: Readable.from(['[{"asin":"B000000000"}]']),
      contentType: "application/json",
      contentEncoding: null,
      maxBytes: 4096,
    })).rejects.toBeInstanceOf(AmazonResultNormalizationError);
  });

  it("rejects provider error records instead of exposing them", async () => {
    await expect(normalizeAmazonProviderResult({
      operationCode: "amazon.products.collect_by_url",
      bytes: Readable.from([JSON.stringify([{
        error: "private provider diagnostic",
        error_code: "private_code",
        input: { url: "https://www.amazon.com/dp/missing" },
      }])]),
      contentType: "application/json",
      contentEncoding: null,
      maxBytes: 4096,
    })).rejects.toBeInstanceOf(AmazonResultNormalizationError);
  });

  it("keeps observation separate from precise customer normalization", async () => {
    const observation = await inspectAmazonProviderResult({
      bytes: Readable.from(['[{"reviewer_name":"observed only"}]']),
      contentType: "application/json",
      contentEncoding: null,
      maxBytes: 4096,
    });
    expect(observation).toEqual({ recordCount: 1, providerErrorCount: 0 });

    await expect(normalizeAmazonProviderResult({
      operationCode: "amazon.reviews.collect_by_url",
      bytes: Readable.from(['[{"reviewer_name":"not contract evidence"}]']),
      contentType: "application/json",
      contentEncoding: null,
      maxBytes: 4096,
    })).rejects.toBeInstanceOf(AmazonResultContractUnavailableError);
  });

  it.each([
    ["invalid JSON", "{"],
    ["object envelope", '{"items":[]}'],
    ["primitive record", "[1]"],
    ["null record", "[null]"],
    ["nested array record", "[[]]"],
  ])("rejects %s", async (_label, raw) => {
    await expect(
      normalizeAmazonProviderResult({
        operationCode: "amazon.products.collect_by_url",
        bytes: Readable.from([raw]),
        contentType: "application/json",
        contentEncoding: null,
        maxBytes: 4096,
      }),
    ).rejects.toBeInstanceOf(AmazonResultNormalizationError);
  });

  it("rejects unsupported media/encoding and bytes over the independent cap", async () => {
    await expect(
      normalizeAmazonProviderResult({
        operationCode: "amazon.products.collect_by_url",
        bytes: Readable.from(["[]"]),
        contentType: "text/html",
        contentEncoding: null,
        maxBytes: 4096,
      }),
    ).rejects.toBeInstanceOf(AmazonResultNormalizationError);
    await expect(
      normalizeAmazonProviderResult({
        operationCode: "amazon.products.collect_by_url",
        bytes: Readable.from(["[]"]),
        contentType: "application/json",
        contentEncoding: "gzip",
        maxBytes: 4096,
      }),
    ).rejects.toBeInstanceOf(AmazonResultNormalizationError);
    await expect(
      normalizeAmazonProviderResult({
        operationCode: "amazon.products.collect_by_url",
        bytes: Readable.from(['[{"large":"value"}]']),
        contentType: "application/json",
        contentEncoding: null,
        maxBytes: 4,
      }),
    ).rejects.toBeInstanceOf(AmazonResultNormalizationError);
  });
});
