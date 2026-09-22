import { afterEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "../session/tokenStore";
import { catalogueApi, servicesApi, workspaceApi } from "./customerReads";

const session = {
  access_token: "browser-access-token",
  token_type: "Bearer" as const,
  expires_in: 3600,
  csrf_token: "browser-csrf-token-value",
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function requestFrom(mock: ReturnType<typeof vi.fn>, index = 0): Request {
  return mock.mock.calls[index][0] as Request;
}

afterEach(() => {
  tokenStore.clear();
  vi.unstubAllGlobals();
});

describe("tenant-scoped customer reads", () => {
  it("reads the authenticated workspace through the shared client", async () => {
    tokenStore.set(session);
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        id: "workspace-1",
        name: "Acme Research",
        state: "active",
        created_at: "2026-09-04T00:00:00.000Z",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await workspaceApi.get();

    const request = requestFrom(fetchMock);
    expect(request.url).toBe("http://localhost:3000/v1/workspace");
    expect(request.method).toBe("GET");
    expect(request.credentials).toBe("include");
    expect(request.headers.get("Authorization")).toBe(
      "Bearer browser-access-token",
    );
  });

  it("lists only scraper-library templates with the contract maximum page size", async () => {
    tokenStore.set(session);
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [],
        page: { next_cursor: null, has_more: false },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await catalogueApi.listScraperLibrary();

    expect(requestFrom(fetchMock).url).toBe(
      "http://localhost:3000/v1/catalog/templates?family=scraper_library&limit=100",
    );
  });

  it("loads one published template by its public slug", async () => {
    tokenStore.set(session);
    const fetchMock = vi.fn(async () => jsonResponse({ slug: "amazon/item" }));
    vi.stubGlobal("fetch", fetchMock);

    await catalogueApi.getTemplate("amazon/item");

    expect(requestFrom(fetchMock).url).toBe(
      "http://localhost:3000/v1/catalog/templates/amazon%2Fitem",
    );
  });

  it("lists tenant-owned services with the contract maximum page size", async () => {
    tokenStore.set(session);
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [],
        page: { next_cursor: null, has_more: false },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await servicesApi.list();

    expect(requestFrom(fetchMock).url).toBe(
      "http://localhost:3000/v1/services?limit=100",
    );
  });
});
