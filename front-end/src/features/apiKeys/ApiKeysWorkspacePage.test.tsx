import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SessionContext,
  type SessionContextValue,
} from "../../session/SessionProvider";
import { tokenStore } from "../../session/tokenStore";
import { ApiKeysWorkspacePage } from "./ApiKeysWorkspacePage";

const authSession = {
  access_token: "access-token",
  token_type: "Bearer" as const,
  expires_in: 3600,
  csrf_token: "csrf-token",
};

const session: SessionContextValue = {
  session: authSession,
  identityEmail: "customer@example.test",
  isAuthenticated: true,
  signUp: vi.fn(),
  signIn: vi.fn(),
  refresh: vi.fn(),
  logout: vi.fn(),
};

const existingKey = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Existing integration",
  prefix: "dhk_v1_existing",
  scopes: ["catalog:read"],
  state: "active",
  created_at: "2026-09-01T00:00:00.000Z",
  last_used_at: null,
  expires_at: null,
  revoked_at: null,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionContext.Provider value={session}>
        <ApiKeysWorkspacePage />
      </SessionContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  tokenStore.set(authSession, "customer@example.test");
});

afterEach(() => {
  tokenStore.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("API-key workspace", () => {
  it("lists metadata, creates a scoped key, and presents its secret once", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const request = input as Request;
      if (request.method === "POST") {
        return json(
          {
            ...existingKey,
            id: "22222222-2222-4222-8222-222222222222",
            name: "Reporting integration",
            prefix: "dhk_v1_reporting",
            scopes: ["usage:read"],
            secret: "dhk_v1_reporting.complete-secret",
          },
          201,
        );
      }
      return json({
        data: [existingKey],
        page: { next_cursor: null, has_more: false },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    expect(await screen.findByText("Existing integration")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Key name"), "Reporting integration");
    await user.click(screen.getByLabelText(/Read usage/));
    await user.click(screen.getByRole("button", { name: "Create API key" }));

    expect(
      await screen.findByText("dhk_v1_reporting.complete-secret"),
    ).toBeInTheDocument();
    const createRequest = fetchMock.mock.calls
      .map(([input]) => input as Request)
      .find((request) => request.method === "POST");
    expect(createRequest).toBeDefined();
    expect(await createRequest?.json()).toEqual({
      name: "Reporting integration",
      scopes: ["usage:read"],
    });
  });

  it("requires confirmation and calls the exact revoke endpoint", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const request = input as Request;
      if (request.method === "DELETE")
        return new Response(null, { status: 204 });
      return json({
        data: [existingKey],
        page: { next_cursor: null, has_more: false },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Existing integration");
    await user.click(screen.getByRole("button", { name: "Revoke key" }));
    await user.click(screen.getByRole("button", { name: "Confirm revoke" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => {
          const request = input as Request;
          return (
            request.method === "DELETE" &&
            new URL(request.url).pathname ===
              "/v1/keys/11111111-1111-4111-8111-111111111111"
          );
        }),
      ).toBe(true),
    );
  });
});
