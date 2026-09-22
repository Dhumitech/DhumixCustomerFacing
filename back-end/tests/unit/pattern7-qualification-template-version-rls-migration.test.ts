import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve("scripts/migrations/0035_amazon_qualification_template_version_rls.sql"),
  "utf8",
);
const executableMigration = migration
  .split(/\r?\n/)
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

describe("Pattern 7 qualification Template-version RLS migration", () => {
  it("adds an owner-only policy constrained to pending Pattern 6 Amazon definitions", () => {
    expect(migration).toMatch(/FOR SELECT\s+TO dhumi_owner/i);
    expect(migration).toContain("bright_data.amazon.scraper_library");
    expect(migration).toContain("1.0.0-pattern6");
    expect(migration).toMatch(/availability_state\s*=\s*'coming_soon'/i);
    expect(migration).toMatch(/evidence\.state\s*=\s*'pending'/i);
    expect(migration).toMatch(/adapter\.state\s*=\s*'disabled'/i);
    expect(executableMigration).not.toMatch(/TO dhumi_operator/i);
    expect(executableMigration).not.toMatch(/GRANT\s+SELECT/i);
    expect(executableMigration).not.toMatch(/CREATE\s+ROLE|CREATE\s+USER|\bLOGIN\b/i);
  });
});
