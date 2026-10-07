import type { AccessTokenService } from "../../helpers/accessToken.js";
import type { BrowserAuthenticationRepository } from "./browserAuthenticationRepository.js";
import { authenticationRequired } from "./sessionErrors.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BEARER_PATTERN = /^Bearer ([^\s]+)$/i;

/**
 * Identity trusted only for operations on the current browser session.
 * Organization authority is resolved separately for each request.
 */
export interface TrustedSessionIdentity {
  readonly userId: string;
  readonly sessionId: string;
}

export interface BrowserAuthenticationService {
  authenticate(authorization: string | undefined): Promise<TrustedSessionIdentity>;
}

export interface BrowserAuthenticationServiceDependencies {
  readonly accessTokens: AccessTokenService;
  readonly repository: BrowserAuthenticationRepository;
}

function allClaimsAreUuids(identity: TrustedSessionIdentity): boolean {
  return (
    UUID_PATTERN.test(identity.userId) &&
    UUID_PATTERN.test(identity.sessionId)
  );
}

export function createBrowserAuthenticationService(
  dependencies: BrowserAuthenticationServiceDependencies,
): BrowserAuthenticationService {
  const { accessTokens, repository } = dependencies;

  return {
    async authenticate(authorization): Promise<TrustedSessionIdentity> {
      const match = authorization === undefined ? null : BEARER_PATTERN.exec(authorization);
      if (match?.[1] === undefined) {
        throw authenticationRequired();
      }

      const claims = await accessTokens.verify(match[1]);
      if (claims === undefined) {
        throw authenticationRequired();
      }

      const identity: TrustedSessionIdentity = {
        userId: claims.userId,
        sessionId: claims.sessionId,
      };
      if (!allClaimsAreUuids(identity)) {
        throw authenticationRequired();
      }

      if (
        !(await repository.hasActiveSession({
          userId: identity.userId,
          sessionId: identity.sessionId,
        }))
      ) {
        throw authenticationRequired();
      }

      return identity;
    },
  };
}
