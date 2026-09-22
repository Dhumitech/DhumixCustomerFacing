import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve("scripts/migrations/0050_marketplace_sample_download_authorization.sql"),
  "utf8",
);

describe("M5 Marketplace sample-download migration", () => {
  it("creates a tenant-bound, immutable authorization and audit boundary", () => {
    expect(sql).toContain("CREATE TABLE app.marketplace_sample_download_authorizations");
    expect(sql).toContain("marketplace_sample_download_actor_user_tenant_fk");
    expect(sql).toContain("marketplace_sample_download_actor_api_key_tenant_fk");
    expect(sql).toContain("UNIQUE (tenant_id, idempotency_key)");
    expect(sql).toContain("CREATE FUNCTION app.reserve_marketplace_sample_download");
    expect(sql).toContain("CREATE FUNCTION app.complete_marketplace_sample_download");
    expect(sql).toContain("'marketplace.sample_download_authorize'");
    expect(sql).toContain("'provider_calls', 0");
  });

  it("enforces bounded preview-only behavior and least privilege", () => {
    expect(sql).toContain("record_limit BETWEEN 1 AND 100");
    expect(sql).toContain("resolve_marketplace_sample_preview");
    expect(sql).toContain("purchase and full export are not enabled");
    expect(sql).toContain("TO dhumi_customer_api");
    expect(sql).not.toMatch(/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)/i);
    expect(sql).not.toMatch(/datasets\/(?:filter|snapshot)|BRIGHTDATA_API_KEY/i);
  });
});
