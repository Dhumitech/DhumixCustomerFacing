import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../scripts/migrations/0058_marketplace_provider_sample_timestamp_authority.sql",
  import.meta.url,
);

describe("Marketplace provider sample timestamp authority migration 0058", () => {
  it("derives exact retention timestamps in PostgreSQL and narrows operator grants", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain("CREATE FUNCTION app.record_marketplace_provider_sample_v2");
    expect(sql).toContain("source.completed_at + interval '720 hours'");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION app.record_marketplace_provider_sample_v1");
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION app\.record_marketplace_provider_sample_v2[\s\S]+TO dhumi_operator;/,
    );
    expect(sql).not.toMatch(
      /GRANT[^;]+record_marketplace_provider_sample_v2[^;]+dhumi_customer_api/is,
    );
    expect(sql).not.toMatch(/INSERT\s+INTO\s+app\.(?:services|runs|outbox_events)/i);
    expect(sql).not.toMatch(/\b(?:fetch|curl|Invoke-RestMethod)\b/i);
  });
});
