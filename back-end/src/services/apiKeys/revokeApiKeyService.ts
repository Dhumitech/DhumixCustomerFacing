import type { CsrfService } from "../../helpers/csrf.js";
import type { TrustedTenantIdentity } from "../tenantAccess/tenantAuthorizationService.js";
import { csrfValidationFailed } from "../identity/sessionErrors.js";
import { apiKeyNotFound } from "./apiKeyErrors.js";
import type { RevokeApiKeyRepository } from "./revokeApiKeyRepository.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RevokeApiKeyRequest {
  readonly identity: TrustedTenantIdentity;
  readonly keyId: unknown;
  readonly csrfToken: string | undefined;
  readonly schemaErrors: readonly { readonly field: string; readonly message: string }[];
  readonly requestId: string | null;
  readonly ipFingerprint: Buffer | null;
}

export interface RevokeApiKeyService {
  revoke(request: RevokeApiKeyRequest): Promise<void>;
}

export interface RevokeApiKeyServiceDependencies {
  readonly repository: RevokeApiKeyRepository;
  readonly csrf: CsrfService;
}

function hasValidCsrf(
  csrf: CsrfService,
  sessionId: string,
  token: string | undefined,
): token is string {
  return (
    token !== undefined &&
    token.length >= 16 &&
    token.length <= 512 &&
    csrf.verify(sessionId, token)
  );
}

export function createRevokeApiKeyService(
  dependencies: RevokeApiKeyServiceDependencies,
): RevokeApiKeyService {
  return {
    async revoke(request): Promise<void> {
      if (!hasValidCsrf(dependencies.csrf, request.identity.sessionId, request.csrfToken)) {
        throw csrfValidationFailed();
      }
      if (
        request.schemaErrors.length > 0 ||
        typeof request.keyId !== "string" ||
        !UUID_PATTERN.test(request.keyId)
      ) {
        throw apiKeyNotFound();
      }

      const outcome = await dependencies.repository.revoke({
        tenantId: request.identity.tenantId,
        userId: request.identity.userId,
        keyId: request.keyId,
        requestId: request.requestId,
        ipFingerprint: request.ipFingerprint,
      });
      if (outcome === "not_found") {
        throw apiKeyNotFound();
      }
    },
  };
}
