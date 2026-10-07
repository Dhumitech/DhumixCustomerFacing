import {
  decodeRunListCursor,
  encodeRunListCursor,
  isRunPublicStatus,
  type RunListCursorPosition,
  type RunPublicStatus,
} from "../../helpers/runListCursor.js";
import type { TrustedTenantPrincipal } from "../tenantAccess/trustedTenantPrincipal.js";
import type { ListRunsRecord, ListRunsRepository } from "./listRunsRepository.js";
import { runQueryValidationFailed } from "./runQueryErrors.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DECIMAL_INTEGER_PATTERN = /^[0-9]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface Run {
  readonly created_by_user_id?:string|null;
  readonly retry_of_run_id?:string|null;
  readonly id: string;
  readonly service_id: string;
  readonly status: RunPublicStatus;
  readonly error_code: string | null;
  readonly retryable: boolean;
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
}

export interface RunPage {
  readonly data: readonly Run[];
  readonly page: {
    readonly next_cursor: string | null;
    readonly has_more: boolean;
  };
}

export interface ListRunsRequest {
  readonly principal: TrustedTenantPrincipal;
  readonly status: unknown;
  readonly serviceId?: unknown;
  readonly cursor: unknown;
  readonly limit: unknown;
  readonly schemaErrors: readonly {
    readonly field: string;
    readonly message: string;
  }[];
}

export interface ListRunsService {
  list(request: ListRunsRequest): Promise<RunPage>;
}

export interface ListRunsServiceDependencies {
  readonly repository: ListRunsRepository;
}

function validationError(field: string, message: string): never {
  throw runQueryValidationFailed([{ field, message }]);
}

function parseStatus(value: unknown): RunPublicStatus | null {
  if (value === undefined) return null;
  if (!isRunPublicStatus(value)) {
    return validationError("status", "must be a valid Run status");
  }
  return value;
}

function parseLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (typeof value !== "string" || !DECIMAL_INTEGER_PATTERN.test(value)) {
    return validationError("limit", "must be an integer between 1 and 100");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    return validationError("limit", "must be an integer between 1 and 100");
  }
  return parsed;
}

function parseServiceId(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return validationError("service_id", "must be a valid Service ID");
  }
  return value;
}

function parseCursor(
  value: unknown,
  statusFilter: RunPublicStatus | null,
  serviceIdFilter: string | null,
): RunListCursorPosition | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    return validationError("cursor", "must be a valid Run page cursor");
  }

  try {
    const cursor = decodeRunListCursor(value);
    if (cursor.statusFilter !== statusFilter) {
      return validationError("cursor", "must use the same status filter as the Run page cursor");
    }
    if (cursor.serviceIdFilter !== serviceIdFilter) {
      return validationError(
        "cursor",
        "must use the same service_id filter as the Run page cursor",
      );
    }
    return cursor;
  } catch {
    return validationError("cursor", "must be a valid Run page cursor");
  }
}

function publicRun(record: ListRunsRecord): Run {
  return {
    id: record.id,
    service_id: record.serviceId,
    status: record.status,
    error_code: record.customerErrorCode,
    retryable: record.retryable,
    created_at: record.createdAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
    completed_at: record.completedAt?.toISOString() ?? null,
    ...(record.createdByUserId===undefined?{}:{created_by_user_id:record.createdByUserId}),
    ...(record.retryOfRunId===undefined?{}:{retry_of_run_id:record.retryOfRunId}),
  };
}

export function createListRunsService(dependencies: ListRunsServiceDependencies): ListRunsService {
  return {
    async list(request): Promise<RunPage> {
      if (request.schemaErrors.length > 0) {
        throw runQueryValidationFailed(request.schemaErrors);
      }

      const statusFilter = parseStatus(request.status);
      const serviceIdFilter = parseServiceId(request.serviceId);
      const limit = parseLimit(request.limit);
      const cursor = parseCursor(request.cursor, statusFilter, serviceIdFilter);
      const records = await dependencies.repository.list({
        tenantId: request.principal.tenantId,
        userId: request.principal.userId,
        statusFilter,
        serviceIdFilter,
        cursor,
        fetchLimit: limit + 1,
      });
      const hasMore = records.length > limit;
      const visibleRecords = records.slice(0, limit);
      const lastVisible = visibleRecords.at(-1);

      return {
        data: visibleRecords.map(publicRun),
        page: {
          next_cursor:
            hasMore && lastVisible !== undefined
              ? encodeRunListCursor({
                  statusFilter,
                  serviceIdFilter,
                  createdAt: lastVisible.createdAt.toISOString(),
                  id: lastVisible.id,
                })
              : null,
          has_more: hasMore,
        },
      };
    },
  };
}
