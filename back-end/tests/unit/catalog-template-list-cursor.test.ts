import { describe, expect, it } from "vitest";
import {
  decodeCatalogTemplateListCursor,
  encodeCatalogTemplateListCursor,
} from "../../src/helpers/catalogTemplateListCursor.js";

const position = {
  familyFilter: null,
  family: "marketplace_dataset",
  slug: "amazon-products",
  id: "55555555-5555-4555-8555-555555555555",
} as const;

describe("catalogue Template list cursor", () => {
  it("round-trips the canonical versioned and filter-bound position", () => {
    const cursor = encodeCatalogTemplateListCursor(position);

    expect(cursor).toBe(
      Buffer.from(
        JSON.stringify({
          version: 1,
          kind: "catalog_templates",
          family_filter: null,
          family: "marketplace_dataset",
          slug: "amazon-products",
          id: "55555555-5555-4555-8555-555555555555",
        }),
        "utf8",
      ).toString("base64url"),
    );
    expect(decodeCatalogTemplateListCursor(cursor)).toEqual(position);
  });

  it("preserves an explicit family filter in the cursor", () => {
    const filtered = { ...position, familyFilter: "marketplace_dataset" } as const;
    expect(decodeCatalogTemplateListCursor(encodeCatalogTemplateListCursor(filtered))).toEqual(
      filtered,
    );
  });

  it("rejects malformed, non-canonical, operation-mismatched, and oversized cursors", () => {
    const encoded = (value: unknown) =>
      Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    const canonicalPayload = {
      version: 1,
      kind: "catalog_templates",
      family_filter: null,
      family: "marketplace_dataset",
      slug: "amazon-products",
      id: "55555555-5555-4555-8555-555555555555",
    };
    const invalid = [
      "",
      "not+base64url",
      `${encoded(canonicalPayload)}=`,
      "A".repeat(2049),
      Buffer.from([0xff]).toString("base64url"),
      encoded(null),
      encoded({ ...canonicalPayload, version: 2 }),
      encoded({ ...canonicalPayload, kind: "api_keys" }),
      encoded({ ...canonicalPayload, family_filter: "unknown" }),
      encoded({
        ...canonicalPayload,
        family_filter: "marketplace_dataset",
        family: "scraper_library",
      }),
      encoded({ ...canonicalPayload, family: "unknown" }),
      encoded({ ...canonicalPayload, slug: "Bad Slug" }),
      encoded({ ...canonicalPayload, id: "not-a-uuid" }),
      encoded({ ...canonicalPayload, provider_id: "forbidden" }),
      encoded({
        kind: "catalog_templates",
        version: 1,
        family_filter: null,
        family: "marketplace_dataset",
        slug: "amazon-products",
        id: "55555555-5555-4555-8555-555555555555",
      }),
    ];

    for (const cursor of invalid) {
      expect(() => decodeCatalogTemplateListCursor(cursor)).toThrow(TypeError);
    }
  });

  it("rejects invalid positions before encoding", () => {
    expect(() =>
      encodeCatalogTemplateListCursor({ ...position, slug: "invalid slug" }),
    ).toThrow(TypeError);
  });
});
