import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(path), "utf8");
}

describe("M2 private Marketplace catalogue boundary", () => {
  it("is composed only by its privileged operator", () => {
    const worker = source("src/worker/marketplaceCatalogue.ts");
    const server = source("src/server.ts");
    const app = source("src/app.ts");
    const openapi = source("contracts/openapi.yaml");

    expect(worker).toContain("createMarketplaceCatalogueService");
    expect(server).not.toContain("MarketplaceCatalogue");
    expect(app).not.toContain("MarketplaceCatalogue");
    expect(openapi).not.toMatch(/^\s*\/v1\/marketplace/m);
    expect(openapi).not.toMatch(/^\s*\/v1\/datasets/m);
  });

  it("settles database work before the operator closes its pool", () => {
    const worker = source("src/worker/marketplaceCatalogue.ts");

    expect(worker).toMatch(/return\s+await\s+reviewMarketplaceCatalogueCandidate\(/);
    expect(worker).toMatch(/return\s+await\s+service\.importCatalogue\(/);
  });

  it("does not create a customer grant or provider execution mapping", () => {
    const migration = source("scripts/migrations/0045_marketplace_catalogue_import.sql");

    expect(migration).not.toMatch(/CREATE\s+(?:ROLE|USER)\b/i);
    expect(migration).not.toMatch(/INSERT\s+INTO\s+app\.provider_mappings/i);
    expect(migration).not.toMatch(/GRANT\s+.+\s+TO\s+dhumi_customer_api/is);
    expect(migration).toContain("TO dhumi_operator");
  });
});
