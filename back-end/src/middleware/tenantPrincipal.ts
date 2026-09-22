import type { FastifyRequest } from "fastify";
import type { ApiScope } from "../helpers/apiKeyMaterial.js";
import { authenticationRequired } from "../services/identity/sessionErrors.js";
import { accessDenied } from "../services/tenantAccess/tenantAccessErrors.js";
import {
  principalHasScope,
  type TrustedTenantPrincipal,
} from "../services/tenantAccess/trustedTenantPrincipal.js";

const BEARER_VALUE_PATTERN = /^Bearer (.+)$/i;
const API_KEY_NAMESPACE = "dhk_v1_";

function selectsApiKeyAuthentication(authorization: string | undefined): boolean {
  const value = authorization === undefined ? undefined : BEARER_VALUE_PATTERN.exec(authorization)?.[1];
  return value?.startsWith(API_KEY_NAMESPACE) === true;
}

/** Establishes exactly one Tenant principal and optionally enforces an API-key scope. */
export function requireTenantPrincipal(
  requiredScope?: ApiScope,
): (request: FastifyRequest) => Promise<void> {
  return async (request): Promise<void> => {
    let principal: TrustedTenantPrincipal;
    if (selectsApiKeyAuthentication(request.headers.authorization)) {
      principal = await request.server.apiKeyAuthenticationService.authenticate(
        request.headers.authorization,
      );
    } else {
      const session = await request.server.browserAuthenticationService.authenticate(
        request.headers.authorization,
      );
      request.trustedSessionIdentity = session;
      const tenant = await request.server.tenantAuthorizationService.authorizeBrowserTenant(session);
      request.trustedTenantIdentity = tenant;
      principal = { kind: "browser", ...tenant };
    }

    if (requiredScope !== undefined && !principalHasScope(principal, requiredScope)) {
      throw accessDenied();
    }
    request.trustedTenantPrincipal = principal;
  };
}

export function requireEstablishedTenantPrincipal(
  request: FastifyRequest,
): TrustedTenantPrincipal {
  if (request.trustedTenantPrincipal === null) throw authenticationRequired();
  return request.trustedTenantPrincipal;
}
