import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../scripts/migrations/0063_linkedin_people_contact_contract.sql",
  import.meta.url,
);

describe("LinkedIn People contact-contract migration 0063", () => {
  it("creates immutable private evidence and keeps every fulfillment mode disabled", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain("app.marketplace_contact_contract_packets");
    expect(sql).toContain("app.marketplace_contact_mode_contracts");
    expect(sql).toContain("app.resolve_linkedin_people_contact_contract_candidate");
    expect(sql).toContain("app.record_linkedin_people_contact_contract");
    expect(sql).toContain("app.resolve_marketplace_contact_modes");
    expect(sql).toContain("fulfillment_evidence_pending");
    expect(sql).toContain("not_enabled");
    expect(sql).toContain("enriched_when_available");
    expect(sql).toContain("contacts_only");
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION app\.resolve_marketplace_contact_modes\(uuid, integer\)\s+TO dhumi_customer_api/i,
    );
    expect(sql).not.toMatch(/current_public_version_id\s*=/i);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+app\.(?:runs|outbox_events|provider_mappings)/i);
    expect(sql).not.toMatch(/CREATE\s+(?:ROLE|USER)\b/i);
  });
});
