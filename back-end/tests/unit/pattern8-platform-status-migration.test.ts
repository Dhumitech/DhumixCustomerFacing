import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../scripts/migrations/0039_platform_status_projection.sql",
  import.meta.url,
);
const proofSqlUrl = new URL(
  "../integration/0027_platform_status_projection.sql",
  import.meta.url,
);

describe("Pattern 8 Priority 3 platform-status migration", () => {
  it("uses the existing customer capability and a restricted global function", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("CREATE FUNCTION app.get_platform_status");
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("TO dhumi_customer_api");
    expect(sql).not.toMatch(/CREATE\s+(?:LOGIN|ROLE|USER)\b/i);
    expect(sql).not.toContain("app.require_tenant_context()");
  });

  it("derives release availability without probing provider or infrastructure", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("app.feature_flags");
    expect(sql).toContain("app.service_templates");
    expect(sql).toContain("app.service_template_versions");
    expect(sql).toContain("app.provider_mappings");
    expect(sql).toContain("app.provider_credentials");
    expect(sql).toContain("app.launch_evidence");
    expect(sql).not.toMatch(/https?:\/\/|BRIGHTDATA_API_KEY|service_bus|redis|azurite/i);
  });

  it("ships a rollback-only isolation and state-mapping proof", async () => {
    const proof = await readFile(proofSqlUrl, "utf8");
    expect(proof).toContain("ROLLBACK;");
    expect(proof).toContain("scraper_library");
    expect(proof).toContain("marketplace_dataset");
    expect(proof).toContain("not_enabled");
    expect(proof).toContain("degraded");
    expect(proof).toContain("direct private table read must be denied");
    expect(proof).not.toContain("BRIGHTDATA_API_KEY");
  });
});
