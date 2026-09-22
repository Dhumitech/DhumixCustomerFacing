import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../scripts/migrations/0048_marketplace_sample_fixture_lifecycle.sql",
  import.meta.url,
);

describe("Marketplace sample fixture lifecycle migration 0048", () => {
  it("adds private expiry resolution and immutable deletion evidence without publication", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain("app.marketplace_sample_deletions");
    expect(sql).toContain("app.resolve_marketplace_fixture_sample");
    expect(sql).toContain("app.list_expired_marketplace_fixture_samples");
    expect(sql).toContain("app.record_marketplace_fixture_deletion");
    expect(sql).toContain("app.reject_version_mutation()");
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("interval '720 hours'");
    expect(sql).not.toMatch(/CREATE\s+(?:ROLE|USER)\b/i);
    expect(sql).not.toMatch(/GRANT\s+.+\s+TO\s+dhumi_customer_api/is);
    expect(sql).not.toMatch(/availability_state\s*=\s*'available'/i);
    expect(sql).not.toMatch(/current_public_version_id\s*=/i);
  });
});
