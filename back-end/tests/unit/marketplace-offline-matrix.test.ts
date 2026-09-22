import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const wrapperPath = resolve(
  "tests/privileged/marketplace-offline-matrix/Invoke-MarketplaceOfflineMatrix.ps1",
);
const cleanDatabaseWrapperPath = resolve(
  "tests/privileged/marketplace-offline-matrix/Invoke-MarketplaceOfflineMatrixCleanDatabaseProof.ps1",
);
const persistentStateProofPath = resolve(
  "tests/privileged/marketplace-offline-matrix/Verify-MarketplacePersistentState.sql",
);
const serviceBusMatrixPath = resolve(
  "tests/integration/servicebus-execution-queue.test.ts",
);

describe("M8 offline Marketplace release matrix", () => {
  it("fails closed unless controlled execution is configured and workers are stopped", () => {
    const wrapper = readFileSync(wrapperPath, "utf8");

    expect(wrapper).toContain("RUN_EXECUTOR_DRIVER");
    expect(wrapper).toContain("controlled");
    expect(wrapper).toContain("M8_CONTROLLED_EXECUTOR_REQUIRED");
    expect(wrapper).toContain("Get-CimInstance Win32_Process");
    expect(wrapper).toContain("(?:src|dist)");
    expect(wrapper).toContain("(?:ts|js)");
    expect(wrapper).toContain("M8_EXECUTION_WORKERS_MUST_BE_STOPPED");
    expect(wrapper).toContain("dhumi-marketplace-m8");
    expect(wrapper).toContain("http://127.0.0.1:$HealthPort");
    expect(wrapper).toContain("15672");
    expect(wrapper).toContain("16380");
    expect(wrapper).toContain("SERVICE_BUS_TEST_CONNECTION_STRING");
    expect(wrapper).toContain("REDIS_TEST_URL");
    expect(wrapper).toContain("M8_SERVICE_BUS_NOT_READY");
  });

  it("holds the administrator password only in the matrix process and verifies both local databases", () => {
    const wrapper = readFileSync(wrapperPath, "utf8");

    expect(wrapper).toContain("Read-Host");
    expect(wrapper).toContain("-AsSecureString");
    expect(wrapper).toContain("ZeroFreeBSTR");
    expect(wrapper).toContain("dhumi_test");
    expect(wrapper).toContain("dhumi_dev");
    expect(wrapper).not.toMatch(/postgresql:\/\/[^/@\s]+:[^/@\s]+@/i);
  });

  it("isolates clean transition proofs from persistent test and development verification", () => {
    const wrapper = readFileSync(wrapperPath, "utf8");
    const cleanDatabaseWrapper = readFileSync(cleanDatabaseWrapperPath, "utf8");

    expect(wrapper).toContain(
      "Invoke-MarketplaceOfflineMatrixCleanDatabaseProof.ps1",
    );
    expect(wrapper).toContain("Verify-MarketplacePersistentState.sql");
    expect(wrapper).toContain("--set=expected_database=$($entry.Key)");

    for (const cleanOnlyProof of [
      "0034_marketplace_catalogue_import.sql",
      "0035_marketplace_sample_ingestion.sql",
      "0036_marketplace_sample_preview.sql",
      "0037_marketplace_sample_download_authorization.sql",
      "0038_marketplace_expert_enquiries.sql",
      "0039_marketplace_filter_adapter_fixture.sql",
      "0040_marketplace_offline_release_matrix.sql",
    ]) {
      expect(cleanDatabaseWrapper).toContain(cleanOnlyProof);
      expect(wrapper).not.toContain(cleanOnlyProof);
    }

    expect(cleanDatabaseWrapper).toContain(
      "dhumi-marketplace-m8-clean-postgres-proof",
    );
    expect(cleanDatabaseWrapper).toContain(
      "Verify-MarketplacePersistentState.sql",
    );
    expect(cleanDatabaseWrapper).toContain(
      "--set=expected_database=$databaseName",
    );
    expect(cleanDatabaseWrapper).toContain("RandomNumberGenerator]::Create()");
    expect(cleanDatabaseWrapper).toContain("GetBytes($passwordBytes)");
    expect(cleanDatabaseWrapper).toContain("Dispose()");
    expect(cleanDatabaseWrapper).not.toContain(
      "RandomNumberGenerator]::GetBytes(36)",
    );
    expect(cleanDatabaseWrapper).toContain("docker rm -f $containerName");
  });

  it("keeps transient PostgreSQL readiness failures retryable in Windows PowerShell", () => {
    const cleanDatabaseWrapper = readFileSync(cleanDatabaseWrapperPath, "utf8");

    expect(cleanDatabaseWrapper).toContain(
      "$probeErrorActionPreference = $ErrorActionPreference",
    );
    expect(cleanDatabaseWrapper).toContain(
      "$ErrorActionPreference = 'Continue'",
    );
    expect(cleanDatabaseWrapper).toContain(
      "$ErrorActionPreference = $probeErrorActionPreference",
    );
    expect(cleanDatabaseWrapper).toContain("$probeExitCode = $LASTEXITCODE");
  });

  it("runs the remaining authorization, storage and resilience evidence", () => {
    const wrapper = readFileSync(wrapperPath, "utf8");

    for (const evidence of [
      "0020_durable_execution_fencing.sql",
      "0021_durable_execution_reconciliation.sql",
      "0025_usage_finalization.sql",
      "cancel-run-concurrency-database.test.ts",
      "retry-run-concurrency-database.test.ts",
      "list-catalog-templates.test.ts",
      "get-catalog-template.test.ts",
      "get-run-result.test.ts",
      "azurite-result-storage.test.ts",
      "azurite-marketplace-sample-storage.test.ts",
      "azurite-marketplace-sample-download.test.ts",
      "servicebus-execution-queue.test.ts",
      "redis-capacity-lease.test.ts",
      "marketplace-run-executor.test.ts",
      "marketplace-sample-retention-migration.test.ts",
      "marketplace-filter-adapter-migration.test.ts",
      "job-manager-service.test.ts",
      "dead-letter-recovery-service.test.ts",
    ]) {
      expect(wrapper).toContain(evidence);
    }

    expect(wrapper).toContain("--no-file-parallelism");
  });

  it("routes asynchronous Service Bus subscription errors into awaited test promises", () => {
    const serviceBusMatrix = readFileSync(serviceBusMatrixPath, "utf8");

    expect(serviceBusMatrix).toContain("rejectFirst?.(error)");
    expect(serviceBusMatrix).toContain("rejectDeadLetter?.(error)");
    expect(serviceBusMatrix).not.toMatch(
      /async \(error\) => \{\s*throw error;\s*\}/,
    );
  });

  it("verifies persistent Marketplace state without replaying lifecycle fixtures", () => {
    const proof = readFileSync(persistentStateProofPath, "utf8");

    expect(proof).toContain(":'expected_database'");
    expect(proof).toContain("0053_marketplace_filter_execution_rls");
    expect(proof).toContain("bright_data.marketplace.filter");
    expect(proof).toContain("1.0.0-m7-fixture");
    expect(proof).toContain("provider_http_enabled");
    expect(proof).toContain("app.provider_mappings");
    expect(proof).toContain("app.service_template_versions");
    expect(proof).toContain("current_public_version_id");
    expect(proof).toContain("availability_state <> 'coming_soon'");
    expect(proof).toContain("effective_at IS NOT NULL");
    expect(proof).toContain("published_at IS NOT NULL");
    expect(proof).toContain("SET LOCAL row_security = off");
    expect(proof).toContain("ROLLBACK");
    expect(proof).not.toMatch(/INSERT\s+INTO\s+app\./i);
    expect(proof).not.toMatch(/UPDATE\s+app\./i);
    expect(proof).not.toMatch(/DELETE\s+FROM\s+app\./i);
  });

  it("keeps the RLS repair restricted to the unpublished HTTP-off fixture route", () => {
    const migration = readFileSync(
      resolve("scripts/migrations/0053_marketplace_filter_execution_rls.sql"),
      "utf8",
    );

    expect(migration).toContain("slug = 'linkedin-posts'");
    expect(migration).toContain("state = 'draft'");
    expect(migration).toContain("current_public_version_id IS NULL");
    expect(migration).toContain("published_at IS NULL");
    expect(migration).toContain("'1.0.0-m7-fixture'");
    expect(migration).toContain('"provider_http_enabled":false');
    expect(migration).toContain('"can_execute":false');
    expect(migration).not.toMatch(/GRANT[^;]+TO\s+dhumi_customer_api/i);
    expect(migration).not.toMatch(/INSERT\s+INTO\s+app\.(?:services|runs|provider_mappings)/i);
    expect(migration).not.toMatch(/UPDATE\s+app\.service_templates/i);
  });

  it("contains no provider import, Filter or execution command", () => {
    const wrapper = readFileSync(wrapperPath, "utf8");

    expect(wrapper).not.toMatch(/operator:marketplace-catalogue/i);
    expect(wrapper).not.toMatch(/operator:marketplace-sample/i);
    expect(wrapper).not.toMatch(/\/datasets\/filter/i);
    expect(wrapper).not.toMatch(/RUN_EXECUTOR_DRIVER\s*=\s*bright_data/i);
    expect(wrapper).not.toMatch(/worker:jobs|worker:outbox/i);
  });

  it("treats commercial entitlement and paid execution as a deferred fail-closed gate", () => {
    const wrapper = readFileSync(wrapperPath, "utf8");
    const persistentStateProof = readFileSync(persistentStateProofPath, "utf8");
    const boundary = `${wrapper}\n${persistentStateProof}`;

    expect(boundary).toContain("M8_COMMERCIAL_EXECUTION_DEFERRED");
    expect(boundary).toContain("1.0.0-m7-fixture");
    expect(boundary).toContain("provider_http_enabled");
    expect(boundary).toContain("current_public_version_id");
  });
});
