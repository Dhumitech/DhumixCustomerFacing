import { describe, expect, it } from "vitest";
import {
  MarketplaceFilterContractError,
  serializeMarketplaceFilterRequest,
} from "../../src/services/brightdata/marketplace/marketplaceFilterRequest.js";

const reviewedFields = {
  url: { types: ["string"], format: "uri" },
  text: { types: ["string"] },
  posted_at: { types: ["string"], format: "date-time" },
  reactions: { types: ["integer"] },
  hashtags: { types: ["array"] },
  author: { types: ["object"] },
} as const;

describe("M7 Marketplace Filter request serializer", () => {
  it("emits only the documented JSON-mode properties", () => {
    const request = serializeMarketplaceFilterRequest({
      datasetId: "gd_lyy3tktm25m4avu764",
      recordsLimit: 100,
      maximumRecords: 1000,
      filter: {
        operator: "and",
        filters: [
          { name: "text", operator: "includes", value: "data" },
          { name: "posted_at", operator: ">=", value: "2026-01-01T00:00:00Z" },
        ],
      },
      reviewedFields,
    });

    expect(request).toEqual({
      dataset_id: "gd_lyy3tktm25m4avu764",
      records_limit: 100,
      filter: {
        operator: "and",
        filters: [
          { name: "text", operator: "includes", value: "data" },
          { name: "posted_at", operator: ">=", value: "2026-01-01T00:00:00Z" },
        ],
      },
    });
    expect(Object.keys(request)).toEqual(["dataset_id", "records_limit", "filter"]);
  });

  it("treats the provider Dataset ID as an opaque bounded string", () => {
    expect(serializeMarketplaceFilterRequest({
      datasetId: "provider-dataset.v2",
      recordsLimit: 1,
      maximumRecords: 1,
      filter: { name: "url", operator: "is_not_null" },
      reviewedFields,
    }).dataset_id).toBe("provider-dataset.v2");
  });

  it("accepts the documented null, list, array and nested-object filter forms", () => {
    expect(() => serializeMarketplaceFilterRequest({
      datasetId: "gd_lyy3tktm25m4avu764",
      recordsLimit: 10,
      maximumRecords: 10,
      filter: {
        operator: "and",
        combine_nested_fields: true,
        filters: [
          { name: "url", operator: "is_not_null" },
          { name: "reactions", operator: "in", value: [1, 2] },
          { name: "hashtags", operator: "array_includes", value: "data" },
          { name: "author", operator: "=", value: { id: "author-1" } },
        ],
      },
      reviewedFields,
    })).not.toThrow();
  });

  it.each([
    ["unknown field", { name: "private_field", operator: "=", value: "x" }],
    ["unsupported operator", { name: "text", operator: "regex", value: ".*" }],
    ["comparison on text", { name: "text", operator: ">", value: "x" }],
    ["array operator on text", { name: "text", operator: "array_includes", value: "x" }],
    ["file-like list value", { name: "url", operator: "in", value: "values.csv" }],
    ["direct null value", { name: "text", operator: "=", value: null }],
    ["object inside an array value", { name: "reactions", operator: "in", value: [{ id: 1 }] }],
    ["nested array value", { name: "reactions", operator: "in", value: [[1]] }],
    ["null inside an array value", { name: "reactions", operator: "in", value: [null] }],
    ["value on null check", { name: "url", operator: "is_null", value: null }],
    ["undocumented property", { name: "url", operator: "=", value: "x", files: [] }],
  ])("rejects %s before provider egress", (_name, filter) => {
    expect(() => serializeMarketplaceFilterRequest({
      datasetId: "gd_lyy3tktm25m4avu764",
      recordsLimit: 10,
      maximumRecords: 10,
      filter,
      reviewedFields,
    })).toThrow(MarketplaceFilterContractError);
  });

  it("enforces the documented three-level nesting ceiling", () => {
    expect(() => serializeMarketplaceFilterRequest({
      datasetId: "gd_lyy3tktm25m4avu764",
      recordsLimit: 10,
      maximumRecords: 10,
      filter: {
        operator: "and",
        filters: [{
          operator: "or",
          filters: [{
            operator: "and",
            filters: [{ name: "url", operator: "=", value: "https://example.com" }],
          }],
        }],
      },
      reviewedFields,
    })).not.toThrow();

    expect(() => serializeMarketplaceFilterRequest({
      datasetId: "gd_lyy3tktm25m4avu764",
      recordsLimit: 10,
      maximumRecords: 10,
      filter: {
        operator: "and",
        filters: [{
          operator: "or",
          filters: [{
            operator: "and",
            filters: [{
              operator: "or",
              filters: [{ name: "url", operator: "=", value: "https://example.com" }],
            }],
          }],
        }],
      },
      reviewedFields,
    })).toThrow(MarketplaceFilterContractError);
  });

  it("enforces the mapping-owned record ceiling", () => {
    expect(() => serializeMarketplaceFilterRequest({
      datasetId: "gd_lyy3tktm25m4avu764",
      recordsLimit: 1001,
      maximumRecords: 1000,
      filter: { name: "url", operator: "is_not_null" },
      reviewedFields,
    })).toThrow(MarketplaceFilterContractError);
  });
});
