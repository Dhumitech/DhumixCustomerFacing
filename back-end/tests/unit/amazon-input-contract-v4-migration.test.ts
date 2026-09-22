import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../scripts/migrations/0043_amazon_products_input_contract_v4.sql",
  import.meta.url,
);

describe("Amazon products input-contract v4 migration", () => {
  it("creates an operator-only, offline and forward-only v4 release boundary", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain(
      "CREATE FUNCTION app.publish_amazon_products_input_contract_v4",
    );
    expect(sql).toContain("TO dhumi_operator");
    expect(sql).toContain("release_version_number constant integer := 4");
    expect(sql).not.toMatch(/CREATE\s+(?:LOGIN|ROLE|USER)\b/i);
    expect(sql).not.toMatch(/api\.brightdata\.com/i);
    expect(sql).not.toMatch(/\/v1\//i);
  });

  it("strictly constrains the qualified optional fields and preserves the 1-20 boundary", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain('"maxItems": 20');
    expect(sql).toContain('"minItems": 1');
    expect(sql).toContain('"pattern": "^[0-9]{5}$"');
    expect(sql).toContain('"enum": ["EN"]');
    expect(sql).toContain('"additionalProperties": false');
  });

  it("copies the protected mapping lineage, advances only the public pointer and leaves pins untouched", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain("INSERT INTO app.service_template_versions");
    expect(sql).toContain("INSERT INTO app.provider_mappings");
    expect(sql).toContain("provider_resource_aad_mapping_id");
    expect(sql).toContain("current_public_version_id = release_template_version_id");
    expect(sql).not.toMatch(/UPDATE\s+app\.service_template_versions/i);
    expect(sql).not.toMatch(/UPDATE\s+app\.service_versions/i);
    expect(sql).not.toContain("DISABLE TRIGGER");
  });
});
