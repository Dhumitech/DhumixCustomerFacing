import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "../session/tokenStore";
import { marketplaceApi } from "./marketplace";

const session = {
  access_token: "browser-access-token",
  token_type: "Bearer" as const,
  expires_in: 3600,
  csrf_token: "browser-csrf-token-value",
};
const projection = {
  expected_sample_version: 1,
  selected_fields: ["title"],
  filter: { operator: "and" as const, filters: [] },
};

beforeEach(() => { window.history.replaceState(null, "", "/o/11111111-1111-4111-8111-111111111111/workspace/scrapers"); });

afterEach(() => {
  window.history.replaceState(null, "", "/");
  tokenStore.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("browser Marketplace actions", () => {
  it.each(["query", "download", "enquiry"] as const)(
    "sends the browser session and required CSRF for %s",
    async (operation) => {
      tokenStore.set(session);
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        new Response("{}", {
          status: operation === "query" ? 200 : 201,
          headers: { "Content-Type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      if (operation === "query")
        await marketplaceApi.querySample("fixture-sample", {
          ...projection,
          page: { limit: 10 },
        });
      else if (operation === "download")
        await marketplaceApi.authorizeSampleDownload("fixture-sample", {
          ...projection,
          format: "json",
          record_limit: 10,
        });
      else
        await marketplaceApi.createExpertEnquiry("fixture-sample", {
          expected_template_version: 1,
        });
      const request = fetchMock.mock.calls[0]?.[0] as Request;
      expect(request.headers.get("Authorization")).toBe(
        `Bearer ${session.access_token}`,
      );
      expect(request.headers.get("X-CSRF-Token")).toBe(session.csrf_token);
      if (operation !== "query")
        expect(request.headers.get("Idempotency-Key")).toMatch(
          /^frontend\.marketplace\./,
        );
      expect(request.url).not.toContain("/v1/keys");
    },
  );

  it("does not send a query when the browser session is absent", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      marketplaceApi.querySample("fixture-sample", {
        ...projection,
        page: { limit: 10 },
      }),
    ).rejects.toThrow("An authenticated browser session is required.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
