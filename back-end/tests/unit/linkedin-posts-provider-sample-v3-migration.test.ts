import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../scripts/migrations/0059_linkedin_posts_provider_sample_version_3.sql",
  import.meta.url,
);

describe("LinkedIn Posts provider sample version 3 migration 0059", () => {
  it("preserves historical version 2 and admits only immutable provider version 3", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain("p_sample_version <> 3");
    expect(sql).toContain("'/3/' || encode(p_checksum, 'hex')");
    expect(sql).toContain("existing.sample_version = 3");
    expect(sql).toContain("p_template_version_id, 3, 'provider_qualification'");
    expect(sql).toContain("'sample_version', 3");
    expect(sql).not.toMatch(/UPDATE\s+app\.marketplace_sample_versions/i);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+app\.marketplace_sample_versions/i);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+app\.(?:services|runs|outbox_events)/i);
    expect(sql).not.toMatch(/\b(?:fetch|curl|Invoke-RestMethod)\b/i);
  });
});
