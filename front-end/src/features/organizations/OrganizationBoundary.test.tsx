import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionContext, type SessionContextValue } from "../../session/SessionProvider";
import { OrganizationBoundary } from "./OrganizationBoundary";
import { useServicesQuery } from "../workspace/workspaceQueries";
import { preferenceUserId, rememberOrganization, rememberedOrganization } from "./organizationPreference";

const orgA = "11111111-1111-4111-8111-111111111111", orgB = "22222222-2222-4222-8222-222222222222", userId = "33333333-3333-4333-8333-333333333333";
const token = `e30.${btoa(JSON.stringify({ sub: userId }))}.unit`;
const context: SessionContextValue = { session: { access_token: token, token_type: "Bearer", expires_in: 3600, csrf_token: "unit" }, identityEmail: "unit@example.test", isAuthenticated: true, signIn: vi.fn(), signUp: vi.fn(), refresh: vi.fn(), logout: vi.fn() };
function Child() { const location = useLocation(); const services = useServicesQuery(); return <output aria-label="Organization route">{location.pathname} {services.isSuccess ? "loaded" : "pending"}</output>; }
function show(path = "/workspace/scrapers") { render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SessionContext.Provider value={context}><MemoryRouter initialEntries={[path]}><OrganizationBoundary><Child /></OrganizationBoundary></MemoryRouter></SessionContext.Provider></QueryClientProvider>); }
beforeEach(() => { localStorage.clear(); window.history.replaceState(null, "", "/workspace/scrapers"); });
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });
function backend(ids: string[]) {
  const requests: Request[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: Request) => {
    requests.push(input); const path = new URL(input.url).pathname;
    return new Response(JSON.stringify(path === "/v1/organizations" ? { can_create: false, organizations: ids.map(id => ({ id, name: id === orgA ? "Team A" : "Team B", state: "active", role: "member", is_creator: false })) } : { data: [], page: { has_more: false, next_cursor: null } }), { headers: { "Content-Type": "application/json" } });
  })); return requests;
}
describe("organization entry and captured query scope", () => {
  it("uses the remembered active membership before saved-scraper queries run", async () => {
    rememberOrganization(userId, orgB); const requests = backend([orgA, orgB]); show();
    await waitFor(() => expect(screen.getByLabelText("Organization route")).toHaveTextContent(`/o/${orgB}/workspace/scrapers loaded`));
    const reads = requests.filter(r => new URL(r.url).pathname === "/v1/services");
    expect(reads).toHaveLength(1); expect(reads[0].headers.get("X-Dhumi-Organization")).toBe(orgB);
  });
  it("ignores a removed preference and an unauthorized deep link", async () => {
    rememberOrganization(userId, orgB); const requests = backend([orgA]); show(`/o/${orgB}/workspace/runs`);
    await waitFor(() => expect(screen.getByLabelText("Organization route")).toHaveTextContent(`/o/${orgA}/workspace/scrapers loaded`));
    expect(requests.filter(r => new URL(r.url).pathname === "/v1/services").every(r => r.headers.get("X-Dhumi-Organization") === orgA)).toBe(true);
    expect(rememberedOrganization(userId)).toBe(orgA);
  });
  it("keeps new accounts behind creation without requesting saved scrapers", async () => {
    const requests = backend([]); show(); expect(await screen.findByRole("dialog", { name: "Create your organization" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Organization route")).not.toBeInTheDocument();
    expect(requests.some(r => new URL(r.url).pathname === "/v1/services")).toBe(false);
  });
  it("stores only a UUID preference in a per-user namespace", () => {
    expect(preferenceUserId(token)).toBe(userId); expect(preferenceUserId("malformed")).toBeNull();
    rememberOrganization(userId, orgA); expect(rememberedOrganization(orgB)).toBeNull();
    expect(Object.values(localStorage)).toEqual([orgA]);
    expect(Object.values(localStorage).join("")).not.toContain(token);
  });
});
