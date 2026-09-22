import { randomUUID } from "node:crypto";
import type { CsrfService } from "../../helpers/csrf.js";
import {
  canonicalizeRunRetry,
  runRetryRequestHash,
} from "../../helpers/runActionCanonicalization.js";
import {
  StoredServiceSchemaError,
  type ServiceConfigurationValidator,
} from "../../helpers/serviceConfigurationValidator.js";
import { tenantActorFingerprint } from "../../helpers/tenantActorFingerprint.js";
import type { ProviderEnvironment } from "../customerServices/createServiceRepository.js";
import { csrfValidationFailed } from "../identity/sessionErrors.js";
import type { TrustedTenantPrincipal } from "../tenantAccess/trustedTenantPrincipal.js";
import type { RunAccepted } from "./createRunRepository.js";
import {
  RunRetryCapacityExceededError,
  RunRetryInputRejectedError,
  RunRetryNotFoundError,
  RunRetryStateConflictError,
  RunRetryUnavailableError,
  type RetryRunRepository,
} from "./retryRunRepository.js";
import {
  runCapacityLimit,
  runIdempotencyConflict,
  runInputInvalid,
  runRetryBadRequest,
  runRetryNotFound,
  runRetryStateConflict,
  runRetryUnavailable,
  runValidationFailed,
} from "./runErrors.js";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;

export interface RetryRunRequest {
  readonly principal: TrustedTenantPrincipal;
  readonly csrfToken: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly runId: unknown;
  readonly bodyPresent: boolean;
  readonly schemaErrors: readonly {
    readonly field: string;
    readonly message: string;
  }[];
  readonly requestId: string | null;
  readonly ipFingerprint: Buffer | null;
}

export interface RetryRunService {
  retry(request: RetryRunRequest): Promise<RunAccepted>;
}

export interface RetryRunServiceDependencies {
  readonly repository: RetryRunRepository;
  readonly validator: ServiceConfigurationValidator;
  readonly csrf: CsrfService;
  readonly providerEnvironment: ProviderEnvironment;
  readonly createId?: () => string;
}

function isRunPathError(field: string): boolean {
  return field === "params" || field === "run_id" || field.endsWith("/run_id");
}

export function createRetryRunService(
  dependencies: RetryRunServiceDependencies,
): RetryRunService {
  const createId = dependencies.createId ?? randomUUID;

  return {
    async retry(request): Promise<RunAccepted> {
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

      if (request.bodyPresent) throw runRetryBadRequest();

      const nonPathSchemaErrors = request.schemaErrors.filter(
        (error) => !isRunPathError(error.field),
      );
      const idempotencyIssues =
        request.idempotencyKey === undefined ||
        !IDEMPOTENCY_KEY_PATTERN.test(request.idempotencyKey)
          ? [{ field: "idempotency-key", message: "must be 16-128 accepted characters" }]
          : [];
      if (nonPathSchemaErrors.length > 0 || idempotencyIssues.length > 0) {
        throw runValidationFailed([...nonPathSchemaErrors, ...idempotencyIssues]);
      }

      const canonical = canonicalizeRunRetry(request.runId);
      if (canonical === undefined) throw runRetryNotFound();

      try {
        const outcome = await dependencies.repository.persist({
          idempotencyRecordId: createId(),
          runId: createId(),
          runEventId: createId(),
          providerCostHoldId: createId(),
          outboxEventId: createId(),
          tenantId: request.principal.tenantId,
          actor:
            request.principal.kind === "browser"
              ? { kind: "browser", userId: request.principal.userId }
              : { kind: "api_key", apiKeyId: request.principal.apiKeyId },
          actorFingerprint: tenantActorFingerprint(request.principal),
          requestHash: runRetryRequestHash(canonical),
          idempotencyKey: request.idempotencyKey as string,
          sourceRunId: canonical.runId,
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
                throw new RunRetryUnavailableError(error);
              }
              throw error;
            }
          },
        });
        if (outcome.kind === "conflict") throw runIdempotencyConflict();
        return outcome.run;
      } catch (error) {
        if (error instanceof RunRetryNotFoundError) throw runRetryNotFound();
        if (error instanceof RunRetryStateConflictError) throw runRetryStateConflict();
        if (error instanceof RunRetryInputRejectedError) {
          throw runInputInvalid(error.issues);
        }
        if (error instanceof RunRetryCapacityExceededError) {
          throw runCapacityLimit(error);
        }
        if (error instanceof RunRetryUnavailableError) throw runRetryUnavailable(error);
        throw error;
      }
    },
  };
}
