import { randomUUID } from "node:crypto";
import type { CsrfService } from "../../helpers/csrf.js";
import {
  canonicalizeRunCancellation,
  runCancellationRequestHash,
} from "../../helpers/runActionCanonicalization.js";
import { tenantActorFingerprint } from "../../helpers/tenantActorFingerprint.js";
import { csrfValidationFailed } from "../identity/sessionErrors.js";
import type { Run } from "../runQuery/listRunsService.js";
import type { TrustedTenantPrincipal } from "../tenantAccess/trustedTenantPrincipal.js";
import {
  RunCancellationNotFoundError,
  RunCancellationStateConflictError,
  RunCancellationUnavailableError,
  type CancelRunRepository,
} from "./cancelRunRepository.js";
import {
  runCancellationBadRequest,
  runCancellationNotFound,
  runCancellationStateConflict,
  runCancellationUnavailable,
  runIdempotencyConflict,
  runValidationFailed,
} from "./runErrors.js";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;

export interface CancelRunRequest {
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

export interface CancelRunService {
  cancel(request: CancelRunRequest): Promise<Run>;
}

export interface CancelRunServiceDependencies {
  readonly repository: CancelRunRepository;
  readonly csrf: CsrfService;
  readonly createId?: () => string;
}

function isRunPathError(field: string): boolean {
  return field === "params" || field === "run_id" || field.endsWith("/run_id");
}

export function createCancelRunService(
  dependencies: CancelRunServiceDependencies,
): CancelRunService {
  const createId = dependencies.createId ?? randomUUID;

  return {
    async cancel(request): Promise<Run> {
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

      if (request.bodyPresent) throw runCancellationBadRequest();

      const nonPathSchemaErrors = request.schemaErrors.filter(
        (error) => !isRunPathError(error.field),
      );
      const idempotencyIssues =
        request.idempotencyKey === undefined ||
        !IDEMPOTENCY_KEY_PATTERN.test(request.idempotencyKey)
          ? [{ field: "idempotency-key", message: "must be 16-128 accepted characters" }]
          : [];
      if (nonPathSchemaErrors.length > 0 || idempotencyIssues.length > 0) {
        throw runValidationFailed([
          ...nonPathSchemaErrors,
          ...idempotencyIssues,
        ]);
      }

      const canonical = canonicalizeRunCancellation(request.runId);
      if (canonical === undefined) throw runCancellationNotFound();

      try {
        const outcome = await dependencies.repository.persist({
          idempotencyRecordId: createId(),
          runEventId: createId(),
          outboxEventId: createId(),
          tenantId: request.principal.tenantId,
          actor:
            request.principal.kind === "browser"
              ? { kind: "browser", userId: request.principal.userId }
              : { kind: "api_key", apiKeyId: request.principal.apiKeyId },
          actorFingerprint: tenantActorFingerprint(request.principal),
          requestHash: runCancellationRequestHash(canonical),
          idempotencyKey: request.idempotencyKey as string,
          runId: canonical.runId,
          requestId: request.requestId,
          ipFingerprint: request.ipFingerprint,
        });
        if (outcome.kind === "conflict") throw runIdempotencyConflict();
        return outcome.run;
      } catch (error) {
        if (error instanceof RunCancellationNotFoundError) {
          throw runCancellationNotFound();
        }
        if (error instanceof RunCancellationStateConflictError) {
          throw runCancellationStateConflict();
        }
        if (error instanceof RunCancellationUnavailableError) {
          throw runCancellationUnavailable(error);
        }
        throw error;
      }
    },
  };
}
