import type { FastifyRequest } from "fastify";
import { authenticationRequired } from "../services/identity/sessionErrors.js";
import type { TrustedBrowsePrincipal } from "../services/tenantAccess/trustedBrowsePrincipal.js";

/** No organization lookup is needed to browse all-access templates. */
export async function requireBrowsePrincipal(request: FastifyRequest): Promise<void> {
  const session = await request.server.browserAuthenticationService.authenticate(
    request.headers.authorization,
  );
  request.trustedSessionIdentity = session;
  const selector = request.headers["x-dhumi-organization"];
  if (selector === undefined) {
    request.trustedBrowsePrincipal = { kind: "browser", ...session };
    return;
  }
  const organization = await request.server.tenantAuthorizationService.authorizeBrowserTenant(
    session,
    selector,
  );
  request.trustedBrowsePrincipal = { kind: "browser", ...organization };
}

export function requireEstablishedBrowsePrincipal(request: FastifyRequest): TrustedBrowsePrincipal {
  if (request.trustedBrowsePrincipal == null) throw authenticationRequired();
  return request.trustedBrowsePrincipal;
}
