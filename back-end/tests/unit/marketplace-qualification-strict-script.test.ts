import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const scriptUrl = new URL(
  "../../scripts/Invoke-MarketplaceQualificationStrictFailClosed.ps1",
  import.meta.url,
);

describe("M9 strict fail-closed execution wrapper", () => {
  it("pins a five-record maximum and 2,500-micro per-record safety limit", async () => {
    const script = await readFile(scriptUrl, "utf8");

    expect(script).toContain("[ValidateRange(1, 5)]");
    expect(script).toContain("[int]$ExpectedRecords");
    expect(script).toContain("$strictMaximumRecords = 5");
    expect(script).toContain("$strictUnitCostMicros = 2500");
    expect(script).toContain("$expectedPacketMaximumCostMicros");
    expect(script).toContain("$expectedOfficialRateUsdPerThousand = [decimal]2.5");
    expect(script).toContain("$maximumEvidenceAge = [timespan]::FromHours(24)");
  });

  it("requires current rate and Snapshot-currency evidence", async () => {
    const script = await readFile(scriptUrl, "utf8");

    expect(script).toMatch(/\[Parameter\(Mandatory\)\][\s\S]{0,100}\[decimal\]\$VerifiedOfficialRateUsdPerThousand/);
    expect(script).toMatch(/\[Parameter\(Mandatory\)\][\s\S]{0,100}\[decimal\]\$VerifiedAccountRateUsdPerThousand/);
    expect(script).toMatch(/\[Parameter\(Mandatory\)\]\r?\n\s+\[datetimeoffset\]\$PricingEvidenceCheckedAt/);
    expect(script).toMatch(/\[Parameter\(Mandatory\)\][\s\S]{0,100}\[string\]\$SnapshotCostCurrency/);
    expect(script).toContain("[ValidateSet('USD')]");
  });

  it("checks the persisted packet before the execution command", async () => {
    const script = await readFile(scriptUrl, "utf8");
    const proofIndex = script.indexOf("FROM app.marketplace_qualification_packets AS packet");
    const executionIndex = script.indexOf("operator:marketplace-qualification -- execute");

    expect(proofIndex).toBeGreaterThan(-1);
    expect(executionIndex).toBeGreaterThan(proofIndex);
    expect(script).toContain("$authorizationState -ne 'authorized'");
    expect(script).toContain("$submissionCount -ne '0'");
    expect(script).toContain("$executionState -ne 'not_started'");
    expect(script).toContain("$ConfirmMaximumEstimatedCostUsd -ne $expectedPacketMaximumCostUsd");
    expect(script).toContain("Get-FileHash -LiteralPath $requiredMigrationFile -Algorithm SHA256");
    expect(script).toContain("$migrationChecksum -ne $expectedMigrationChecksum");
  });

  it("cannot authorize a packet and supports a zero-call check-only path", async () => {
    const script = await readFile(scriptUrl, "utf8");

    expect(script).not.toContain("operator:marketplace-qualification-preflight -- authorize");
    expect(script).not.toContain("/datasets/filter");
    expect(script).toContain("CHECK ONLY: strict fail-closed proof passed.");
    expect(script).toContain("Bright Data calls made by this script: 0.");
  });
});
