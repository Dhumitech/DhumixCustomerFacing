import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../scripts/migrations/0055_marketplace_qualification_execution.sql",
  import.meta.url,
);
const activationScriptUrl = new URL(
  "../privileged/marketplace-qualification-execution/Apply-MarketplaceQualificationExecutionMigration.ps1",
  import.meta.url,
);

describe("M9 Marketplace qualification execution migration", () => {
  it("records a direct qualification lifecycle without enabling customer execution", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("execution_state");
    expect(sql).toContain("CREATE TABLE app.marketplace_qualification_poll_checkpoints");
    expect(sql).toContain("record_marketplace_qualification_submission_start");
    expect(sql).toContain("record_marketplace_qualification_snapshot_reference");
    expect(sql).toContain("record_marketplace_qualification_poll_checkpoint");
    expect(sql).toContain("complete_marketplace_qualification_success");
    expect(sql).toContain("complete_marketplace_qualification_failure");
    expect(sql).toContain("poll_deadline_ms <= 300000");
    expect(sql).toContain("authorization_audit");
    expect(sql).toContain("execution_audit");
    expect(sql).not.toContain("'queue_or_dlq'");
    expect(sql).not.toContain("'download_audit'");
    expect(sql).not.toMatch(/CREATE\s+(?:LOGIN|ROLE|USER)\b/i);
    expect(sql).not.toMatch(/GRANT[^;]+TO\s+dhumi_customer_api/i);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+app\.(?:services|runs|outbox_events|provider_mappings)/i);
    expect(sql).not.toMatch(/UPDATE\s+app\.service_templates\s+SET\s+current_public_version_id/i);
  });

  it("verifies submission consumption using the persisted packet column", async () => {
    const script = await readFile(activationScriptUrl, "utf8");
    expect(script).toContain("packet.provider_submission_count <> 0");
    expect(script).not.toContain("submission_slots_consumed");
  });
});
