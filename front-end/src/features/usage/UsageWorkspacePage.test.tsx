import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SessionContext,
  type SessionContextValue,
} from "../../session/SessionProvider";
import { tokenStore } from "../../session/tokenStore";
import { UsageWorkspacePage } from "./UsageWorkspacePage";

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

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionContext.Provider value={session}>
        <MemoryRouter initialEntries={[window.location.pathname]}><UsageWorkspacePage /></MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.history.replaceState(null, "", "/o/11111111-1111-4111-8111-111111111111/workspace/runs");
  tokenStore.set(authSession, "customer@example.test");
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
  tokenStore.clear();
  vi.unstubAllGlobals();
});

describe("Usage workspace", () => {
  it("renders informational totals and Run-traceable usage events", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL((input as Request).url).pathname;
      if (path === "/v1/usage/summary") {
        return json({
          from: "2026-08-01T00:00:00.000Z",
          to: "2026-09-01T00:00:00.000Z",
          items: [
            {
              meter: "amazon.result_records.observed",
              quantity: 2,
              unit: "records",
            },
          ],
          state: "observed",
          updated_at: "2026-09-01T00:00:00.000Z",
        });
      }
      return json({
        data: [
          {
            id: "event-1",
            run_id: "11111111-1111-4111-8111-111111111111",
            product_family: "scraper_library",
            meter: "amazon.result_records.observed",
            quantity: 2,
            unit: "records",
            outcome: "succeeded",
            observed_at: "2026-09-01T00:00:00.000Z",
          },
        ],
        page: { next_cursor: null, has_more: false },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    expect(
      await screen.findByRole("heading", { name: "Usage" }),
    ).toBeInTheDocument();
    expect(await screen.findAllByText("2")).not.toHaveLength(0);
    expect(screen.getByText("records")).toBeInTheDocument();
    expect(screen.getByText("11111111")).toBeInTheDocument();
    expect(
      screen.getByText(/not a bill or customer quota/i),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([input]) =>
          new URL((input as Request).url).pathname === "/v1/usage/summary",
      ),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(
        ([input]) =>
          new URL((input as Request).url).pathname === "/v1/usage/events",
      ),
    ).toBe(true);
  });

  it("requests a new bounded window when the customer changes the period", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL((input as Request).url).pathname;
      if (path.endsWith("/summary")) {
        return json({
          from: "2026-08-01T00:00:00.000Z",
          to: "2026-09-01T00:00:00.000Z",
          items: [],
          state: "observed",
          updated_at: "2026-09-01T00:00:00.000Z",
        });
      }
      return json({ data: [], page: { next_cursor: null, has_more: false } });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    await screen.findByText("None yet");
    const initialCount = fetchMock.mock.calls.length;

    await user.selectOptions(screen.getByLabelText("Usage period"), "90");

    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThan(initialCount),
    );
  });
});
