import { afterEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "../session/tokenStore";
import { runsApi, serviceExecutionApi } from "./customerRuns";
import { usageApi } from "./customerUsage";
import { marketplaceApi } from "./marketplace";

const selected = "11111111-1111-4111-8111-111111111111";
const destination = "22222222-2222-4222-8222-222222222222";
afterEach(() => {
  tokenStore.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("captured organization request scope", () => {
  it("keeps Run, usage and Marketplace reads bound to the query's organization after navigation", async () => {
    window.history.replaceState(null, "", `/o/${destination}/workspace/runs`);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        new Response("{}", { headers: { "Content-Type": "application/json" } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await runsApi.events("run-id", selected);
    await usageApi.summary(
      { from: "2026-10-01T00:00:00Z", to: "2026-10-08T00:00:00Z" },
      selected,
    );
    await marketplaceApi.getSample("sample-template", undefined, selected);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [request] of fetchMock.mock.calls)
      expect((request as Request).headers.get("X-Dhumi-Organization")).toBe(
        selected,
      );
  });

  it("captures mutation scope before asynchronous idempotency work", async () => {
    window.history.replaceState(null, "", `/o/${selected}/workspace/scrapers`);
    tokenStore.set({
      access_token: "browser-token",
      token_type: "Bearer",
      expires_in: 900,
      csrf_token: "csrf",
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("{}", {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const pending = serviceExecutionApi.create(
      { templateSlug: "example", name: "Saved scraper", configuration: {} },
      selected,
    );
    window.history.replaceState(
      null,
      "",
      `/o/${destination}/workspace/scrapers`,
    );
    await pending;
    expect(
      (fetchMock.mock.calls[0]?.[0] as Request).headers.get(
        "X-Dhumi-Organization",
      ),
    ).toBe(selected);
  });
});
