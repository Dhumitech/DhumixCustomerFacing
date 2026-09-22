import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../scripts/migrations/0037_usage_finalization.sql",
  import.meta.url,
);
const activationScriptUrl = new URL(
  "../privileged/pattern8-usage-finalization/Apply-Pattern8UsageFinalizationMigration.ps1",
  import.meta.url,
);
const realDatabaseProofUrl = new URL(
  "../privileged/pattern8-usage-finalization/Invoke-Pattern8RealDatabaseProof.ps1",
  import.meta.url,
);

describe("Pattern 8A usage finalization migration", () => {
  it("binds usage to validated normalized Artifact metadata", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("ADD COLUMN record_count bigint");
    expect(sql).toContain("kind = 'normalized'");
    expect(sql).toContain("state = 'validated'");
    expect(sql).toContain("quantity");
    expect(sql).toContain("normalized_artifact.record_count");
    expect(sql).toContain("'artifact:' || normalized_artifact.id::text");
    expect(sql).toContain("DROP POLICY artifacts_tenant_isolation");
    expect(sql).toContain("DROP POLICY usage_events_tenant_isolation");
    expect(sql).toContain("dhumi_owner");
  });

  it("enforces one successful Artifact observation per Attempt and meter", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("usage_events_successful_artifact_attempt_meter_uidx");
    expect(sql).toContain("ON app.usage_events (tenant_id, attempt_id, meter_code)");
    expect(sql).toContain("source = 'artifact'");
    expect(sql).toContain("outcome = 'succeeded'");
    expect(sql).toContain("USAGE_FINALIZATION_CONFLICT");
  });

  it("makes normal and reconciled success atomic under the existing Job Manager", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("CREATE FUNCTION app.complete_run_execution_with_usage");
    expect(sql).toContain("CREATE FUNCTION app.complete_run_reconciliation_with_usage");
    expect(sql).toContain("app.transition_run_fenced");
    expect(sql).toContain("app.finish_run_attempt_claim");
    expect(sql).toContain("app.complete_run_reconciliation");
    expect(sql).toContain("TO dhumi_job_manager");
    expect(sql).not.toMatch(/CREATE\s+(?:LOGIN|ROLE|USER)\b/i);
  });

  it("activates the forward-only migration without creating an identity or calling a provider", async () => {
    const script = await readFile(activationScriptUrl, "utf8");
    expect(script).toContain(".\\scripts\\migrate.ps1");
    expect(script).toContain("0037_usage_finalization");
    expect(script).toContain("Read-Host");
    expect(script).not.toMatch(/CREATE\s+(?:LOGIN|ROLE|USER)\b/i);
    expect(script).not.toContain("BRIGHTDATA_API_KEY");
  });

  it("keeps the real-database proof rollback-only and provider-free", async () => {
    const script = await readFile(realDatabaseProofUrl, "utf8");
    expect(script).toContain("0037_usage_finalization");
    expect(script).toContain("0025_usage_finalization.sql");
    expect(script).toContain("Read-Host");
    expect(script).not.toMatch(/CREATE\s+(?:LOGIN|ROLE|USER)\b/i);
    expect(script).not.toContain("BRIGHTDATA_API_KEY");
  });
});
