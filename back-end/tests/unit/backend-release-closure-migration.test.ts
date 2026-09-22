import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../scripts/migrations/0041_amazon_controlled_publication.sql",
  import.meta.url,
);

describe("Backend Release Closure migration", () => {
  it("adds one atomic operator-only publication function without an identity or public route", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("CREATE FUNCTION app.publish_qualified_amazon_operation_v1");
    expect(sql).toContain("TO dhumi_operator");
    expect(sql).toContain("'provider.operation.publish'");
    expect(sql).toContain("SET search_path = pg_catalog, app");
    expect(sql).not.toContain("SET search_path = pg_catalog, app, pg_temp");
    expect(sql).not.toMatch(/CREATE\s+(?:LOGIN|ROLE|USER)\b/i);
    expect(sql).not.toMatch(/\/v1\//i);
    expect(sql).not.toMatch(/api\.brightdata\.com/i);
  });

  it("requires accepted precise evidence and creates immutable release records atomically", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("attempt.review_state <> 'approved'");
    expect(sql).toMatch(/'output_contracts',\s*attempt\.operation_code/);
    expect(sql).toContain("UPDATE app.provider_credentials");
    expect(sql).toContain("INSERT INTO app.adapter_versions");
    expect(sql).toContain("INSERT INTO app.provider_mappings");
    expect(sql).toContain("INSERT INTO app.feature_flags");
    expect(sql).toContain("INSERT INTO app.service_template_versions");
    expect(sql).toContain("UPDATE app.service_templates");
    expect(sql).not.toContain("DISABLE TRIGGER");
  });

  it("keeps qualification records immutable and publishes a separate release version", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("'1.1.0-pattern8-release'");
    expect(sql).toContain("release_version_number constant integer := 3");
  });
});
