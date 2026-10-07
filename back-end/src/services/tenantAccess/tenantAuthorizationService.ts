import type { TrustedSessionIdentity } from "../identity/browserAuthenticationService.js";
import type { TenantAuthorizationRepository } from "./tenantAuthorizationRepository.js";
import { ApplicationError } from "../../utils/applicationError.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Identity authorized for protected Tenant resources, not only session work. */
export interface TrustedTenantIdentity {
  readonly userId: string;
  readonly sessionId: string;
  readonly tenantId: string;
}

export interface TenantAuthorizationService {
  authorizeBrowserTenant(
    identity: TrustedSessionIdentity,
    organizationId?: string | string[],
  ): Promise<TrustedTenantIdentity>;
}

export interface TenantAuthorizationServiceDependencies {
  readonly repository: TenantAuthorizationRepository;
}

export function createTenantAuthorizationService(
  dependencies: TenantAuthorizationServiceDependencies,
): TenantAuthorizationService {
  return {
    async authorizeBrowserTenant(identity, organizationId): Promise<TrustedTenantIdentity> {
      if (
        organizationId !== undefined &&
        (typeof organizationId !== "string" || !UUID_PATTERN.test(organizationId))
      ) {
        throw new ApplicationError({
          status: 400,
          code: "BAD_REQUEST",
          title: "Invalid organization selector",
        });
      }
      const candidates = await dependencies.repository.findActiveTenantCandidates(
        identity.userId,
        organizationId?.toLowerCase(),
      );
      const candidate = candidates[0];

      // A request header selects a candidate; membership remains authoritative.
      if (
        organizationId !== undefined &&
        (candidates.length !== 1 || candidate?.tenantId !== organizationId.toLowerCase())
      ) {
        throw new ApplicationError({
          status: 404,
          code: "RESOURCE_NOT_FOUND",
          title: "Organization not found",
        });
      }
      if (candidates.length === 0 || candidate === undefined) {
        throw new ApplicationError({
          status: 403,
          code: "ORGANIZATION_MEMBERSHIP_REQUIRED",
          title: "Organization membership required",
        });
      }
      if (candidates.length !== 1) {
        throw new ApplicationError({
          status: 400,
          code: "ORGANIZATION_REQUIRED",
          title: "Select an organization",
        });
      }

      return {
        userId: identity.userId,
        sessionId: identity.sessionId,
        tenantId: candidate.tenantId,
      };
    },
  };
}
