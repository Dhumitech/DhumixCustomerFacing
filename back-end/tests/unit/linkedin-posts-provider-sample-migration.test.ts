import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../scripts/migrations/0057_linkedin_posts_provider_sample.sql",
  import.meta.url,
);

describe("LinkedIn Posts provider sample migration 0057", () => {
  it("admits only the exact retained evidence and keeps purchase execution disabled", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain("CREATE FUNCTION app.resolve_marketplace_provider_sample_source");
    expect(sql).toContain("CREATE FUNCTION app.record_marketplace_provider_sample_v1");
    expect(sql).toContain("2e1560c3-ca8b-40a0-b578-c9e71ecf27cd");
    expect(sql).toContain("d5a9c6c3403959349925d0574195e12e511ab2e861d421938e53b4a6738f6c95");
    expect(sql).toContain("039685f485ab09f0a6f9503517a2aa34957920c0f2faf827684c0b600512499b");
    expect(sql).toContain("formal_agreement_pending_local_demo");
    expect(sql).toContain("post_purchase_unmask_requires_entitlement");
    expect(sql).toContain("jsonb_array_length(field->'allowed_operators') <> 0");
    expect(sql).toContain("stored.source_kind = 'provider_qualification'");
    expect(sql).toContain("mapping.state = 'disabled'");
    expect(sql).not.toMatch(/GRANT[^;]+record_marketplace_provider_sample_v1[^;]+dhumi_customer_api/is);
    expect(sql).not.toMatch(/UPDATE\s+app\.provider_mappings\s+SET\s+state/is);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+app\.(?:services|runs|outbox_events)/i);
    expect(sql).not.toMatch(/\b(?:fetch|curl|Invoke-RestMethod)\b/i);
  });
});
