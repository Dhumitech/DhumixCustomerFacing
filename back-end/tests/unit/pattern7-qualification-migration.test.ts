import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../scripts/migrations/0033_amazon_live_qualification_foundation.sql",
  import.meta.url,
);

describe("Pattern 7 qualification migration", () => {
  it("adds an operator-only evidence state machine without roles, publication or enablement", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("CREATE TABLE app.provider_qualification_attempts");
    expect(sql).toContain("CREATE FUNCTION app.begin_amazon_scraper_catalog_import");
    expect(sql).toContain("CREATE FUNCTION app.accept_amazon_provider_qualification");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION");
    expect(sql).toContain("TO dhumi_operator");
    expect(sql).toContain("'disabled'");
    expect(sql).not.toMatch(/CREATE\s+(?:LOGIN|ROLE|USER)\b/i);
    expect(sql).not.toMatch(/UPDATE\s+app\.service_templates\s+SET\s+state\s*=\s*'published'/i);
    expect(sql).not.toMatch(/provider_mappings[\s\S]{0,1000}'enabled'/i);
  });

  it("does not grant direct table mutation to the operator", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE|ALL)[\s\S]*?TO\s+dhumi_operator/i);
    expect(sql).toContain("REVOKE ALL ON TABLE app.provider_qualification_attempts FROM PUBLIC");
  });
});
