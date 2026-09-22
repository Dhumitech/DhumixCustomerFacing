import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve("scripts/migrations/0049_marketplace_sample_preview_read.sql"),
  "utf8",
);

describe("M4 Marketplace sample preview migration", () => {
  it("projects only the governed synthetic LinkedIn Posts sample", () => {
    expect(sql).toContain("CREATE FUNCTION app.resolve_marketplace_sample_preview");
    expect(sql).toContain("p_template_slug = 'linkedin-posts'");
    expect(sql).toContain("candidate.resource_code = 'linkedin.posts'");
    expect(sql).toContain("stored.source_kind = 'synthetic_fixture'");
    expect(sql).toContain("stored.expires_at > p_as_of");
    expect(sql).toContain("marketplace_sample_deletions");
    expect(sql).toContain("sample_visibility', 'masked'");
    expect(sql).not.toContain("linkedin.people");
  });

  it("grants only the safe resolver and creates no execution or download path", () => {
    expect(sql).toContain("TO dhumi_customer_api");
    expect(sql).not.toMatch(/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)/i);
    expect(sql).not.toMatch(/BRIGHTDATA_API_KEY|datasets\/filter|snapshot_id/i);
  });
});
