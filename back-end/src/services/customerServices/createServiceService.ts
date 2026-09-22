import { randomUUID } from "node:crypto";
import type { CsrfService } from "../../helpers/csrf.js";
import {
  canonicalizeServiceCreate,
  serviceActorFingerprint,
  serviceRequestHash,
  type ServiceCreateBody,
} from "../../helpers/serviceCanonicalization.js";
import {
  StoredServiceSchemaError,
  type ServiceConfigurationValidator,
} from "../../helpers/serviceConfigurationValidator.js";
import { csrfValidationFailed } from "../identity/sessionErrors.js";
import type { TrustedTenantPrincipal } from "../tenantAccess/trustedTenantPrincipal.js";
import {
  ServiceAdmissionUnavailableError,
  ServiceConfigurationRejectedError,
  ServiceNameConflictError,
  ServiceTemplateNotCreatableError,
  type CreatedService,
  type CreateServiceRepository,
  type ProviderEnvironment,
} from "./createServiceRepository.js";
import {
  serviceIdempotencyConflict,
  serviceInputInvalid,
  serviceStateConflict,
  serviceUnavailable,
  serviceValidationFailed,
} from "./serviceErrors.js";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;

export interface CreateServiceRequest {
  readonly principal: TrustedTenantPrincipal;
  readonly csrfToken: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly body: ServiceCreateBody;
  readonly schemaErrors: readonly { readonly field: string; readonly message: string }[];
  readonly requestId: string | null;
  readonly ipFingerprint: Buffer | null;
}

export interface CreateServiceService {
  create(request: CreateServiceRequest): Promise<CreatedService>;
}

export interface CreateServiceServiceDependencies {
  readonly repository: CreateServiceRepository;
  readonly validator: ServiceConfigurationValidator;
  readonly csrf: CsrfService;
  readonly providerEnvironment: ProviderEnvironment;
  readonly createId?: () => string;
}

export function createServiceService(
  dependencies: CreateServiceServiceDependencies,
): CreateServiceService {
  const createId = dependencies.createId ?? randomUUID;

  return {
    async create(request): Promise<CreatedService> {
      if (
        request.principal.kind === "browser" &&
        (
          request.csrfToken === undefined ||
          request.csrfToken.length < 16 ||
          request.csrfToken.length > 512 ||
          !dependencies.csrf.verify(request.principal.sessionId, request.csrfToken)
        )
      ) {
        throw csrfValidationFailed();
      }

      if (request.schemaErrors.length > 0) {
        throw serviceValidationFailed(request.schemaErrors);
      }
      const canonical = canonicalizeServiceCreate(request.body);
      const idempotencyIssues =
        request.idempotencyKey === undefined ||
        !IDEMPOTENCY_KEY_PATTERN.test(request.idempotencyKey)
          ? [{ field: "idempotency-key", message: "must be 16-128 accepted characters" }]
          : [];
      if (!canonical.valid || idempotencyIssues.length > 0) {
        throw serviceValidationFailed([
          ...(canonical.valid ? [] : canonical.issues),
          ...idempotencyIssues,
        ]);
      }

      try {
        const outcome = await dependencies.repository.persist({
          idempotencyRecordId: createId(),
          serviceId: createId(),
          serviceVersionId: createId(),
          tenantId: request.principal.tenantId,
          actor:
            request.principal.kind === "browser"
              ? { kind: "browser", userId: request.principal.userId }
              : { kind: "api_key", apiKeyId: request.principal.apiKeyId },
          idempotencyKey: request.idempotencyKey as string,
          actorFingerprint: serviceActorFingerprint(request.principal),
          requestHash: serviceRequestHash(canonical.value),
          templateSlug: canonical.value.templateSlug,
          name: canonical.value.name,
          configuration: canonical.value.configuration,
          providerEnvironment: dependencies.providerEnvironment,
          requestId: request.requestId,
          ipFingerprint: request.ipFingerprint,
          validateConfiguration(input) {
            try {
              return dependencies.validator.validate(input);
            } catch (error) {
              if (error instanceof StoredServiceSchemaError) {
                throw new ServiceAdmissionUnavailableError(error);
              }
              throw error;
            }
          },
        });
        if (outcome.kind === "conflict") throw serviceIdempotencyConflict();
        return outcome.service;
      } catch (error) {
        if (error instanceof ServiceTemplateNotCreatableError) throw serviceInputInvalid();
        if (error instanceof ServiceConfigurationRejectedError) {
          throw serviceInputInvalid(error.issues);
        }
        if (error instanceof ServiceAdmissionUnavailableError) throw serviceUnavailable(error);
        if (error instanceof ServiceNameConflictError) throw serviceStateConflict();
        throw error;
      }
    },
  };
}
