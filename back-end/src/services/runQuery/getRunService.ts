import type { TrustedTenantPrincipal } from "../tenantAccess/trustedTenantPrincipal.js";
import type { GetRunRecord, GetRunRepository } from "./getRunRepository.js";
import type { Run } from "./listRunsService.js";
import { runQueryNotFound } from "./runQueryErrors.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface GetRunRequest {
  readonly principal: TrustedTenantPrincipal;
  readonly runId: unknown;
  readonly schemaErrors: readonly { readonly field: string; readonly message: string }[];
}

export interface GetRunService {
  get(request: GetRunRequest): Promise<Run>;
}

export interface GetRunServiceDependencies {
  readonly repository: GetRunRepository;
}

function isRunId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function publicRun(record: GetRunRecord): Run {
  return {
    id: record.id,
    service_id: record.serviceId,
    status: record.status,
    error_code: record.customerErrorCode,
    retryable: record.retryable,
    created_at: record.createdAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
    completed_at: record.completedAt?.toISOString() ?? null,
  };
}

export function createGetRunService(
  dependencies: GetRunServiceDependencies,
): GetRunService {
  return {
    async get(request): Promise<Run> {
      if (request.schemaErrors.length > 0 || !isRunId(request.runId)) {
        throw runQueryNotFound();
      }

      const record = await dependencies.repository.findById({
        tenantId: request.principal.tenantId,
        runId: request.runId,
      });
      if (record === undefined) throw runQueryNotFound();
      return publicRun(record);
    },
  };
}
