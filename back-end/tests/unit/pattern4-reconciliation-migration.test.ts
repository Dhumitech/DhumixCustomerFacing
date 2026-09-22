import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve("scripts/migrations/0030_durable_execution_reconciliation.sql"),
  "utf8",
);

describe("Pattern 4 reconciliation migration", () => {
  it("adds only strict Run-identifier commands for reconciliation and operator recovery", () => {
    expect(sql).toContain("outbox_events_jobs_reconcile_shape_check");
    expect(sql).toContain("outbox_events_jobs_recover_shape_check");
    expect(sql).toContain("payload = jsonb_build_object('run_id', aggregate_id::text)");
  });

  it("makes uncertain submission scheduling idempotent and fenced", () => {
    expect(sql).toContain("CREATE FUNCTION app.schedule_run_reconciliation");
    expect(sql).toContain("state = 'ambiguous'");
    expect(sql).toContain("ON CONFLICT (aggregate_id) WHERE topic = 'jobs.reconcile'");
    expect(sql).toContain("CREATE FUNCTION app.complete_run_reconciliation");
    expect(sql).toContain("RUN_RECONCILIATION_FENCE_REJECTED");
  });

  it("separates automated reconciliation from explicit operator DLQ recovery", () => {
    expect(sql).toContain("TO dhumi_job_manager");
    expect(sql).toContain("TO dhumi_operator");
    expect(sql).toContain("REVOKE ALL ON FUNCTION app.recover_dead_lettered_run_command");
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION app.recover_dead_lettered_run_command(uuid, text)",
    );
  });

  it("allows a failed recovery command to be recovered again without duplicating one DLQ request", () => {
    expect(sql).toContain("CREATE TABLE app.dead_letter_recovery_intents");
    expect(sql).toContain("original_event_id uuid PRIMARY KEY");
    expect(sql).toContain("outbox_events_one_pending_jobs_recover_per_run_idx");
    expect(sql).toContain("WHERE topic = 'jobs.recover' AND published_at IS NULL");
    expect(sql).toContain("WHERE intent.original_event_id = original_event.id");
  });
});
