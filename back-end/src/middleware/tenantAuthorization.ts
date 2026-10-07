import type { FastifyRequest } from "fastify";
import { authenticationRequired } from "../services/identity/sessionErrors.js";

/** Extends trusted session identity into current Tenant resource authority. */
export async function requireBrowserTenantAccess(request: FastifyRequest): Promise<void> {
  const identity = request.trustedSessionIdentity;
  if (identity === null) {
    // The route must run requireBrowserSession first. A wiring error still
    // fails closed rather than creating Tenant authority from request data.
    throw authenticationRequired();
  }

  request.trustedTenantIdentity =
    await request.server.tenantAuthorizationService.authorizeBrowserTenant(
      identity, request.headers["x-dhumi-organization"],
    );
}
