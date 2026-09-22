import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { BrightDataIntegrationClient } from
  "../../src/services/brightdata/brightDataIntegrationClient.js";
import {
  QualificationProviderRequestBudgetError,
  createQualificationProviderRequestBudgetClient,
} from "../../src/services/qualification/providerRequestBudgetClient.js";

function client(): BrightDataIntegrationClient {
  return {
    listScrapers: vi.fn(async () => []),
    submit: vi.fn(async () => ({
      kind: "inline" as const,
      bytes: Readable.from("[]"),
      contentType: "application/json",
      contentEncoding: null,
    })),
    trigger: vi.fn(async () => ({ snapshotReference: "sd_12345678" })),
    getProgress: vi.fn(async () => ({ status: "ready" as const })),
    getParts: vi.fn(async () => ({ parts: 1 })),
    download: vi.fn(async () => ({
      kind: "inline" as const,
      bytes: Readable.from("[]"),
      contentType: "application/json",
      contentEncoding: null,
    })),
    cancel: vi.fn(async () => undefined),
  };
}

describe("qualification provider request budget", () => {
  it("allows exactly the configured number of provider requests", async () => {
    const target = client();
    const budgeted = createQualificationProviderRequestBudgetClient(target, 1);
    const signal = new AbortController().signal;

    await expect(budgeted.submit({
      apiKey: "private-key",
      datasetId: "protected-provider-reference",
      targets: [{ url: "https://www.amazon.com/dp/B000000000" }],
      fixedQuery: { mode: "collect" },
      signal,
    })).resolves.toMatchObject({ kind: "inline" });

    await expect(budgeted.getProgress({
      apiKey: "private-key",
      snapshotReference: "sd_12345678",
      signal,
    })).rejects.toMatchObject({
      code: "QUALIFICATION_PROVIDER_REQUEST_BUDGET_EXHAUSTED",
    });
    expect(target.submit).toHaveBeenCalledOnce();
    expect(target.getProgress).not.toHaveBeenCalled();
  });

  it("rejects an invalid request budget", () => {
    expect(() => createQualificationProviderRequestBudgetClient(client(), 0)).toThrow(
      QualificationProviderRequestBudgetError,
    );
  });
});
