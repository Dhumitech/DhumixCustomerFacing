import type { FastifyRequest } from "fastify";
import { authenticationRequired } from "../services/identity/sessionErrors.js";
import type { TrustedTenantPrincipal } from "../services/tenantAccess/trustedTenantPrincipal.js";

/** Authenticate the browser session, then resolve its active Tenant access. */
export function requireTenantPrincipal(): (request: FastifyRequest) => Promise<void> {
  return async (request): Promise<void> => {
    const session = await request.server.browserAuthenticationService.authenticate(
      request.headers.authorization,
    );
    request.trustedSessionIdentity = session;
    const tenant = await request.server.tenantAuthorizationService.authorizeBrowserTenant(
      session, request.headers["x-dhumi-organization"],
    );
    request.trustedTenantIdentity = tenant;
    request.trustedTenantPrincipal = { kind: "browser", ...tenant };
  };
}

export function requireEstablishedTenantPrincipal(
  request: FastifyRequest,
): TrustedTenantPrincipal {
  if (request.trustedTenantPrincipal === null) throw authenticationRequired();
  return request.trustedTenantPrincipal;
}
