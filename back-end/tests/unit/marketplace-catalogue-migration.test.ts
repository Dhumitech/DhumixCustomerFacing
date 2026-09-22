import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../scripts/migrations/0045_marketplace_catalogue_import.sql",
  import.meta.url,
);

describe("Marketplace catalogue migration 0045", () => {
  it("creates only the private review-first M2 boundary", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain("bright_data.marketplace.catalogue");
    expect(sql).toContain("1.0.0-m2");
    expect(sql).toContain("app.begin_marketplace_catalog_import");
    expect(sql).toContain("app.complete_marketplace_catalog_import");
    expect(sql).toContain("app.fail_marketplace_catalog_import");
    expect(sql).toContain("app.review_marketplace_catalog_candidate");
    expect(sql).toContain("catalog_import_candidate_observations");
    expect(sql).toContain("linkedin.posts");
    expect(sql).toContain("linkedin.people.standard");

    expect(sql).toMatch(/decode\('[0-9a-f]{64}'\s*,\s*'hex'\)\s*,\s*'disabled'/i);
    expect(sql).toMatch(/'coming_soon'/i);
    expect(sql).toMatch(/current_public_version_id\s+IS\s+NULL/i);
    expect(sql).not.toMatch(/CREATE\s+(?:ROLE|USER)\b/i);
    expect(sql).not.toMatch(/\bLOGIN\b/i);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+app\.provider_mappings/i);
    expect(sql).not.toMatch(/state\s*,\s*'published'/i);
    expect(sql).not.toMatch(/availability_state\s*,\s*'available'/i);
    expect(sql).not.toMatch(/GRANT\s+.+\s+TO\s+dhumi_customer_api/is);
  });
});
