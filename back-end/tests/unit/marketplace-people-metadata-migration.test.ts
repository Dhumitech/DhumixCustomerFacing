import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../scripts/migrations/0060_linkedin_people_metadata_observation.sql",
  import.meta.url,
);

describe("LinkedIn People metadata observation migration 0060", () => {
  it("creates an append-only private evidence boundary without publication or execution", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain("app.marketplace_catalog_metadata_observations");
    expect(sql).toContain("app.resolve_linkedin_people_metadata_candidate");
    expect(sql).toContain("app.record_linkedin_people_metadata_observation");
    expect(sql).toContain("linkedin.people.standard");
    expect(sql).toContain("provider.catalog_metadata.capture");
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/i);
    expect(sql).not.toMatch(/UPDATE\s+app\.catalog_candidates/i);
    expect(sql).not.toMatch(/current_public_version_id\s*=/i);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+app\.(?:runs|outbox_events|provider_mappings)/i);
    expect(sql).not.toMatch(/CREATE\s+(?:ROLE|USER)\b/i);
  });
});
