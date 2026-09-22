import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../scripts/migrations/0065_marketplace_fixture_current_schema.sql",
  import.meta.url,
);

describe("Marketplace fixture current-schema migration 0065", () => {
  it("restores the private M3 recorder without a global schema default or public execution", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain("CREATE OR REPLACE FUNCTION app.record_marketplace_fixture_sample(");
    expect(sql).toContain("fixture_field_dictionary CONSTANT jsonb");
    expect(sql).toContain("c210bf596129141cee74e7d4b339fc70b12fd4117201c693116073bcdde7d3a4");
    expect(sql).toContain("'synthetic_fixture'");
    expect(sql).toContain("existing_sample.field_dictionary = fixture_field_dictionary");
    expect(sql).toContain("existing_sample.governance_state = 'synthetic_fixture'");
    expect(sql).toContain("existing_sample.qualification_packet_id IS NULL");
    expect(sql).toContain("existing_sample.interim_decision_reference IS NULL");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION app.record_marketplace_fixture_sample(");
    expect(sql).toContain("TO dhumi_operator");
    expect(sql).not.toMatch(/ALTER TABLE app\.marketplace_sample_versions/i);
    expect(sql).not.toMatch(/TO dhumi_customer_api/i);
    expect(sql).not.toMatch(/INSERT INTO app\.(?:runs|outbox_events|provider_mappings)/i);
  });
});
