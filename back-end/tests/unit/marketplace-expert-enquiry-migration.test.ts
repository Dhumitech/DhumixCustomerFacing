import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve("scripts/migrations/0051_marketplace_expert_enquiries.sql"),
  "utf8",
);

describe("M6 Marketplace expert-enquiry migration", () => {
  it("creates a tenant-bound, idempotent and auditable request boundary", () => {
    expect(sql).toContain("CREATE TABLE app.marketplace_expert_enquiries");
    expect(sql).toContain("marketplace_expert_enquiry_actor_user_tenant_fk");
    expect(sql).toContain("marketplace_expert_enquiry_actor_api_key_tenant_fk");
    expect(sql).toContain("UNIQUE (tenant_id, idempotency_key)");
    expect(sql).toContain("CREATE FUNCTION app.create_marketplace_expert_enquiry");
    expect(sql).toContain("CREATE FUNCTION app.transition_marketplace_expert_enquiry");
    expect(sql).toContain("'marketplace.expert_enquiry.create'");
    expect(sql).toContain("'marketplace.expert_enquiry.transition'");
    expect(sql).toContain("'provider_calls', 0");
  });

  it("keeps purchase and execution fail-closed", () => {
    expect(sql).toContain("resolve_marketplace_sample_preview");
    expect(sql).toContain("TO dhumi_customer_api");
    expect(sql).toContain("TO dhumi_operator");
    expect(sql).not.toMatch(/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)/i);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+app\.(?:services|runs|outbox_events|entitlements)/i);
    expect(sql).not.toMatch(/datasets\/(?:filter|search|snapshot)|BRIGHTDATA_API_KEY/i);
  });
});
