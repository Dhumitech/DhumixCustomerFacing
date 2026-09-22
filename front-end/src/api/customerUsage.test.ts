import { afterEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "../session/tokenStore";
import { usageApi } from "./customerUsage";
import { platformStatusApi } from "./platformStatus";

const session = {
  access_token: "browser-access-token",
  token_type: "Bearer" as const,
  expires_in: 3600,
  csrf_token: "browser-csrf-token-value",
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function requestAt(mock: ReturnType<typeof vi.fn>, index = 0): Request {
  return mock.mock.calls[index][0] as Request;
}

afterEach(() => {
  tokenStore.clear();
  vi.unstubAllGlobals();
});

describe("customer usage and platform status API", () => {
  it("sends the exact authenticated usage-summary time window", async () => {
    tokenStore.set(session);
    const fetchMock = vi.fn(async () =>
      json({
        from: "2026-08-01T00:00:00.000Z",
        to: "2026-09-01T00:00:00.000Z",
        items: [],
        state: "observed",
        updated_at: "2026-09-01T00:00:00.000Z",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await usageApi.summary({
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-09-01T00:00:00.000Z",
    });

    const request = requestAt(fetchMock);
    const url = new URL(request.url);
    expect(url.pathname).toBe("/v1/usage/summary");
    expect(url.searchParams.get("from")).toBe("2026-08-01T00:00:00.000Z");
    expect(url.searchParams.get("to")).toBe("2026-09-01T00:00:00.000Z");
    expect(request.headers.get("Authorization")).toBe(
      "Bearer browser-access-token",
    );
  });

  it("preserves the usage-event cursor and maximum page size", async () => {
    tokenStore.set(session);
    const fetchMock = vi.fn(async () =>
      json({ data: [], page: { next_cursor: null, has_more: false } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await usageApi.events({
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-09-01T00:00:00.000Z",
      cursor: "opaque-cursor",
    });

    const url = new URL(requestAt(fetchMock).url);
    expect(url.pathname).toBe("/v1/usage/events");
    expect(url.searchParams.get("cursor")).toBe("opaque-cursor");
    expect(url.searchParams.get("limit")).toBe("100");
  });

  it("reads only the customer-safe public platform projection", async () => {
    const fetchMock = vi.fn(async () =>
      json({
        state: "operational",
        products: [],
        updated_at: "2026-09-01T00:00:00.000Z",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await platformStatusApi.get();

    const request = requestAt(fetchMock);
    expect(new URL(request.url).pathname).toBe("/v1/status");
    expect(request.method).toBe("GET");
  });
});
