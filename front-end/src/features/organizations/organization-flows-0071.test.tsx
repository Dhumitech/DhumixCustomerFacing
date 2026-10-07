import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionContext, type SessionContextValue } from "../../session/SessionProvider";
import { tokenStore } from "../../session/tokenStore";
import { organizationsApi } from "../../api/organizations";
import { organizationHeaders, organizationPath, selectedOrganization } from "../../api/organizationScope";
import { OrganizationPanel } from "./OrganizationPanel";
import { VerificationPage, readVerificationFragment } from "./VerificationPage";

const orgA = "11111111-1111-4111-8111-111111111111", orgB = "22222222-2222-4222-8222-222222222222";
const verificationId = "33333333-3333-4333-8333-333333333333";
const authSession = { access_token: "unit-access", token_type: "Bearer" as const, expires_in: 3600, csrf_token: "unit-csrf-token-value" };
const context: SessionContextValue = { session: authSession, identityEmail: "unit@example.test", isAuthenticated: true, signUp: vi.fn(), signIn: vi.fn(), refresh: vi.fn(), logout: vi.fn() };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
function Probe() { const location = useLocation(); return <output aria-label="Route">{location.pathname + location.search}</output>; }
function show(component: React.ReactNode, initial = "/workspace/scrapers/amazon-com/example?tab=configuration") {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queries}><SessionContext.Provider value={context}><MemoryRouter initialEntries={[initial]}>{component}<Probe /></MemoryRouter></SessionContext.Provider></QueryClientProvider>);
}
beforeEach(() => { tokenStore.set(authSession, context.identityEmail!); window.history.replaceState(null, "", "/workspace/scrapers"); });
afterEach(() => { tokenStore.clear(); window.history.replaceState(null, "", "/"); vi.unstubAllGlobals(); });
describe("0071 browser organization flows", () => {
  it("reads selectors only from a validated URL and keeps tabs independent of storage", () => {
    sessionStorage.setItem("active-organization", orgB);
    window.history.replaceState(null, "", `/o/${orgA}/workspace/scrapers`);
    expect(selectedOrganization()).toBe(orgA); expect(organizationHeaders()).toEqual({ "X-Dhumi-Organization": orgA });
    expect(organizationPath("/workspace/runs?service=example")).toBe(`/o/${orgA}/workspace/runs?service=example`);
    expect(selectedOrganization("/o/not-a-uuid/workspace")).toBeNull();
    window.history.replaceState(null, "", `/o/${orgB}/workspace/usage`); expect(selectedOrganization()).toBe(orgB);
    sessionStorage.removeItem("active-organization");
  });
  it("creates a pending proof, confirms explicitly and resumes the same screen without a Service/Run request", async () => {
    const requests: Request[] = []; let confirmed = false;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async input => {
      const request = input as Request; requests.push(request); const path = new URL(request.url).pathname;
      if (path === "/v1/organizations" && request.method === "GET") return json({ organizations: confirmed ? [{ id: orgA, name: "Unit organization", state: "active", role: "admin" }] : [] });
      if (path === "/v1/organizations") return json({ accepted: true, verification_id: verificationId }, 202);
      confirmed = true; return json({ confirmed: true, organization_id: orgA });
    }));
    const user = userEvent.setup(); show(<OrganizationPanel />);
    await user.click(screen.getByRole("button", { name: "Organizations" }));
    await user.type(screen.getByLabelText("Organization name"), "Unit organization");
    await user.click(screen.getByRole("button", { name: "Create organization" }));
    expect(await screen.findByText(/No organization change has happened yet/)).toBeInTheDocument();
    expect(requests.filter(r => r.method === "POST")).toHaveLength(1);
    await user.type(screen.getByLabelText("Verification code"), "123456");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.getByLabelText("Route")).toHaveTextContent(`/o/${orgA}/workspace/scrapers/amazon-com/example?tab=configuration`));
    expect(requests.every(r => new URL(r.url).pathname === "/v1/organizations" || new URL(r.url).pathname.endsWith("/confirm"))).toBe(true);
    const mutation = requests.find(r => r.method === "POST")!;
    expect(mutation.headers.get("X-CSRF-Token")).toBe(authSession.csrf_token);
    expect(mutation.headers.get("Idempotency-Key")).toMatch(/^organization\./);
  });
  it("clears an email fragment and sends no proof until Confirm is pressed", async () => {
    const token = "t".repeat(43); window.history.replaceState(null, "", `/verify#verification_id=${verificationId}&email_link_token=${token}`);
    const fetcher = vi.fn<typeof fetch>(async () => json({ confirmed: true, organization_id: orgA })); vi.stubGlobal("fetch", fetcher);
    show(<VerificationPage />, "/verify");
    expect(window.location.hash).toBe(""); expect(fetcher).not.toHaveBeenCalled();
    expect(document.querySelector('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");
    await userEvent.setup().click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const request = fetcher.mock.calls[0]![0] as Request;
    expect(request.method).toBe("POST"); expect(await request.json()).toEqual({ email_link_token: token });
  });
  it("extracts invitation material without putting it in query strings or browser storage", () => {
    const token = "i".repeat(43); window.history.replaceState(null, "", `/invite#invite_token=${token}`);
    expect(readVerificationFragment().invite).toBe(token); expect(window.location.search).toBe(""); expect(window.location.hash).toBe("");
  });
  it("captures the organization before asynchronous request preparation", async () => {
    window.history.replaceState(null, "", `/o/${orgA}/workspace/members`);
    const fetcher = vi.fn<typeof fetch>(async () => json({ invite: { id: "unit" }, join_code: "unit-token" }, 201)); vi.stubGlobal("fetch", fetcher);
    const pending = organizationsApi.createInvite({ expires_at: "2027-01-01T00:00:00.000Z" });
    window.history.replaceState(null, "", `/o/${orgB}/workspace/members`); await pending;
    expect((fetcher.mock.calls[0]![0] as Request).headers.get("X-Dhumi-Organization")).toBe(orgA);
  });
  it("reuses a pending confirmation key after an uncertain transport response without storing credentials", async () => {
    const requests: Request[] = []; let attempts = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async input => { requests.push(input as Request); if (attempts++ === 0) throw new Error("unit network loss"); return json({ confirmed: true, sign_in_required: true }); }));
    const input = { code: "123456", new_password: "unit-sufficiently-long-password" };
    await expect(organizationsApi.confirm(verificationId, input)).rejects.toThrow();
    await organizationsApi.confirm(verificationId, input);
    expect(requests[0]!.headers.get("Idempotency-Key")).toBe(requests[1]!.headers.get("Idempotency-Key"));
    expect(Object.values(sessionStorage).join(" ")).not.toContain(input.new_password);
    expect(Object.values(localStorage).join(" ")).not.toContain(input.new_password);
  });
});
