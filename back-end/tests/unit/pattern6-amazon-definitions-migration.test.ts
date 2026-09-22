import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AMAZON_OPERATION_DEFINITIONS } from "../../src/services/brightdata/amazon/amazonOperationDefinitions.js";

const migrationUrl = new URL(
  "../../scripts/migrations/0032_amazon_operation_definitions.sql",
  import.meta.url,
);

describe("Pattern 6 Amazon definition staging migration", () => {
  it("stages every production slug as draft behind one disabled shared adapter", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    for (const definition of AMAZON_OPERATION_DEFINITIONS) {
      expect(migration).toContain(definition.slug);
      expect(migration).toContain(definition.operationCode);
    }
    expect(migration).toContain("bright_data.amazon.scraper_library");
    expect(migration).toMatch(/adapter_versions[\s\S]*'disabled'/i);
    expect(migration).toMatch(/service_templates[\s\S]*'draft'/i);
    expect(migration).not.toMatch(/current_public_version_id\s*=/i);
  });

  it("does not fabricate provider mappings, credentials, publication or identities", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    expect(migration).not.toMatch(/gd_[a-z0-9]{8,}/i);
    expect(migration).not.toMatch(/INSERT\s+INTO\s+app\.provider_mappings/i);
    expect(migration).not.toMatch(/INSERT\s+INTO\s+app\.provider_credentials/i);
    expect(migration).not.toMatch(/CREATE\s+(?:ROLE|USER)|\bLOGIN\b/i);
    expect(migration).not.toMatch(/\bGRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)\s+ON\s+(?:TABLE\s+)?/i);
    expect(migration).not.toMatch(/'published'/i);
    expect(migration).toContain("'pending'");
    expect(migration).toContain("SECURITY INVOKER");
  });

  it("retains the immutable historical Pattern 6 implementation digest", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    expect(migration).toContain(
      "decode('afd0a29edcc08fdae2d26e1b3c9ca2281869b184e550717e834592c969336a62', 'hex')",
    );
  });
});
