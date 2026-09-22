import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../scripts/migrations/0047_marketplace_sample_retention_policy.sql",
  import.meta.url,
);

describe("Marketplace sample retention migration 0047", () => {
  it("enforces the accepted 30-day policy and fails closed on existing drift", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain("linkedin-posts-sample-30d-v1");
    expect(sql).toContain("expires_at = collected_at + interval '30 days'");
    expect(sql).toContain("Existing Marketplace samples do not satisfy");
    expect(sql).not.toMatch(/CREATE\s+(?:USER|ROLE)/i);
  });
});
