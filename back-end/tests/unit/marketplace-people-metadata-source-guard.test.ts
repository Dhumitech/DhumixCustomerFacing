import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const workerUrl = new URL(
  "../../src/worker/marketplacePeopleMetadata.ts",
  import.meta.url,
);
const packageUrl = new URL("../../package.json", import.meta.url);
const activationUrl = new URL(
  "../privileged/marketplace-people/Activate-LinkedInPeopleMetadata.ps1",
  import.meta.url,
);

describe("standard LinkedIn People metadata operator boundary", () => {
  it("requires explicit read-only confirmation and exposes no customer route", async () => {
    const worker = await readFile(workerUrl, "utf8");
    const packageJson = JSON.parse(await readFile(packageUrl, "utf8")) as {
      scripts: Record<string, string>;
    };
    const app = await readFile(new URL("../../src/app.ts", import.meta.url), "utf8");
    const openapi = await readFile(
      new URL("../../contracts/openapi.yaml", import.meta.url),
      "utf8",
    );

    expect(packageJson.scripts["operator:marketplace-people-metadata"])
      .toContain("marketplacePeopleMetadata.ts");
    expect(worker).toContain("--confirm-read-only-provider");
    expect(worker).toContain("createMarketplaceDatasetCatalogueClient");
    expect(worker).not.toContain("listDatasets(");
    expect(worker).not.toContain("MarketplaceFilterClient");
    expect(app).not.toContain("MarketplacePeopleMetadata");
    expect(openapi).not.toContain("marketplace-people-metadata");
  });

  it("keeps provider-capable workers stopped and reports one GET with zero billable POSTs", async () => {
    const activation = await readFile(activationUrl, "utf8");

    expect(activation).toContain("RUN_EXECUTOR_DRIVER=controlled");
    expect(activation).toContain("jobManager|outboxDispatcher");
    expect(activation).toContain("exactly 1 read-only metadata GET");
    expect(activation).toContain("Search/Filter/purchase/export POSTs: 0");
    expect(activation).not.toContain("Invoke-RestMethod");
    expect(activation).not.toContain("Invoke-WebRequest");
  });
});
