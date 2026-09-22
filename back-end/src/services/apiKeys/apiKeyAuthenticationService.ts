import {
  apiKeyHashMatches,
  parseApiKeyCredential,
  type ApiScope,
} from "../../helpers/apiKeyMaterial.js";
import { authenticationRequired } from "../identity/sessionErrors.js";
import { accessDenied } from "../tenantAccess/tenantAccessErrors.js";
import type { ApiKeyAuthenticationRepository } from "./apiKeyAuthenticationRepository.js";

const BEARER_PATTERN = /^Bearer ([^\s]+)$/i;

export interface TrustedApiKeyIdentity {
  readonly kind: "api_key";
  readonly apiKeyId: string;
  readonly tenantId: string;
  readonly scopes: readonly ApiScope[];
}

export interface ApiKeyAuthenticationService {
  authenticate(authorization: string | undefined): Promise<TrustedApiKeyIdentity>;
}

export interface ApiKeyAuthenticationServiceDependencies {
  readonly repository: ApiKeyAuthenticationRepository;
}

export function createApiKeyAuthenticationService(
  dependencies: ApiKeyAuthenticationServiceDependencies,
): ApiKeyAuthenticationService {
  return {
    async authenticate(authorization): Promise<TrustedApiKeyIdentity> {
      const match = authorization === undefined ? null : BEARER_PATTERN.exec(authorization);
      const parsed = match?.[1] === undefined ? undefined : parseApiKeyCredential(match[1]);
      if (parsed === undefined) throw authenticationRequired();

      const candidate = await dependencies.repository.findVerifierCandidate(parsed.prefix);
      if (!apiKeyHashMatches(parsed.hash, candidate?.keyHash) || candidate === undefined) {
        throw authenticationRequired();
      }

      // Bind the locked lifecycle check to the exact verifier that passed the
      // constant-time comparison. A privileged repair or future migration
      // cannot replace key material between the two repository transactions
      // and let the superseded credential authenticate once.
      const outcome = await dependencies.repository.finalizeAuthentication({
        keyId: candidate.keyId,
        prefix: parsed.prefix,
        presentedHash: parsed.hash,
      });
      if (outcome.status === "credential_unavailable") throw authenticationRequired();
      if (outcome.status === "access_denied") throw accessDenied();
      return {
        kind: "api_key",
        apiKeyId: candidate.keyId,
        tenantId: outcome.tenantId,
        scopes: outcome.scopes,
      };
    },
  };
}
