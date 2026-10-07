import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(path), "utf8");
}

describe("Pattern 5 private-boundary source guard", () => {
  it("does not add a public Bright Data route or provider identifier contract", () => {
    const openapi = source("contracts/openapi.yaml");
    const routes = source("src/routes/runRoutes.ts");

    expect(openapi).not.toMatch(/^\s*\/v1\/.*bright[-_]?data.*:/im);
    expect(openapi).not.toMatch(/^\s*\/v1\/.*dataset.*:/im);
    expect(routes).not.toContain("BrightDataIntegrationClient");
    expect(routes).not.toContain("api.brightdata.com");
  });

  it("composes provider egress only from the private Job Manager worker", () => {
    const worker = source("src/worker/jobManager.ts");
    const server = source("src/server.ts");
    const repository = source(
      "src/services/brightdata/providerExecutionPlanRepository.ts",
    );

    expect(worker).toContain("createBrightDataRunExecutor");
    expect(worker).toContain("createProviderExecutionPlanRepository(jobPool,");
    expect(server).not.toContain("createBrightDataRunExecutor");
    expect(repository).toContain("resolveFencedTemplate");
    expect(repository).toContain("providerDatasetAad");
    expect(worker).toContain("createRecordedRunExecutor");
    expect(repository).not.toMatch(/app\.resolve_provider_(execution|reconciliation)_plan/);
  });

  it("creates no Pattern 5 database role/bootstrap and redacts private key material", () => {
    const migration = source("scripts/migrations/0031_provider_execution_boundary.sql");
    const logger = source("src/config/logger.ts");

    expect(migration).not.toMatch(/CREATE\s+(?:ROLE|USER)/i);
    expect(migration).toContain("TO dhumi_job_manager");
    expect(logger).toContain('"PROVIDER_REFERENCE_LOCAL_KEY"');
    expect(logger).toContain('"providerResourceCiphertext"');
  });
});
