import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const workerUrl = new URL(
  "../../src/worker/marketplaceQualificationPreflight.ts",
  import.meta.url,
);
const packageUrl = new URL("../../package.json", import.meta.url);
const activationUrl = new URL(
  "../privileged/marketplace-qualification-preflight/Apply-MarketplaceQualificationPreflightMigration.ps1",
  import.meta.url,
);

describe("M9 Marketplace qualification preflight operator boundary", () => {
  it("supports preparation and explicit authorization but cannot claim or call a provider", async () => {
    const worker = await readFile(workerUrl, "utf8");
    const packageJson = JSON.parse(await readFile(packageUrl, "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts["operator:marketplace-qualification-preflight"])
      .toContain("marketplaceQualificationPreflight.ts");
    expect(worker).toContain('request.action !== "prepare" && request.action !== "authorize"');
    expect(worker).toContain("--confirm-one-billable-submission");
    expect(worker).not.toContain("claimMarketplace");
    expect(worker).not.toContain("MarketplaceFilterClient");
    expect(worker).not.toContain("BRIGHTDATA_API_KEY");
    expect(worker).not.toContain("fetch(");
  });

  it("activates only the offline migration while the executor is controlled", async () => {
    const activation = await readFile(activationUrl, "utf8");
    expect(activation).toContain("RUN_EXECUTOR_DRIVER=controlled");
    expect(activation).toContain("0054_marketplace_qualification_preflight");
    expect(activation).toContain("authorization_state <> 'not_authorized'");
    expect(activation).toContain("Bright Data calls: 0");
    expect(activation).not.toContain("Invoke-RestMethod");
    expect(activation).not.toContain("Invoke-WebRequest");
  });
});
