import { randomUUID } from "node:crypto";
import type { CsrfService } from "../../helpers/csrf.js";
import {
  canonicalizeRunCreate,
  runRequestHash,
  type RunCreateBody,
} from "../../helpers/runCanonicalization.js";
import {
  StoredServiceSchemaError,
  type ServiceConfigurationValidator,
} from "../../helpers/serviceConfigurationValidator.js";
import { tenantActorFingerprint } from "../../helpers/tenantActorFingerprint.js";
import type { ProviderEnvironment } from "../customerServices/createServiceRepository.js";
import { csrfValidationFailed } from "../identity/sessionErrors.js";
import { accessDenied } from "../tenantAccess/tenantAccessErrors.js";
import type { TrustedTenantPrincipal } from "../tenantAccess/trustedTenantPrincipal.js";
import {
  RunAdmissionUnavailableError,
  RunCapacityExceededError,
  RunInputRejectedError,
  RunServiceNotFoundError,
  RunServiceStateConflictError,
  type CreateRunRepository,
  type RunAccepted,
} from "./createRunRepository.js";
import {
  runCapacityLimit,
  runIdempotencyConflict,
  runInputInvalid,
  runNotFound,
  runStateConflict,
  runUnavailable,
  runValidationFailed,
} from "./runErrors.js";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;

export interface CreateRunRequest {
  readonly principal: TrustedTenantPrincipal;
  readonly csrfToken: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly serviceId: unknown;
  readonly body: RunCreateBody;
  readonly schemaErrors: readonly { readonly field: string; readonly message: string }[];
  readonly requestId: string | null;
  readonly ipFingerprint: Buffer | null;
}

export interface CreateRunService {
  create(request: CreateRunRequest): Promise<RunAccepted>;
}

export interface CreateRunServiceDependencies {
  readonly repository: CreateRunRepository;
  readonly validator: ServiceConfigurationValidator;
  readonly csrf: CsrfService;
  readonly providerEnvironment: ProviderEnvironment;
  readonly createId?: () => string;
}

export function createRunService(
  dependencies: CreateRunServiceDependencies,
): CreateRunService {
  const createId = dependencies.createId ?? randomUUID;

  return {
    async create(request): Promise<RunAccepted> {
      if (request.principal.kind !== "browser") throw accessDenied();
      if (
        request.csrfToken === undefined ||
        request.csrfToken.length < 16 ||
        request.csrfToken.length > 512 ||
        !dependencies.csrf.verify(request.principal.sessionId, request.csrfToken)
      ) {
        throw csrfValidationFailed();
      }

      if (request.schemaErrors.length > 0) {
        throw runValidationFailed(request.schemaErrors);
      }
      const canonical = canonicalizeRunCreate(request.serviceId, request.body);
      const idempotencyIssues =
        request.idempotencyKey === undefined ||
        !IDEMPOTENCY_KEY_PATTERN.test(request.idempotencyKey)
          ? [{ field: "idempotency-key", message: "must be 16-128 accepted characters" }]
          : [];
      if (!canonical.valid || idempotencyIssues.length > 0) {
        throw runValidationFailed([
          ...(canonical.valid ? [] : canonical.issues),
          ...idempotencyIssues,
        ]);
      }

      try {
        const outcome = await dependencies.repository.persist({
          idempotencyRecordId: createId(),
          runId: createId(),
          runEventId: createId(),
          outboxEventId: createId(),
          tenantId: request.principal.tenantId,
          actor: { kind: "browser", userId: request.principal.userId },
          actorFingerprint: tenantActorFingerprint(request.principal),
          requestHash: runRequestHash(canonical.value),
          idempotencyKey: request.idempotencyKey as string,
          serviceId: canonical.value.serviceId,
          input: canonical.value.input,
          providerEnvironment: dependencies.providerEnvironment,
          requestId: request.requestId,
          ipFingerprint: request.ipFingerprint,
          validateInput(input) {
            try {
              const result = dependencies.validator.validate({
                templateVersionId: input.templateVersionId,
                schema: input.schema,
                configuration: input.input,
              });
              return result.valid
                ? { valid: true }
                : { valid: false, issues: result.issues };
            } catch (error) {
              if (error instanceof StoredServiceSchemaError) {
                throw new RunAdmissionUnavailableError(error);
              }
              throw error;
            }
          },
        });
        if (outcome.kind === "conflict") throw runIdempotencyConflict();
        return outcome.run;
      } catch (error) {
        if (error instanceof RunServiceNotFoundError) throw runNotFound();
        if (error instanceof RunServiceStateConflictError) throw runStateConflict();
        if (error instanceof RunInputRejectedError) throw runInputInvalid(error.issues);
        if (error instanceof RunCapacityExceededError) throw runCapacityLimit(error);
        if (error instanceof RunAdmissionUnavailableError) throw runUnavailable(error);
        throw error;
      }
    },
  };
}
