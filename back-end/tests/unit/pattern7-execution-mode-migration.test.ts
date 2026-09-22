import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../scripts/migrations/0036_amazon_qualification_execution_mode.sql",
  import.meta.url,
);
const repositoryUrl = new URL(
  "../../src/services/qualification/amazonQualificationRepository.ts",
  import.meta.url,
);

describe("Pattern 7 execution-mode binding migration", () => {
  it("pins scrape or trigger on each attempt without creating another identity", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("ADD COLUMN provider_execution_mode text NOT NULL DEFAULT 'scrape'");
    expect(sql).toContain("provider_execution_mode IN ('scrape', 'trigger')");
    expect(sql).toContain("CREATE FUNCTION app.begin_amazon_provider_qualification_v2");
    expect(sql).toContain("CREATE FUNCTION app.resolve_amazon_qualification_acceptance_plan_v2");
    expect(sql).toContain("CREATE FUNCTION app.accept_amazon_provider_qualification_v2");
    expect(sql).toContain("QUALIFICATION_EXECUTION_MODE_MISMATCH");
    expect(sql).toContain("TO dhumi_operator");
    expect(sql).not.toMatch(/CREATE\s+(?:LOGIN|ROLE|USER)\b/i);
  });

  it("keeps the runtime repository on an endpoint-bound qualification generation", async () => {
    const source = await readFile(repositoryUrl, "utf8");
    expect(source).toContain("app.begin_amazon_provider_qualification_v3");
    expect(source).toContain("app.resolve_amazon_qualification_acceptance_plan_v3");
    expect(source).toContain("app.accept_amazon_provider_qualification_v3");
    expect(source).not.toMatch(/app\.begin_amazon_provider_qualification\(/);
    expect(source).not.toMatch(/app\.resolve_amazon_qualification_acceptance_plan\(/);
    expect(source).not.toMatch(/app\.accept_amazon_provider_qualification\(/);
  });
});
