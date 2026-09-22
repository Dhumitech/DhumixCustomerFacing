import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(path), "utf8");
}

describe("M3 private ingestion and M4 customer-safe preview boundary", () => {
  it("keeps writes in the operator and exposes only catalog-scoped local reads", () => {
    const worker = source("src/worker/marketplaceSample.ts");
    const server = source("src/server.ts");
    const app = source("src/app.ts");
    const openapi = source("contracts/openapi.yaml");

    expect(worker).toContain("createMarketplaceSampleService");
    expect(worker).toContain("ingest-fixture");
    expect(worker).toContain("inspect-fixture");
    expect(worker).toContain("expire-fixtures");
    expect(worker).toContain("return await providerSample.promote");
    expect(worker).not.toContain("BRIGHTDATA_API_KEY");
    expect(worker).not.toContain("marketplaceDatasetCatalogueClient");
    expect(worker).not.toMatch(/\bfetch\s*\(/);
    expect(server).toContain("createMarketplacePreviewService");
    expect(server).not.toContain("marketplaceDatasetCatalogueClient");
    expect(server).not.toMatch(/\bfetch\s*\(/);
    expect(app).toContain("marketplacePreviewService");
    expect(openapi).toContain("/v1/catalog/templates/{slug}/sample:");
    expect(openapi).not.toMatch(/^\s*\/v1\/marketplace/m);
    expect(openapi).not.toMatch(/^\s*\/v1\/datasets/m);
  });
});
