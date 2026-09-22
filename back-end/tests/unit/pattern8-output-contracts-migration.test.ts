import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../scripts/migrations/0040_amazon_precise_output_contracts.sql",
  import.meta.url,
);
const repositoryUrl = new URL(
  "../../src/services/qualification/amazonQualificationRepository.ts",
  import.meta.url,
);
const implementationUrls = [
  new URL(
    "../../src/services/brightdata/amazon/amazonOperationDefinitions.ts",
    import.meta.url,
  ),
  new URL(
    "../../src/services/brightdata/amazon/amazonOperationSerializer.ts",
    import.meta.url,
  ),
  new URL(
    "../../src/services/brightdata/amazon/amazonResultNormalizer.ts",
    import.meta.url,
  ),
  new URL(
    "../../src/services/brightdata/amazon/amazonOutputContracts.ts",
    import.meta.url,
  ),
];

describe("Pattern 8 Priority 4 output-contract migration", () => {
  it("stages 13 immutable v2 definitions with four precise contracts", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("'1.1.0-pattern8-output-contracts'");
    expect(sql).toContain("'registry_version', 2");
    expect(sql).toContain("'output_contracts'");
    expect(sql).toContain("previous.service_template_id,\n  2,");
    expect(sql).toContain("contract_state = 'precise'");
    expect(sql).toContain("contract_state = 'unavailable'");
    expect(sql).toContain("<> 13");
    expect(sql).toContain("<> 4");
    expect(sql).toContain("<> 9");
  });

  it("allows only the exact versioned acceptance path and adds no identity", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("CREATE FUNCTION app.begin_amazon_scraper_catalog_import_v2");
    expect(sql).toContain("CREATE FUNCTION app.resolve_amazon_qualification_candidate_v2");
    expect(sql).toContain("CREATE FUNCTION app.begin_amazon_provider_qualification_v3");
    expect(sql).toContain("CREATE FUNCTION app.resolve_amazon_qualification_acceptance_plan_v3");
    expect(sql).toContain("CREATE FUNCTION app.accept_amazon_provider_qualification_v3");
    expect(sql).toContain("QUALIFICATION_OUTPUT_CONTRACT_UNAVAILABLE");
    expect(sql).toContain("QUALIFICATION_OUTPUT_CONTRACT_MISMATCH");
    expect(sql).toContain("FROM dhumi_operator");
    expect(sql).toContain("TO dhumi_operator");
    expect(sql).not.toMatch(/CREATE\s+(?:LOGIN|ROLE|USER)\b/i);
    expect(sql).not.toMatch(/UPDATE\s+app\.service_templates\s+SET\s+state\s*=\s*'published'/i);
    expect(sql).not.toMatch(/provider_mappings[\s\S]{0,1000}'enabled'/i);
  });

  it("moves the operator repository to the v2 registry and v3 acceptance gate", async () => {
    const source = await readFile(repositoryUrl, "utf8");
    expect(source).toContain("app.begin_amazon_scraper_catalog_import_v2");
    expect(source).toContain("app.resolve_amazon_qualification_candidate_v2");
    expect(source).toContain("app.begin_amazon_provider_qualification_v3");
    expect(source).toContain("app.resolve_amazon_qualification_acceptance_plan_v3");
    expect(source).toContain("app.accept_amazon_provider_qualification_v3");
  });

  it("pins the exact current Amazon contract implementation bytes", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    const digest = createHash("sha256");
    for (const implementationUrl of implementationUrls) {
      digest.update(await readFile(implementationUrl));
    }
    expect(sql).toContain(`decode('${digest.digest("hex")}', 'hex')`);
  });
});
