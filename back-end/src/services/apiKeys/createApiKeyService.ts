import { randomUUID } from "node:crypto";
import {
  apiKeyActorFingerprint,
  apiKeyEnvelopeAad,
  apiKeyRequestHash,
  canonicalizeApiKeyCreate,
  parseApiKeyCreated,
  serializeApiKeyCreated,
  type ApiKeyCreateBody,
  type ApiKeyCreated,
} from "../../helpers/apiKeyCanonicalization.js";
import { createApiKeyMaterial, type ApiKeyMaterial } from "../../helpers/apiKeyMaterial.js";
import type { CsrfService } from "../../helpers/csrf.js";
import type { ResponseEnvelope } from "../../helpers/responseEnvelope.js";
import { csrfValidationFailed } from "../identity/sessionErrors.js";
import type { TrustedTenantIdentity } from "../tenantAccess/tenantAuthorizationService.js";
import {
  apiKeyIdempotencyConflict,
  apiKeyReplayExpired,
  apiKeyValidationFailed,
  responseEnvelopeUnavailable,
} from "./apiKeyErrors.js";
import {
  ApiKeyMaterialCollisionError,
  type CreateApiKeyRepository,
} from "./createApiKeyRepository.js";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;
const MAX_MATERIAL_ATTEMPTS = 3;

export interface CreateApiKeyRequest {
  readonly identity: TrustedTenantIdentity;
  readonly csrfToken: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly body: ApiKeyCreateBody;
  readonly schemaErrors: readonly { readonly field: string; readonly message: string }[];
  readonly requestId: string | null;
  readonly ipFingerprint: Buffer | null;
}

export interface CreateApiKeyService {
  create(request: CreateApiKeyRequest): Promise<ApiKeyCreated>;
}

export interface CreateApiKeyServiceDependencies {
  readonly repository: CreateApiKeyRepository;
  readonly csrf: CsrfService;
  readonly responseEnvelope: ResponseEnvelope;
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly createMaterial?: () => ApiKeyMaterial;
}

export function createApiKeyService(
  dependencies: CreateApiKeyServiceDependencies,
): CreateApiKeyService {
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.createId ?? randomUUID;
  const createMaterial = dependencies.createMaterial ?? createApiKeyMaterial;

  return {
    async create(request): Promise<ApiKeyCreated> {
      if (
        request.csrfToken === undefined ||
        request.csrfToken.length < 16 ||
        request.csrfToken.length > 512 ||
        !dependencies.csrf.verify(request.identity.sessionId, request.csrfToken)
      ) {
        throw csrfValidationFailed();
      }

      if (request.schemaErrors.length > 0) {
        throw apiKeyValidationFailed(request.schemaErrors);
      }
      const requestTime = now();
      const canonical = canonicalizeApiKeyCreate(request.body, requestTime);
      const idempotencyIssues =
        request.idempotencyKey === undefined ||
        !IDEMPOTENCY_KEY_PATTERN.test(request.idempotencyKey)
          ? [{ field: "idempotency-key", message: "must be 16-128 accepted characters" }]
          : [];
      if (!canonical.valid || idempotencyIssues.length > 0) {
        throw apiKeyValidationFailed([
          ...(canonical.valid ? [] : canonical.issues),
          ...idempotencyIssues,
        ]);
      }

      const requestHash = apiKeyRequestHash(canonical.value);
      const actorFingerprint = apiKeyActorFingerprint(request.identity.userId);

      for (let attempt = 0; attempt < MAX_MATERIAL_ATTEMPTS; attempt += 1) {
        const idempotencyRecordId = createId();
        const apiKeyId = createId();
        const material = createMaterial();
        // Persist and return the same validated instant. Re-reading the clock
        // could make a just-future expires_at precede created_at after crypto.
        const createdAt = requestTime;
        const response: ApiKeyCreated = {
          id: apiKeyId,
          name: canonical.value.name,
          prefix: material.prefix,
          scopes: canonical.value.scopes,
          state: "active",
          created_at: createdAt.toISOString(),
          last_used_at: null,
          expires_at: canonical.value.expiresAt?.toISOString() ?? null,
          revoked_at: null,
          secret: material.secret,
        };
        const context = {
          tenantId: request.identity.tenantId,
          idempotencyRecordId,
          apiKeyId,
        };

        let sealed;
        try {
          sealed = await dependencies.responseEnvelope.seal(
            serializeApiKeyCreated(response),
            apiKeyEnvelopeAad(context),
          );
        } catch (error) {
          throw responseEnvelopeUnavailable(error);
        }

        try {
          const outcome = await dependencies.repository.persist({
            idempotencyRecordId,
            apiKeyId,
            tenantId: request.identity.tenantId,
            userId: request.identity.userId,
            idempotencyKey: request.idempotencyKey as string,
            actorFingerprint,
            requestHash,
            name: canonical.value.name,
            scopes: canonical.value.scopes,
            keyPrefix: material.prefix,
            keyHash: material.hash,
            createdAt,
            expiresAt: canonical.value.expiresAt,
            envelopeCiphertext: sealed.ciphertext,
            envelopeKeyReference: sealed.keyReference,
            requestId: request.requestId,
            ipFingerprint: request.ipFingerprint,
          });

          if (outcome.kind === "created") return response;
          if (outcome.kind === "conflict") throw apiKeyIdempotencyConflict();
          if (outcome.kind === "expired") throw apiKeyReplayExpired();

          try {
            const plaintext = await dependencies.responseEnvelope.open(
              outcome.envelopeCiphertext,
              outcome.envelopeKeyReference,
              apiKeyEnvelopeAad({
                tenantId: request.identity.tenantId,
                idempotencyRecordId: outcome.idempotencyRecordId,
                apiKeyId: outcome.apiKeyId,
              }),
            );
            const replay = parseApiKeyCreated(plaintext);
            if (replay.id !== outcome.apiKeyId) {
              throw new TypeError("The recovered response has the wrong resource identity");
            }
            return replay;
          } catch (error) {
            throw responseEnvelopeUnavailable(error);
          }
        } catch (error) {
          if (error instanceof ApiKeyMaterialCollisionError) {
            if (attempt + 1 < MAX_MATERIAL_ATTEMPTS) continue;
          }
          throw error;
        }
      }

      throw new Error("API-key material collision retries were exhausted");
    },
  };
}
