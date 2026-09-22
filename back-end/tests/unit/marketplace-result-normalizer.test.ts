import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createMarketplaceNormalizedOutputContract,
  MarketplaceOutputContractError,
  MarketplaceResultNormalizationError,
  normalizeMarketplaceProviderResult,
} from "../../src/services/brightdata/marketplace/marketplaceResultNormalizer.js";

const contract = createMarketplaceNormalizedOutputContract({
  templateSlug: "linkedin-posts",
  templateVersion: 2,
  normalizerCode: "marketplace.linkedin-posts.selected-fields",
  normalizerVersion: 1,
  schemaVersion: "marketplace.linkedin-posts.output.v1",
  fieldSchemas: {
    url: { type: "string", format: "uri" },
    text: { type: ["string", "null"] },
    posted_at: { type: ["string", "null"] },
  },
});

describe("DM-008 Marketplace normalized field projection", () => {
  it("emits exactly the ordered selected fields and excludes provider-only fields", async () => {
    const providerRecords = [{
      url: "https://www.linkedin.com/posts/example-001",
      text: "Reviewed post text",
      posted_at: "2026-09-12T08:00:00.000Z",
      provider_only: { private: true },
    }];
    const rawJson = JSON.stringify(providerRecords);
    const result = await normalizeMarketplaceProviderResult({
      contract,
      selectedFields: ["posted_at", "url"],
      bytes: Readable.from([rawJson]),
      contentType: "application/json",
      contentEncoding: null,
      maxBytes: 4096,
    });

    expect(result.schemaVersion).toBe("marketplace.linkedin-posts.output.v1");
    expect(result.selectedFields).toEqual(["posted_at", "url"]);
    expect(result.projectionFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.recordCount).toBe(1);
    expect(result.bytes.toString("utf8")).toBe(
      '[{"posted_at":"2026-09-12T08:00:00.000Z","url":"https://www.linkedin.com/posts/example-001"}]',
    );
    expect(rawJson).toContain("provider_only");
  });

  it("uses null for a missing selected value only when the pinned field schema permits it", async () => {
    const result = await normalizeMarketplaceProviderResult({
      contract,
      selectedFields: ["url", "text"],
      bytes: Readable.from(['{"url":"https://www.linkedin.com/posts/example-002"}']),
      contentType: "application/json",
      contentEncoding: null,
      maxBytes: 4096,
    });

    expect(JSON.parse(result.bytes.toString("utf8"))).toEqual([{
      url: "https://www.linkedin.com/posts/example-002",
      text: null,
    }]);

    await expect(normalizeMarketplaceProviderResult({
      contract,
      selectedFields: ["url"],
      bytes: Readable.from(["{}"]),
      contentType: "application/json",
      contentEncoding: null,
      maxBytes: 4096,
    })).rejects.toBeInstanceOf(MarketplaceResultNormalizationError);
  });

  it("accepts the documented single-object JSON snapshot shape and canonicalizes it to an array", async () => {
    const result = await normalizeMarketplaceProviderResult({
      contract,
      selectedFields: ["url"],
      bytes: Readable.from(['{"url":"https://www.linkedin.com/posts/example-003"}']),
      contentType: "application/json",
      contentEncoding: null,
      maxBytes: 4096,
    });

    expect(JSON.parse(result.bytes.toString("utf8"))).toEqual([{
      url: "https://www.linkedin.com/posts/example-003",
    }]);
  });

  it.each([
    ["empty", []],
    ["duplicated", ["url", "url"]],
    ["unreviewed", ["provider_only"]],
  ])("rejects a %s selected-field contract before normalization", async (_case, fields) => {
    await expect(normalizeMarketplaceProviderResult({
      contract,
      selectedFields: fields,
      bytes: Readable.from(["[]"]),
      contentType: "application/json",
      contentEncoding: null,
      maxBytes: 4096,
    })).rejects.toBeInstanceOf(MarketplaceOutputContractError);
  });

  it("rejects invalid JSON, wrong media/encoding, oversize input and schema-invalid values", async () => {
    const common = {
      contract,
      selectedFields: ["url"],
      contentType: "application/json",
      contentEncoding: null,
      maxBytes: 4096,
    } as const;

    await expect(normalizeMarketplaceProviderResult({
      ...common,
      bytes: Readable.from(["{"]),
    })).rejects.toBeInstanceOf(MarketplaceResultNormalizationError);
    await expect(normalizeMarketplaceProviderResult({
      ...common,
      bytes: Readable.from(["[]"]),
      contentType: "text/plain",
    })).rejects.toBeInstanceOf(MarketplaceResultNormalizationError);
    await expect(normalizeMarketplaceProviderResult({
      ...common,
      bytes: Readable.from(["[]"]),
      contentEncoding: "gzip",
    })).rejects.toBeInstanceOf(MarketplaceResultNormalizationError);
    await expect(normalizeMarketplaceProviderResult({
      ...common,
      bytes: Readable.from(["[]"]),
      maxBytes: 1,
    })).rejects.toBeInstanceOf(MarketplaceResultNormalizationError);
    await expect(normalizeMarketplaceProviderResult({
      ...common,
      bytes: Readable.from(['{"url":"not-a-url"}']),
    })).rejects.toBeInstanceOf(MarketplaceResultNormalizationError);
  });

  it("rejects an invalid immutable output contract", () => {
    expect(() => createMarketplaceNormalizedOutputContract({
      ...contract,
      schemaVersion: " changed-in-place ",
    })).toThrow(MarketplaceOutputContractError);
    expect(() => createMarketplaceNormalizedOutputContract({
      ...contract,
      fieldSchemas: { broken: { type: "not-a-json-schema-type" } },
    })).toThrow(MarketplaceOutputContractError);
  });
});
