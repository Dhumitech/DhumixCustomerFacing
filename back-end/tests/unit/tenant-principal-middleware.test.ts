import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { requireEstablishedTenantPrincipal, requireTenantPrincipal } from "../../src/middleware/tenantPrincipal.js";
import { authenticationRequired } from "../../src/services/identity/sessionErrors.js";
import { accessDenied } from "../../src/services/tenantAccess/tenantAccessErrors.js";
import type { BrowserAuthenticationService } from "../../src/services/identity/browserAuthenticationService.js";
import type { TenantAuthorizationService } from "../../src/services/tenantAccess/tenantAuthorizationService.js";

function request(options: {
  readonly authorization?: string;
  readonly resourceCalls: string[];
  readonly denyTenant?: boolean;
}): FastifyRequest {
  const tenantId = randomUUID();
  const session = { userId: randomUUID(), sessionId: randomUUID(), issuedTenantId: tenantId };
  const browserAuthenticationService: BrowserAuthenticationService = {
    async authenticate(authorization) {
      options.resourceCalls.push("browser-auth");
      if (authorization !== "Bearer valid-browser-token") throw authenticationRequired();
      return session;
    },
  };
  const tenantAuthorizationService: TenantAuthorizationService = {
    async authorizeBrowserTenant(identity) {
      options.resourceCalls.push("browser-tenant");
      expect(identity).toEqual(session);
      if (options.denyTenant) throw accessDenied();
      return { userId: identity.userId, sessionId: identity.sessionId, tenantId };
    },
  };
  return {
    headers: { authorization: options.authorization },
    server: {
      browserAuthenticationService,
      tenantAuthorizationService,
    },
    trustedSessionIdentity: null,
    trustedTenantIdentity: null,
    trustedTenantPrincipal: null,
  } as unknown as FastifyRequest;
}

describe("Tenant principal middleware", () => {
  it("establishes the session user only after active Tenant authorization", async () => {
    const calls: string[] = [];
    const current = request({
      authorization: "Bearer valid-browser-token",
      resourceCalls: calls,
    });

    await expect(requireTenantPrincipal()(current)).resolves.toBeUndefined();
    expect(current.trustedTenantPrincipal).toMatchObject({
      kind: "browser",
      userId: current.trustedSessionIdentity?.userId,
      sessionId: current.trustedSessionIdentity?.sessionId,
      tenantId: current.trustedTenantIdentity?.tenantId,
    });
    expect(requireEstablishedTenantPrincipal(current)).toEqual(current.trustedTenantPrincipal);
    expect(calls).toEqual(["browser-auth", "browser-tenant"]);
  });

  it.each([undefined, "Bearer dhk_v1_example", "Bearer dhk_v1_malformed", "Bearer invalid-session"])(
    "rejects %s before Tenant authorization", async (authorization) => {
      const calls: string[] = [];
      const current = request({ resourceCalls: calls, ...(authorization === undefined ? {} : { authorization }) });
      await expect(requireTenantPrincipal()(current)).rejects.toMatchObject({ status: 401, code: "AUTHENTICATION_REQUIRED" });
      expect(current.trustedTenantPrincipal).toBeNull();
      expect(current.trustedSessionIdentity).toBeNull();
      expect(current.trustedTenantIdentity).toBeNull();
      expect(calls).toEqual(["browser-auth"]);
    },
  );

  it("does not establish a principal for revoked or unavailable Tenant access", async () => {
    const calls: string[] = [];
    const current = request({
      authorization: "Bearer valid-browser-token",
      denyTenant: true,
      resourceCalls: calls,
    });

    await expect(requireTenantPrincipal()(current)).rejects.toMatchObject({
      status: 403,
      code: "ACCESS_DENIED",
    });
    expect(current.trustedTenantPrincipal).toBeNull();
    expect(current.trustedTenantIdentity).toBeNull();
    expect(calls).toEqual(["browser-auth", "browser-tenant"]);
  });

  it("refuses a controller lookup before middleware establishes its principal", () => {
    const current = request({ resourceCalls: [] });
    expect(() => requireEstablishedTenantPrincipal(current)).toThrowError(expect.objectContaining({ status: 401 }));
  });
});
