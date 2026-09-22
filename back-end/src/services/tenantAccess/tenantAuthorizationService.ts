import type { TrustedSessionIdentity } from "../identity/browserAuthenticationService.js";
import type { TenantAuthorizationRepository } from "./tenantAuthorizationRepository.js";
import { workspaceUnavailable } from "./tenantAccessErrors.js";

/** Identity authorized for protected Tenant resources, not only session work. */
export interface TrustedTenantIdentity {
  readonly userId: string;
  readonly sessionId: string;
  readonly tenantId: string;
}

export interface TenantAuthorizationService {
  authorizeBrowserTenant(identity: TrustedSessionIdentity): Promise<TrustedTenantIdentity>;
}

export interface TenantAuthorizationServiceDependencies {
  readonly repository: TenantAuthorizationRepository;
}

export function createTenantAuthorizationService(
  dependencies: TenantAuthorizationServiceDependencies,
): TenantAuthorizationService {
  return {
    async authorizeBrowserTenant(identity): Promise<TrustedTenantIdentity> {
      const candidates = await dependencies.repository.findActiveTenantCandidates(
        identity.userId,
      );
      const candidate = candidates[0];

      // The demo resolves exactly one owner workspace. Selecting one of several
      // active rows, or trusting the token's issuance claim without this lookup,
      // would silently authorize an ambiguous or stale Tenant relationship.
      if (
        candidates.length !== 1 ||
        candidate === undefined ||
        candidate.tenantId !== identity.issuedTenantId
      ) {
        throw workspaceUnavailable();
      }

      return {
        userId: identity.userId,
        sessionId: identity.sessionId,
        tenantId: candidate.tenantId,
      };
    },
  };
}
