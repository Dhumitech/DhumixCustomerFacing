import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../scripts/migrations/0061_linkedin_people_synthetic_preview.sql",
  import.meta.url,
);
const timestampAuthorityMigrationUrl = new URL(
  "../../scripts/migrations/0062_linkedin_people_sample_timestamp_authority.sql",
  import.meta.url,
);

describe("LinkedIn People synthetic preview migration 0061", () => {
  it("pins the observed schema, masking and no-execution release boundary", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain("9b3b7be895b1e063363e46e205c1f9e46864011e6ee76e666ac8a27e0d7a86eb");
    expect(sql).toContain("observation.byte_count = 32401");
    expect(sql).toContain("observation.field_count = 46");
    expect(sql).toContain("jsonb_array_length(p_field_dictionary) <> 42");
    expect(sql).toContain("'masked_field_count', 12");
    expect(sql).toContain("'contact_enrichment_enabled', false");
    expect(sql).toContain("'customer_execution_enabled', false");
    expect(sql).toContain("'provider_calls', 0");
    expect(sql).toContain("linkedin-people-sample-30d-v1");
    expect(sql).toContain("interval '720 hours'");
    expect(sql).toContain("template.current_public_version_id IS NULL");
    expect(sql).not.toMatch(/INSERT\s+INTO\s+app\.(?:services|runs|outbox_events|provider_mappings)/i);
    expect(sql).not.toMatch(/UPDATE\s+app\.service_templates/i);
    expect(sql).not.toMatch(/CREATE\s+(?:ROLE|USER)\b/i);
  });

  it("keeps the exact observation timestamp inside PostgreSQL", async () => {
    const sql = await readFile(timestampAuthorityMigrationUrl, "utf8");

    expect(sql).toContain("record_linkedin_people_synthetic_sample_v2");
    expect(sql).toContain("source.observed_at");
    expect(sql).toContain("source.observed_at + interval '720 hours'");
    expect(sql).toMatch(
      /REVOKE EXECUTE ON FUNCTION app\.record_linkedin_people_synthetic_sample_v1[\s\S]*FROM dhumi_operator/,
    );
    expect(sql).not.toMatch(
      /INSERT\s+INTO\s+app\.(?:services|runs|outbox_events|provider_mappings)/i,
    );
    expect(sql).not.toMatch(/CREATE\s+(?:ROLE|USER)\b/i);
  });
});
