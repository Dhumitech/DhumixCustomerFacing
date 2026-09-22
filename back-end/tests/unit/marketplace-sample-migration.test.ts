import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../scripts/migrations/0046_marketplace_sample_ingestion.sql",
  import.meta.url,
);

describe("Marketplace sample ingestion migration 0046", () => {
  it("creates only an immutable, private, fixture-only M3 boundary", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain("app.marketplace_sample_versions");
    expect(sql).toContain("app.resolve_marketplace_sample_ingestion_target");
    expect(sql).toContain("app.record_marketplace_fixture_sample");
    expect(sql).toContain("synthetic_fixture");
    expect(sql).toContain("validated_fixture");
    expect(sql).toContain("rights_evidence_reference IS NULL");
    expect(sql).toContain("published_at IS NULL");
    expect(sql).toContain("app.reject_version_mutation()");
    expect(sql).not.toMatch(/CREATE\s+(?:ROLE|USER)\b/i);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+app\.provider_mappings/i);
    expect(sql).not.toMatch(/GRANT\s+.+\s+TO\s+dhumi_customer_api/is);
    expect(sql).not.toMatch(/availability_state\s*=\s*'available'/i);
    expect(sql).not.toMatch(/current_public_version_id\s*=/i);
  });
});
