import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../scripts/migrations/0042_provider_mapping_aad_lineage.sql",
  import.meta.url,
);

describe("Provider Mapping AAD lineage migration", () => {
  it("repairs copied release mappings without adding identities or public routes", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("provider_resource_aad_mapping_id");
    expect(sql).toContain("accepted_version.version = 2");
    expect(sql).toContain("release_version.version = 3");
    expect(sql).toContain("provider_mappings_resource_aad_mapping_fk");
    expect(sql).not.toMatch(/CREATE\s+(?:ROLE|LOGIN|USER)\b/i);
    expect(sql).not.toMatch(/\/v1\//i);
    expect(sql).not.toMatch(/api\.brightdata\.com/i);
  });

  it("moves the Job Manager to lineage-aware fail-closed plan functions", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("app.resolve_provider_execution_plan_v2");
    expect(sql).toContain("app.resolve_provider_reconciliation_plan_v2");
    expect(sql).toContain("FROM dhumi_job_manager");
    expect(sql).toContain("TO dhumi_job_manager");
    expect(sql).toContain("aad_mapping.provider_resource_ciphertext");
    expect(sql).toContain("aad_mapping.provider_resource_fingerprint");
  });

  it("inherits lineage on future immutable ciphertext copies", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("app.assign_provider_resource_aad_mapping_id");
    expect(sql).toContain("cardinality(inherited_lineages) = 1");
    expect(sql).toContain("PROVIDER_MAPPING_AAD_LINEAGE_AMBIGUOUS");
  });
});
