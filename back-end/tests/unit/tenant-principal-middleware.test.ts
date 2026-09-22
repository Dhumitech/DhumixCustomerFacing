import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { requireTenantPrincipal } from "../../src/middleware/tenantPrincipal.js";
import type { ApiKeyAuthenticationService } from "../../src/services/apiKeys/apiKeyAuthenticationService.js";
import type { BrowserAuthenticationService } from "../../src/services/identity/browserAuthenticationService.js";
import type { TenantAuthorizationService } from "../../src/services/tenantAccess/tenantAuthorizationService.js";

function request(options: {
  readonly authorization: string;
  readonly scopes: readonly ("catalog:read" | "runs:read")[];
  readonly resourceCalls: string[];
}): FastifyRequest {
  const tenantId = randomUUID();
  const apiKeyAuthenticationService: ApiKeyAuthenticationService = {
    async authenticate() {
      options.resourceCalls.push("api-key-auth");
      return {
        kind: "api_key",
        apiKeyId: randomUUID(),
        tenantId,
        scopes: options.scopes,
      };
    },
  };
  const browserAuthenticationService: BrowserAuthenticationService = {
    async authenticate() {
      options.resourceCalls.push("browser-auth");
      throw new Error("browser authentication was not expected");
    },
  };
  const tenantAuthorizationService: TenantAuthorizationService = {
    async authorizeBrowserTenant() {
      options.resourceCalls.push("browser-tenant");
      throw new Error("browser Tenant authorization was not expected");
    },
  };
  return {
    headers: { authorization: options.authorization },
    server: {
      apiKeyAuthenticationService,
      browserAuthenticationService,
      tenantAuthorizationService,
    },
    trustedSessionIdentity: null,
    trustedTenantIdentity: null,
    trustedTenantPrincipal: null,
  } as unknown as FastifyRequest;
}

describe("Tenant principal middleware", () => {
  it("accepts a key with the route-required scope", async () => {
    const calls: string[] = [];
    const current = request({
      authorization: "Bearer dhk_v1_example",
      scopes: ["catalog:read", "runs:read"],
      resourceCalls: calls,
    });

    await expect(requireTenantPrincipal("runs:read")(current)).resolves.toBeUndefined();
    expect(current.trustedTenantPrincipal).toMatchObject({
      kind: "api_key",
      scopes: ["catalog:read", "runs:read"],
    });
    expect(calls).toEqual(["api-key-auth"]);
  });

  it("denies a missing scope before trusted request context is established", async () => {
    const calls: string[] = [];
    const current = request({
      authorization: "Bearer dhk_v1_example",
      scopes: ["catalog:read"],
      resourceCalls: calls,
    });

    await expect(requireTenantPrincipal("runs:read")(current)).rejects.toMatchObject({
      status: 403,
      code: "ACCESS_DENIED",
    });
    expect(current.trustedTenantPrincipal).toBeNull();
    expect(calls).toEqual(["api-key-auth"]);
  });
});
