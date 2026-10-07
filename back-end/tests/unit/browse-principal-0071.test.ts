import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  requireBrowsePrincipal,
  requireEstablishedBrowsePrincipal,
} from "../../src/middleware/browsePrincipal.js";
import { authenticationRequired } from "../../src/services/identity/sessionErrors.js";

const session = { userId: randomUUID(), sessionId: randomUUID() };
const org = randomUUID();
function request(selector?: string | string[]) {
  const authenticate = vi.fn(async () => session);
  const authorizeBrowserTenant = vi.fn(async (..._args: unknown[]) => ({
    ...session,
    tenantId: org,
  }));
  const value = {
    headers: { authorization: "Bearer fixture", "x-dhumi-organization": selector },
    server: {
      browserAuthenticationService: { authenticate },
      tenantAuthorizationService: { authorizeBrowserTenant },
    },
    trustedSessionIdentity: null,
    trustedTenantIdentity: null,
    trustedTenantPrincipal: null,
    trustedBrowsePrincipal: null,
  } as unknown as FastifyRequest;
  return { value, authenticate, authorizeBrowserTenant };
}
describe("0071 browse principal", () => {
  it("requires no membership lookup without a selector, irrespective of membership count", async () => {
    const r = request();
    r.authorizeBrowserTenant.mockRejectedValue(Error("Organization lookup must not run"));
    await requireBrowsePrincipal(r.value);
    expect(requireEstablishedBrowsePrincipal(r.value)).toEqual({ kind: "browser", ...session });
    expect(r.authorizeBrowserTenant).not.toHaveBeenCalled();
    expect(r.value.trustedTenantPrincipal).toBeNull();
  });
  it("uses independently authorized organization selection only when supplied", async () => {
    const r = request(org);
    await requireBrowsePrincipal(r.value);
    expect(r.authorizeBrowserTenant).toHaveBeenCalledWith(session, org);
    expect(requireEstablishedBrowsePrincipal(r.value)).toEqual({
      kind: "browser",
      ...session,
      tenantId: org,
    });
  });
  it("does not establish browse authority after invalid session authentication", async () => {
    const r = request();
    r.authenticate.mockRejectedValue(authenticationRequired());
    await expect(requireBrowsePrincipal(r.value)).rejects.toMatchObject({ status: 401 });
    expect(r.authorizeBrowserTenant).not.toHaveBeenCalled();
    expect(r.value.trustedBrowsePrincipal).toBeNull();
  });
  it("fails closed when a supplied selector is not authorized", async () => {
    const r = request(org);
    r.authorizeBrowserTenant.mockRejectedValue(Error("inaccessible organization"));
    await expect(requireBrowsePrincipal(r.value)).rejects.toThrow("inaccessible organization");
    expect(r.value.trustedBrowsePrincipal).toBeNull();
  });
  it("refuses access before middleware has established identity", () => {
    expect(() => requireEstablishedBrowsePrincipal(request().value)).toThrowError(
      expect.objectContaining({ status: 401 }),
    );
  });
});
