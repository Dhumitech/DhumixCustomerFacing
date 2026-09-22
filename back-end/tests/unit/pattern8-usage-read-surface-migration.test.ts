import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../scripts/migrations/0038_usage_read_surface.sql",
  import.meta.url,
);
const cleanProofUrl = new URL(
  "../privileged/pattern8-usage-reads/Invoke-Pattern8UsageReadsCleanDatabaseProof.ps1",
  import.meta.url,
);
const proofSqlUrl = new URL(
  "../integration/0026_usage_read_surface.sql",
  import.meta.url,
);

describe("Pattern 8B usage read migration", () => {
  it("uses the existing customer role and restricted safe functions", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("CREATE FUNCTION app.get_usage_summary");
    expect(sql).toContain("CREATE FUNCTION app.list_usage_events");
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("app.require_tenant_context()");
    expect(sql).toContain("TO dhumi_customer_api");
    expect(sql).not.toMatch(/CREATE\s+(?:LOGIN|ROLE|USER)\b/i);
  });

  it("removes direct event access and never projects provider evidence", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain(
      "REVOKE SELECT ON app.usage_events FROM dhumi_customer_api",
    );
    expect(sql).toContain("definition.product_family");
    expect(sql).not.toMatch(/SELECT[\s\S]*provider_reference_fingerprint/i);
    expect(sql).not.toMatch(/SELECT[\s\S]*evidence_reference/i);
  });

  it("uses half-open observed-time bounds and stable keyset ordering", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("usage.observed_at >= p_from");
    expect(sql).toContain("usage.observed_at < p_to");
    expect(sql).toContain(
      "(usage.observed_at, usage.id) < (p_before_observed_at, p_before_id)",
    );
    expect(sql).toContain("ORDER BY usage.observed_at DESC, usage.id DESC");
    expect(sql).toContain("usage_events_by_tenant_observed_id_idx");
  });

  it("summarizes only the currently implemented Artifact observations", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("usage.source = 'artifact'");
    expect(sql).toContain("usage.outcome = 'succeeded'");
    expect(sql).toContain("'observed'::text");
    expect(sql).not.toMatch(/billing|credit|quota|invoice|cost/i);
  });

  it("ships a provider-free clean replay and rollback-only database proof", async () => {
    const cleanProof = await readFile(cleanProofUrl, "utf8");
    const proofSql = await readFile(proofSqlUrl, "utf8");
    expect(cleanProof).toContain("postgres:18");
    expect(cleanProof).toContain("0038_usage_read_surface");
    expect(proofSql).toContain("ROLLBACK;");
    expect(proofSql).toContain("direct table read must be denied");
    expect(proofSql).toContain("microsecond keyset cursor");
    expect(cleanProof).not.toContain("BRIGHTDATA_API_KEY");
    expect(proofSql).not.toContain("BRIGHTDATA_API_KEY");
  });
});
