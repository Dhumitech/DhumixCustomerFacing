import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve("scripts/migrations/0031_provider_execution_boundary.sql"),
  "utf8",
);
const databaseProof = readFileSync(
  resolve("tests/integration/0022_provider_execution_boundary.sql"),
  "utf8",
);

describe("Pattern 5 provider execution migration", () => {
  it("uses narrow fenced functions and the existing Job Manager role", () => {
    expect(migration).toContain("app.resolve_provider_execution_plan");
    expect(migration).toContain("app.record_provider_reference_fenced");
    expect(migration).toContain("attempt.fence_token = p_fence_token");
    expect(migration).toContain("attempt.worker_lease_expires_at > clock_timestamp()");
    expect(migration).toContain("TO dhumi_job_manager");
    expect(migration).toContain(
      "REVOKE SELECT ON app.provider_credentials FROM dhumi_job_manager",
    );
  });

  it("does not create or grant a new database identity", () => {
    expect(migration).not.toMatch(/CREATE\s+ROLE/i);
    expect(migration).not.toMatch(/CREATE\s+USER/i);
    expect(migration).not.toMatch(/_integration_boundary_login/i);
    expect(migration).not.toMatch(/_bright_data_login/i);
  });

  it("keeps provider references private and supports fenced reconciliation", () => {
    expect(migration).toContain("provider_resource_ciphertext");
    expect(migration).toContain("provider_reference_ciphertext");
    expect(migration).toContain("app.resolve_provider_reconciliation_plan");
    expect(migration).toContain("app.is_run_cancellation_requested_fenced");
    expect(migration).toContain("event.event_type = 'cancellation_requested'");
    expect(migration).not.toContain("event.event_type = 'cancel_requested'");
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("SET search_path = pg_catalog, app, pg_temp");
  });

  it("has a rollback-only real-role proof with no provider call or identity DDL", () => {
    expect(databaseProof).toContain("SET LOCAL ROLE dhumi_job_manager");
    expect(databaseProof).toContain("has_table_privilege");
    expect(databaseProof).toContain("ROLLBACK;");
    expect(databaseProof).not.toMatch(/CREATE\s+(?:ROLE|USER)/i);
    expect(databaseProof).not.toContain("api.brightdata.com");
    expect(databaseProof).not.toMatch(/\bgd_[a-z0-9]{8,}\b/i);
    expect(databaseProof).not.toMatch(/\bs_[a-z0-9]{8,}\b/i);
  });
});
