import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("LinkedIn People synthetic sample operator boundary", () => {
  it("reads retained evidence and cannot construct a provider client", async () => {
    const worker = await readFile(new URL(
      "../../src/worker/marketplacePeopleSample.ts",
      import.meta.url,
    ), "utf8");
    const packageJson = JSON.parse(await readFile(
      new URL("../../package.json", import.meta.url),
      "utf8",
    )) as { scripts: Record<string, string> };

    expect(packageJson.scripts["operator:marketplace-people-sample"])
      .toContain("marketplacePeopleSample.ts");
    expect(worker).toContain("createConfiguredQualificationEvidenceReader");
    expect(worker).toContain("createConfiguredMarketplaceSampleStore");
    expect(worker).not.toContain("createMarketplaceDatasetCatalogueClient");
    expect(worker).not.toContain("createMarketplaceFilterClient");
    expect(worker).not.toContain("BRIGHTDATA_API_KEY");
    expect(worker).not.toContain("fetch(");
  });
});
