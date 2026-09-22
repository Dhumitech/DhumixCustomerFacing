import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const workerUrl = new URL("../../src/worker/marketplaceQualification.ts", import.meta.url);
const packageUrl = new URL("../../package.json", import.meta.url);

describe("M9 Marketplace live qualification operator boundary", () => {
  it("requires controlled customer execution and one exact authorized packet", async () => {
    const worker = await readFile(workerUrl, "utf8");
    const packageJson = JSON.parse(await readFile(packageUrl, "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts["operator:marketplace-qualification"])
      .toContain("marketplaceQualification.ts");
    expect(worker).toContain('process.env.RUN_EXECUTOR_DRIVER !== "controlled"');
    expect(worker).toContain("--confirm-exact-authorized-packet");
    expect(worker).toContain("createMarketplaceQualificationExecutionRepository");
    expect(worker).toContain("createMarketplaceFilterClient");
    expect(worker).not.toContain("createRun");
    expect(worker).not.toContain("provider_mappings");
  });
});
