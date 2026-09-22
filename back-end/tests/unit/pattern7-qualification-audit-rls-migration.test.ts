import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve("scripts/migrations/0034_amazon_qualification_audit_rls.sql"),
  "utf8",
);
const executableMigration = migration
  .split(/\r?\n/)
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

describe("Pattern 7 qualification audit RLS migration", () => {
  it("adds an owner-only, tenantless and action-limited insert policy", () => {
    expect(migration).toMatch(/FOR INSERT\s+TO dhumi_owner/i);
    expect(migration).toMatch(/tenant_id IS NULL/i);
    expect(migration).toContain("provider.catalog_import.begin");
    expect(migration).toContain("provider.catalog_candidate.review");
    expect(migration).toContain("provider.qualification.accept");
    expect(executableMigration).not.toMatch(/TO dhumi_operator/i);
    expect(executableMigration).not.toMatch(/GRANT\s+INSERT/i);
    expect(executableMigration).not.toMatch(/CREATE\s+ROLE|CREATE\s+USER|\bLOGIN\b/i);
  });
});
