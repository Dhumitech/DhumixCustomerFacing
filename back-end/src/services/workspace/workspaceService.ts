import { accessDenied, workspaceUnavailable } from "../tenantAccess/tenantAccessErrors.js";
import type { TrustedTenantPrincipal } from "../tenantAccess/trustedTenantPrincipal.js";
import type { WorkspaceRecord, WorkspaceRepository } from "./workspaceRepository.js";

export interface WorkspaceService {
  getWorkspace(identity: TrustedTenantPrincipal): Promise<WorkspaceRecord>;
}

export interface WorkspaceServiceDependencies {
  readonly repository: WorkspaceRepository;
}

export function createWorkspaceService(
  dependencies: WorkspaceServiceDependencies,
): WorkspaceService {
  return {
    async getWorkspace(identity): Promise<WorkspaceRecord> {
      if (identity.kind !== "browser") throw accessDenied();
      const workspace = await dependencies.repository.findBrowserWorkspace({
        userId: identity.userId,
        tenantId: identity.tenantId,
      });
      if (workspace === undefined) {
        // RLS deliberately returns zero rows for an unavailable/cross-Tenant
        // resource. Treat that as authorization failure, not an empty success.
        throw workspaceUnavailable();
      }
      return workspace;
    },
  };
}
