import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionContext, type SessionContextValue } from "../../session/SessionProvider";
import { OrganizationPanel } from "./OrganizationPanel";

const context: SessionContextValue = { session: { access_token: "unit", token_type: "Bearer", expires_in: 3600, csrf_token: "unit" }, identityEmail: "unit@example.test", isAuthenticated: true, signIn: vi.fn(), signUp: vi.fn(), refresh: vi.fn(), logout: vi.fn() };
afterEach(() => vi.unstubAllGlobals());
describe("mandatory organization onboarding", () => {
  it("opens the themed create-only dialog automatically after the membership list is empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ organizations: [] }), { headers: { "Content-Type": "application/json" } })));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SessionContext.Provider value={context}><MemoryRouter initialEntries={["/workspace/scrapers"]}><OrganizationPanel /></MemoryRouter></SessionContext.Provider></QueryClientProvider>);
    expect(await screen.findByRole("dialog", { name: "Create your organization" })).toBeInTheDocument();
    expect(screen.getByText(/organization is mandatory/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Join code")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Join organization" })).not.toBeInTheDocument();
    expect(screen.getByText(/Invitations and member activity.*next update/i)).toBeInTheDocument();
  });
});
