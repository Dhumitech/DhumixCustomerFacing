import {
  decodeServiceListCursor,
  encodeServiceListCursor,
  type ServiceListCursorPosition,
} from "../../helpers/serviceListCursor.js";
import type { TrustedTenantPrincipal } from "../tenantAccess/trustedTenantPrincipal.js";
import type {
  ListServicesRecord,
  ListServicesRepository,
  ServiceProductFamily,
  ServiceState,
} from "./listServicesRepository.js";
import { serviceValidationFailed } from "./serviceErrors.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DECIMAL_INTEGER_PATTERN = /^[0-9]+$/;

export interface Service {
  readonly id: string;
  readonly name: string;
  readonly template_slug: string;
  readonly template_version: number;
  readonly version: number;
  readonly family: ServiceProductFamily;
  readonly state: ServiceState;
  readonly created_at: string;
}

export interface ServicePage {
  readonly data: readonly Service[];
  readonly page: {
    readonly next_cursor: string | null;
    readonly has_more: boolean;
  };
}

export interface ListServicesRequest {
  readonly principal: TrustedTenantPrincipal;
  readonly cursor: unknown;
  readonly limit: unknown;
  readonly schemaErrors: readonly { readonly field: string; readonly message: string }[];
}

export interface ListServicesService {
  list(request: ListServicesRequest): Promise<ServicePage>;
}

export interface ListServicesServiceDependencies {
  readonly repository: ListServicesRepository;
}

function validationError(field: string, message: string): never {
  throw serviceValidationFailed([{ field, message }]);
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

function parseCursor(value: unknown): ServiceListCursorPosition | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    return validationError("cursor", "must be a valid Service page cursor");
  }
  try {
    return decodeServiceListCursor(value);
  } catch {
    return validationError("cursor", "must be a valid Service page cursor");
  }
}

function publicService(record: ListServicesRecord): Service {
  return {
    id: record.id,
    name: record.name,
    template_slug: record.templateSlug,
    template_version: record.templateVersion,
    version: record.version,
    family: record.family,
    state: record.state,
    created_at: record.createdAt.toISOString(),
  };
}

export function createListServicesService(
  dependencies: ListServicesServiceDependencies,
): ListServicesService {
  return {
    async list(request): Promise<ServicePage> {
      if (request.schemaErrors.length > 0) {
        throw serviceValidationFailed(request.schemaErrors);
      }
      const limit = parseLimit(request.limit);
      const cursor = parseCursor(request.cursor);
      const records = await dependencies.repository.list({
        tenantId: request.principal.tenantId,
        userId: request.principal.userId,
        cursor,
        fetchLimit: limit + 1,
      });
      const hasMore = records.length > limit;
      const visibleRecords = records.slice(0, limit);
      const lastVisible = visibleRecords.at(-1);

      return {
        data: visibleRecords.map(publicService),
        page: {
          next_cursor:
            hasMore && lastVisible !== undefined
              ? encodeServiceListCursor({
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
