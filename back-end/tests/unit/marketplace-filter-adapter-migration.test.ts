import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve("scripts/migrations/0052_marketplace_filter_adapter_fixture.sql"),
  "utf8",
);
const worker = readFileSync(resolve("src/worker/jobManager.ts"), "utf8");

describe("M7 customer-disabled Marketplace Filter adapter migration", () => {
  it("registers one fixture-only disabled adapter without enabling customer execution", () => {
    expect(sql).toContain("'bright_data.marketplace.filter'");
    expect(sql).toContain("'1.0.0-m7-fixture'");
    expect(sql).toContain('"transport":"fixture"');
    expect(sql).toContain('"provider_http_enabled":false');
    expect(sql).toContain('"automatic_submission_retries":0');
    expect(sql).toContain("'disabled'");
    expect(sql).not.toMatch(/INSERT\s+INTO\s+app\.(?:provider_mappings|services|runs|outbox_events|entitlements)/i);
    expect(sql).not.toMatch(/UPDATE\s+app\.service_templates\s+SET\s+current_public_version_id/i);
    expect(sql).not.toMatch(/CREATE\s+(?:USER|ROLE)/i);
    expect(sql).not.toMatch(/GRANT[^;]+TO\s+dhumi_customer_api/i);
  });

  it("extends durable polling only with documented Marketplace Snapshot states", () => {
    expect(sql).toContain("'scheduled', 'building', 'ready', 'failed'");
    expect(sql).toContain("provider_poll_deadline");
    expect(sql).toContain("provider_next_poll_at");
    expect(sql).toContain("provider_consecutive_failures");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION app.checkpoint_provider_poll_fenced");
  });

  it("records terminal metadata and settles the existing provider cost hold idempotently", () => {
    expect(sql).toContain("CREATE FUNCTION app.record_marketplace_snapshot_observation_fenced");
    expect(sql).toContain("CREATE FUNCTION app.record_marketplace_known_submission_outcome_fenced");
    expect(sql).toContain("MARKETPLACE_SNAPSHOT_OBSERVATION_REPLAY_CONFLICT");
    expect(sql).toContain("p_currency_code IS DISTINCT FROM 'USD'");
    expect(sql).toContain("p_outcome IS NULL");
    expect(sql).toContain("UPDATE app.provider_cost_holds");
    expect(sql).toContain("p_outcome = 'zero_matches'");
    expect(sql).toContain("finalized_amount_micros = CASE WHEN p_outcome = 'zero_matches' THEN 0 ELSE NULL END");
  });

  it("routes by the immutable adapter identity while leaving provider transport uncomposed", () => {
    expect(sql).toContain("CREATE FUNCTION app.resolve_provider_executor_kind");
    expect(worker).toContain("createProviderRunExecutorRouter");
    expect(worker).not.toContain("createMarketplaceFilterClient");
    expect(worker).not.toContain("createMarketplaceRunExecutor");
  });

  it("retains the immutable historic M7 digest after its executor is archived", () => {
    expect(sql).toContain("decode('a5545e0016e38071abf59bf01a3520ebb529d7e1f14f367f10dde9b9e534e2ab', 'hex')");
  });
});
