import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const wrapper = readFileSync(
  new URL(
    "../privileged/pattern4-resilience-e2e/Invoke-Pattern4ResilienceDatabaseMatrix.ps1",
    import.meta.url,
  ),
  "utf8",
);
const operatorProof = readFileSync(
  new URL(
    "../privileged/pattern4-resilience-e2e/operator-runtime-database.test.ts",
    import.meta.url,
  ),
  "utf8",
);
const devOperatorEnvironmentHelper = readFileSync(
  new URL(
    "../privileged/pattern4-resilience-e2e/Set-Pattern4DevOperatorEnvironment.ps1",
    import.meta.url,
  ),
  "utf8",
);

describe("Pattern 4 real-database resilience matrix", () => {
  it("holds the administrator password only in the parent and child environments", () => {
    expect(wrapper).toContain("Read-Host");
    expect(wrapper).toContain("-AsSecureString");
    expect(wrapper).toContain("$env:PGPASSWORD = $plainPassword");
    expect(wrapper).toContain("ZeroFreeBSTR");
    expect(wrapper).not.toMatch(/postgresql:\/\/[^/@\s]+:[^/@\s]+@/i);
  });

  it("runs every required database and emulator proof", () => {
    expect(wrapper).toContain("0020_durable_execution_fencing.sql");
    expect(wrapper).toContain("0021_durable_execution_reconciliation.sql");
    expect(wrapper).toContain("cancel-run-concurrency-database.test.ts");
    expect(wrapper).toContain("retry-run-concurrency-database.test.ts");
    expect(wrapper).toContain("operator-runtime-database.test.ts");
    expect(wrapper).toContain("servicebus-execution-queue.test.ts");
    expect(wrapper).toContain("redis-capacity-lease.test.ts");
  });

  it("runs shared real-database fixtures sequentially", () => {
    expect(wrapper).toContain("Scenario 3a/7: restricted operator runtime");
    expect(wrapper).toContain("Scenario 3b/7: cancellation races");
    expect(wrapper).toContain("Scenario 3c/7: retry lineage");
    expect(wrapper).toContain("Pattern 4 cancellation database proof failed.");
    expect(wrapper).toContain("Pattern 4 retry-lineage database proof failed.");
  });

  it("isolates the baseline full regression from scenario credentials and flags", () => {
    const regressionBlock = wrapper.slice(wrapper.indexOf("if ($FullRegression)"));
    const cleanupIndex = regressionBlock.indexOf("foreach ($name in $environmentNames)");
    const testIndex = regressionBlock.indexOf("& npm test");

    expect(cleanupIndex).toBeGreaterThanOrEqual(0);
    expect(regressionBlock).toContain('Remove-Item "Env:$name"');
    expect(testIndex).toBeGreaterThan(cleanupIndex);
  });

  it("fails closed while an external dispatcher or Job Manager is running", () => {
    expect(wrapper).toContain("Get-CimInstance Win32_Process");
    expect(wrapper).toContain("PATTERN4_WORKERS_MUST_BE_STOPPED");
  });

  it("authenticates and assumes only the restricted operator capability", () => {
    expect(operatorProof).toContain("verifyOperatorPool");
    expect(operatorProof).toContain("withOperatorTransaction");
    expect(operatorProof).toContain("dhumi_operator");
    expect(operatorProof).toContain("recover_dead_lettered_run_command");
  });

  it("stores the dev operator password without displaying it", () => {
    expect(devOperatorEnvironmentHelper).toContain("Read-Host");
    expect(devOperatorEnvironmentHelper).toContain("-AsSecureString");
    expect(devOperatorEnvironmentHelper).toContain("dhumi_dev_operator_login");
    expect(devOperatorEnvironmentHelper).toContain("ZeroFreeBSTR");
    expect(devOperatorEnvironmentHelper).toContain("[A-Za-z0-9_-]{24,}");
    expect(devOperatorEnvironmentHelper).not.toMatch(/Write-(?:Host|Output).*plainPassword/);
  });
});
