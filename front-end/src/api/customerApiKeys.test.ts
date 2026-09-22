import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "../session/tokenStore";
import { apiKeysApi } from "./customerApiKeys";

const session = {
  access_token: "browser-access-token",
  token_type: "Bearer" as const,
  expires_in: 3600,
  csrf_token: "browser-csrf-token-value",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestAt(mock: ReturnType<typeof vi.fn>, index = 0): Request {
  return mock.mock.calls[index][0] as Request;
}

beforeEach(() => {
  tokenStore.set(session, "customer@example.test");
});

afterEach(() => {
  tokenStore.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("customer API-key management API", () => {
  it("lists key metadata without requesting any plaintext secret", async () => {
    const fetchMock = vi.fn(async () =>
      json({ data: [], page: { next_cursor: null, has_more: false } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await apiKeysApi.list("opaque-cursor");

    const request = requestAt(fetchMock);
    const url = new URL(request.url);
    expect(url.pathname).toBe("/v1/keys");
    expect(url.searchParams.get("cursor")).toBe("opaque-cursor");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(request.headers.get("Authorization")).toBe(
      "Bearer browser-access-token",
    );
  });

  it("creates a scoped key with CSRF and persistent mutation idempotency", async () => {
    const created = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Reporting",
      prefix: "dhk_v1_abcdefghijklmnop",
      scopes: ["usage:read"],
      state: "active",
      created_at: "2026-09-01T00:00:00.000Z",
      secret: "dhk_v1_abcdefghijklmnop.private-secret",
    };
    const fetchMock = vi.fn(async () => json(created, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      apiKeysApi.create({ name: "Reporting", scopes: ["usage:read"] }),
    ).resolves.toEqual(created);

    const request = requestAt(fetchMock);
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe("/v1/keys");
    expect(request.headers.get("X-CSRF-Token")).toBe(
      "browser-csrf-token-value",
    );
    expect(request.headers.get("Idempotency-Key")).toMatch(
      /^frontend\.api-key\.create\./,
    );
    expect(await request.json()).toEqual({
      name: "Reporting",
      scopes: ["usage:read"],
    });
  });

  it("revokes the selected key with browser CSRF protection", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiKeysApi.revoke("11111111-1111-4111-8111-111111111111");

    const request = requestAt(fetchMock);
    expect(request.method).toBe("DELETE");
    expect(new URL(request.url).pathname).toBe(
      "/v1/keys/11111111-1111-4111-8111-111111111111",
    );
    expect(request.headers.get("X-CSRF-Token")).toBe(
      "browser-csrf-token-value",
    );
  });
});
