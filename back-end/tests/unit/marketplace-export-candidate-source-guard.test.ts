import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const workerUrl = new URL("../../src/worker/marketplaceExportCandidate.ts", import.meta.url);
const packageUrl = new URL("../../package.json", import.meta.url);
const activationUrl = new URL(
  "../privileged/marketplace-export-candidate/Apply-MarketplaceExportCandidateMigration.ps1",
  import.meta.url,
);
const verificationUrl = new URL(
  "../privileged/marketplace-export-candidate/Verify-MarketplaceExportCandidate.ps1",
  import.meta.url,
);

describe("M10 Marketplace export candidate operator boundary", () => {
  it("re-protects the reviewed Dataset identity without any provider transport", async () => {
    const worker = await readFile(workerUrl, "utf8");
    const packageJson = JSON.parse(await readFile(packageUrl, "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts["operator:marketplace-export-candidate"])
      .toContain("marketplaceExportCandidate.ts");
    expect(worker).toContain('process.env.RUN_EXECUTOR_DRIVER !== "controlled"');
    expect(worker).toContain("createMarketplaceExportCandidateService");
    expect(worker).not.toContain("createMarketplaceFilterClient");
    expect(worker).not.toContain("fetch(");
    expect(worker).not.toContain(".submit(");
    expect(worker).not.toContain("createRun");
  });

  it("keeps persistent activation and verification fail-closed and provider-free", async () => {
    const [activation, verification] = await Promise.all([
      readFile(activationUrl, "utf8"),
      readFile(verificationUrl, "utf8"),
    ]);

    expect(activation).toContain("RUN_EXECUTOR_DRIVER=controlled");
    expect(activation).toContain("0056_marketplace_export_candidate");
    expect(activation).toContain("app.service_versions");
    expect(activation).not.toContain("service.service_template_version_id");
    expect(activation).not.toContain("marketplaceFilterClient");
    expect(activation).not.toContain("Invoke-RestMethod");
    expect(activation).not.toContain("Invoke-WebRequest");
    expect(verification).toContain("customer_execution_enabled");
    expect(verification).toContain("template.current_public_version_id IS NULL");
    expect(verification).toContain("app.service_versions");
    expect(verification).not.toContain("service.service_template_version_id");
    expect(verification).toContain("= '$PacketId'::uuid");
    expect(verification).toContain("= '$MappingId'::uuid");
    expect(verification).toContain("SELECT count(*) = 1 FROM app.audit_events");
    expect(verification).toContain("audit.outcome = 'registered'");
    expect(verification).not.toContain("SET ROLE dhumi_owner");
    expect(verification).not.toContain(":'packet_id'");
    expect(verification).not.toContain(":'mapping_id'");
    expect(verification).not.toContain("Invoke-RestMethod");
    expect(verification).not.toContain("Invoke-WebRequest");
  });
});
