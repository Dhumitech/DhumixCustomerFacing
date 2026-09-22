import type { CsrfService } from "../../helpers/csrf.js";
import type { TrustedSessionIdentity } from "./browserAuthenticationService.js";
import type { LogoutRepository } from "./logoutRepository.js";
import { authenticationRequired, csrfValidationFailed } from "./sessionErrors.js";

export interface LogoutRequest {
  readonly identity: TrustedSessionIdentity;
  readonly csrfToken: string | undefined;
  readonly requestId: string | null;
  readonly ipFingerprint: Buffer | null;
}

export interface LogoutService {
  logout(request: LogoutRequest): Promise<void>;
}

export interface LogoutServiceDependencies {
  readonly repository: LogoutRepository;
  readonly csrf: CsrfService;
}

export function createLogoutService(dependencies: LogoutServiceDependencies): LogoutService {
  const { repository, csrf } = dependencies;

  return {
    async logout(request): Promise<void> {
      if (
        request.csrfToken === undefined ||
        request.csrfToken.length < 16 ||
        request.csrfToken.length > 512 ||
        !csrf.verify(request.identity.sessionId, request.csrfToken)
      ) {
        throw csrfValidationFailed();
      }

      const outcome = await repository.revoke({
        userId: request.identity.userId,
        sessionId: request.identity.sessionId,
        issuedTenantId: request.identity.issuedTenantId,
        requestId: request.requestId,
        ipFingerprint: request.ipFingerprint,
      });
      if (outcome === "session_unavailable") {
        throw authenticationRequired();
      }
    },
  };
}
