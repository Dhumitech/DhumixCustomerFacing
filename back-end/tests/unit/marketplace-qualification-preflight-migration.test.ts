import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../scripts/migrations/0054_marketplace_qualification_preflight.sql",
  import.meta.url,
);

describe("M9 Marketplace qualification preflight migration", () => {
  it("adds an operator-only immutable packet and exact authorization gate", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("CREATE TABLE app.marketplace_qualification_packets");
    expect(sql).toContain("CREATE FUNCTION app.prepare_marketplace_qualification_packet");
    expect(sql).toContain("CREATE FUNCTION app.authorize_marketplace_qualification_packet");
    expect(sql).toContain("CREATE FUNCTION app.claim_marketplace_qualification_submission");
    expect(sql).toContain("maximum_provider_submissions = 1");
    expect(sql).toContain("automatic_submission_retries = 0");
    expect(sql).toContain("provider_http_enabled");
    expect(sql).toContain("'not_authorized'");
    expect(sql).not.toMatch(/CREATE\s+(?:LOGIN|ROLE|USER)\b/i);
    expect(sql).not.toMatch(/GRANT[^;]+TO\s+dhumi_customer_api/i);
    expect(sql).not.toMatch(/UPDATE\s+app\.service_templates\s+SET\s+current_public_version_id/i);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+app\.(?:services|runs|outbox_events|provider_mappings)/i);
  });

  it("binds the authorization to exact request, cost, expiry and one atomic claim", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("MARKETPLACE_QUALIFICATION_AUTHORIZATION_MISMATCH");
    expect(sql).toContain("MARKETPLACE_QUALIFICATION_AUTHORIZATION_EXPIRED");
    expect(sql).toContain("MARKETPLACE_QUALIFICATION_SUBMISSION_ALREADY_CLAIMED");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("request_fingerprint");
    expect(sql).toContain("maximum_estimated_cost_micros");
    expect(sql).toContain("authorization_hash");
    expect(sql).toContain("expires_at");
    expect(sql).toContain("p_authorization_reference !~");
    expect(sql).toContain("existing.authorization_state IS DISTINCT FROM 'not_authorized'");
  });
});
