import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("LinkedIn People contact-contract operator boundary", () => {
  it("uses retained local evidence and exposes no customer execution route", async () => {
    const worker = await readFile(new URL(
      "../../src/worker/marketplaceContactContract.ts",
      import.meta.url,
    ), "utf8");
    const packageJson = JSON.parse(await readFile(
      new URL("../../package.json", import.meta.url),
      "utf8",
    )) as { scripts: Record<string, string> };
    const app = await readFile(new URL("../../src/app.ts", import.meta.url), "utf8");
    const openapi = await readFile(
      new URL("../../contracts/openapi.yaml", import.meta.url),
      "utf8",
    );

    expect(packageJson.scripts["operator:marketplace-contact-contract"])
      .toContain("marketplaceContactContract.ts");
    expect(worker).toContain("--confirm-offline-evidence");
    expect(worker).toContain("readFile");
    expect(worker).not.toContain("createMarketplaceDatasetCatalogueClient");
    expect(worker).not.toContain("createLocalEnvironmentSecretProvider");
    expect(worker).not.toMatch(/fetch\s*\(/);
    expect(worker).not.toContain("MarketplaceFilterClient");
    expect(worker).not.toContain("MarketplaceSearchClient");
    expect(app).not.toContain("MarketplaceContactContract");
    expect(openapi).not.toContain("marketplace-contact-contract");
  });

  it("keeps activation controlled, offline and fail-closed", async () => {
    const activation = await readFile(new URL(
      "../privileged/marketplace-people/Activate-LinkedInPeopleContactContract.ps1",
      import.meta.url,
    ), "utf8");

    expect(activation).toContain("RUN_EXECUTOR_DRIVER=controlled");
    expect(activation).toContain("jobManager|outboxDispatcher");
    expect(activation).toContain("--confirm-offline-evidence");
    expect(activation).toContain("Bright Data calls: 0");
    expect(activation).not.toContain("Invoke-RestMethod");
    expect(activation).not.toContain("Invoke-WebRequest");
  });
});
