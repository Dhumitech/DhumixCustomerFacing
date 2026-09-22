import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../scripts/migrations/0056_marketplace_export_candidate.sql",
  import.meta.url,
);

describe("M10 Marketplace export candidate migration", () => {
  it("registers one immutable qualified mapping while preserving every customer gate", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain("1.0.0-m10-candidate");
    expect(sql).toContain("CREATE TABLE app.marketplace_export_candidates");
    expect(sql).toContain("CREATE FUNCTION app.resolve_marketplace_export_candidate_source");
    expect(sql).toContain("CREATE FUNCTION app.register_marketplace_export_candidate_v1");
    expect(sql).toContain("INSERT INTO app.provider_mappings");
    expect(sql).toContain("'disabled'");
    expect(sql).toMatch(/["']provider_http_enabled["']\s*[:,]\s*false/);
    expect(sql).toMatch(/["']customer_execution_enabled["']\s*[:,]\s*false/);
    expect(sql).toContain("packet.execution_state = 'succeeded'");
    expect(sql).toContain("packet.authorization_state = 'consumed'");
    expect(sql).toContain("packet.provider_submission_count = 1");
    expect(sql).toContain("packet.automatic_submission_retries = 0");
    expect(sql).toContain("packet.normalized_record_count = 5");
    expect(sql).toContain("packet.exact_request =");
    expect(sql).toContain("2e1560c3-ca8b-40a0-b578-c9e71ecf27cd");
    expect(sql).toContain("f8041530994ed911795f56aa605fde3d11000b8da3c7c587e41cb7da67155e1f");
    expect(sql).toContain("d5a9c6c3403959349925d0574195e12e511ab2e861d421938e53b4a6738f6c95");
    expect(sql).toContain("7e0f8497a7e02933b2c395a42b2215477f7aae4803762b30bda5e9d3f09bd170");
    expect(sql).toContain("provider_resource_aad_mapping_id");
    expect(sql).toContain("MARKETPLACE_EXPORT_CANDIDATE_REPLAY_CONFLICT");

    expect(sql).not.toMatch(/CREATE\s+(?:LOGIN|ROLE|USER)\b/i);
    expect(sql).not.toMatch(/GRANT[^;]+TO\s+dhumi_customer_api/i);
    expect(sql).not.toMatch(/UPDATE\s+app\.service_templates/i);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+app\.(?:services|runs|outbox_events|run_attempts)/i);
    expect(sql).not.toMatch(/\bstate\s*=\s*'enabled'|,\s*'enabled'\s*\)/i);
  });
});
