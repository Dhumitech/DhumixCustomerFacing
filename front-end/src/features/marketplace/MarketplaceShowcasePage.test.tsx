import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../../app/App";
import {
  SessionContext,
  type SessionContextValue,
} from "../../session/SessionProvider";
import { tokenStore } from "../../session/tokenStore";

const organizationId = "11111111-1111-4111-8111-111111111111";
const authSession = {
  access_token: "demo-test-session",
  token_type: "Bearer" as const,
  expires_in: 3600,
  csrf_token: "demo-test-csrf",
};
const session: SessionContextValue = {
  session: authSession,
  identityEmail: "demo@example.test",
  isAuthenticated: true,
  signUp: vi.fn(),
  signIn: vi.fn(),
  refresh: vi.fn(),
  logout: vi.fn(),
};

beforeEach(() => {
  localStorage.clear();
  tokenStore.set(authSession, "demo@example.test");
});
afterEach(() => {
  tokenStore.clear();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("demo Marketplace showcase", () => {
  it.each(["", "/linkedin-posts", "/linkedin-people", "/groups/linkedin"])(
    "keeps %s presentation-only without calling dataset or sample endpoints",
    async (suffix) => {
      const requests: Request[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (request: Request) => {
          requests.push(request);
          const path = new URL(request.url).pathname;
          const body =
            path === "/v1/organizations"
              ? {
                  can_create: false,
                  organizations: [
                    {
                      id: organizationId,
                      name: "Demo workspace",
                      state: "active",
                      role: "admin",
                      is_creator: true,
                    },
                  ],
                }
              : path === "/v1/workspace"
                ? {
                    id: organizationId,
                    name: "Demo workspace",
                    state: "active",
                  }
                : {};
          return new Response(JSON.stringify(body), {
            headers: { "Content-Type": "application/json" },
          });
        }),
      );
      render(
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <SessionContext.Provider value={session}>
            <MemoryRouter
              initialEntries={[
                `/o/${organizationId}/workspace/marketplace${suffix}`,
              ]}
            >
              <AppRoutes isAuthenticated initialAuthMode={null} />
            </MemoryRouter>
          </SessionContext.Provider>
        </QueryClientProvider>,
      );
      const showcase = await screen.findByRole("region", {
        name: "Dataset Marketplace",
      });
      expect(
        within(showcase).getByRole("heading", { name: "LinkedIn People" }),
      ).toBeInTheDocument();
      expect(
        within(showcase).getByRole("heading", { name: "LinkedIn Posts" }),
      ).toBeInTheDocument();
      expect(within(showcase).getAllByText("Coming soon")).toHaveLength(2);
      expect(within(showcase).queryByRole("button")).not.toBeInTheDocument();
      expect(within(showcase).queryByRole("link")).not.toBeInTheDocument();
      expect(screen.getByText("Marketplace coming soon")).toBeInTheDocument();
      await waitFor(() =>
        expect(
          screen.getByRole("heading", { name: "Demo workspace" }),
        ).toBeInTheDocument(),
      );
      expect(requests.length).toBeGreaterThan(0);
      expect(
        requests.every(
          (request) =>
            request.method === "GET" &&
            ["/v1/organizations", "/v1/workspace"].includes(
              new URL(request.url).pathname,
            ),
        ),
      ).toBe(true);
    },
  );
});
