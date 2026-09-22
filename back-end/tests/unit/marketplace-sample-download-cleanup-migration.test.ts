import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve("scripts/migrations/0064_marketplace_sample_download_cleanup.sql"), "utf8");
describe("generated sample-download retention migration", () => {
  it("keeps existing records/tables and adds only narrow cleanup functions", () => {
    expect(sql).toContain("CREATE FUNCTION app.fail_marketplace_sample_download_for_cleanup");
    expect(sql).toContain("CREATE FUNCTION app.claim_marketplace_sample_download_cleanup");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("authorization_row.state = 'authorized'");
    expect(sql).toContain("RETURN false");
    expect(sql).not.toMatch(/CREATE TABLE|DELETE FROM|DROP TABLE|GRANT\s+(?:SELECT|UPDATE|DELETE)/i);
  });
  it("uses database time, preserves active links, and restores private Tenant context", () => {
    expect(sql).toContain("download_expires_at <= evaluated_at - interval '1 hour'");
    expect(sql).toContain("created_at <= evaluated_at - interval '1 hour'");
    expect(sql).toContain("set_config('app.tenant_id', coalesce(prior_tenant, ''), true)");
    expect(sql).toContain("TO dhumi_operator");
    expect(sql).toContain("FROM PUBLIC");
    expect(sql).not.toMatch(/datasets\/(?:filter|snapshot)|BRIGHTDATA_API_KEY/i);
  });
});
