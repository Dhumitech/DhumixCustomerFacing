import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runScraperContractCommand } from "../../src/worker/scraperContract.js";
import { prepareScraperDraft, runScraperOnboardCommand } from "../../src/worker/scraperOnboard.js";
describe("offline scraper onboarding", () => {
  it.each(["target", "lowes", "homedepot", "etsy", "walmart"])("validates %s without a database or network capability", async (name) => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network must not be used"));
    try {
      const report = await runScraperContractCommand(["validate", "--package",
        fileURLToPath(new URL(`../fixtures/scraper-operations/${name}.json`, import.meta.url))]);
      expect(report).toMatchObject({ operationCode: `${name}.products.collect_by_url`, compiledValidators: 2,
        providerCalls: 0, databaseWrites: 0, customerPublication: false });
      expect(report.contractHash).toMatch(/^[a-f0-9]{64}$/);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
  it.each([[], ["publish"], ["validate", "--package", "fixture", "--execute"], ["validate", "--url", "https://api.brightdata.com"]])(
    "does not accept execution, publication or endpoint overrides", async (...args) => {
      await expect(runScraperContractCommand(args)).rejects.toThrow(/Usage:/);
  });
  it("explains a missing package without opening a database or printing file contents", async () => {
    await expect(runScraperContractCommand(["validate", "--package", join(tmpdir(), `${randomUUID()}.json`)]))
      .rejects.toThrow(/Package file was not found/);
  });
  it("refuses to register a passing fixture as a reviewed operation", async () => {
    await expect(prepareScraperDraft(fileURLToPath(new URL("../fixtures/scraper-operations/target.json", import.meta.url))))
      .rejects.toThrow(/Fixture-only packages cannot be registered/);
  });
  it("prepares a synthetic reviewed candidate for private draft staging only", async () => {
    const packet = JSON.parse(await readFile(fileURLToPath(new URL("../fixtures/scraper-operations/target.json", import.meta.url)), "utf8"));
    packet.status = "reviewed_candidate";
    packet.evidence.kind = "reviewed_provider_contract";
    packet.presentation = {
      slug: "synthetic-target-products", publicName: "Synthetic Target products",
      publicDescription: "Offline parser test, not an approved provider offer.",
      availabilityCopy: "Qualification pending",
      configurationSchema: { type: "object", additionalProperties: false, properties: {} },
      metadata: { domain_slug: "synthetic-target-com", domain_name: "Synthetic Target",
        category: "e-commerce", icon_key: "synthetic-target", operation_group: "Products",
        operation_name: "Collect by URL", display_priority: 100 },
    };
    const path = join(tmpdir(), `dhumi-synthetic-scraper-${randomUUID()}.json`);
    try {
      await writeFile(path, JSON.stringify(packet), { flag: "wx" });
      const draft = await prepareScraperDraft(path);
      expect(draft).toMatchObject({ operationCode: "target.products.collect_by_url",
        slug: "synthetic-target-products", availabilityCopy: "Qualification pending" });
      expect(draft.packageSha256).toMatch(/^[a-f0-9]{64}$/);
    } finally { await unlink(path); }
  });
  it("requires an explicit database identity and draft confirmation before onboarding", async () => {
    await expect(runScraperOnboardCommand(["stage", "--package", "target.json"]))
      .rejects.toThrow(/Missing or invalid onboarding options/);
  });
});
