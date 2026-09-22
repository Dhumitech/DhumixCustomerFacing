import {
  CATALOG_PRODUCT_FAMILIES,
  decodeCatalogTemplateListCursor,
  encodeCatalogTemplateListCursor,
  type CatalogProductFamily,
  type CatalogTemplateListCursorPosition,
} from "../../helpers/catalogTemplateListCursor.js";
import type { TrustedTenantPrincipal } from "../tenantAccess/trustedTenantPrincipal.js";
import {
  toServiceTemplate,
  type ServiceTemplate,
} from "./catalogTemplate.js";
import { catalogueValidationFailed } from "./catalogueErrors.js";
import type {
  ListCatalogTemplatesRepository,
} from "./listCatalogTemplatesRepository.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DECIMAL_INTEGER_PATTERN = /^[0-9]+$/;

export type { ServiceTemplate } from "./catalogTemplate.js";

export interface TemplatePage {
  readonly data: readonly ServiceTemplate[];
  readonly page: {
    readonly next_cursor: string | null;
    readonly has_more: boolean;
  };
}

export interface ListCatalogTemplatesRequest {
  readonly principal: TrustedTenantPrincipal;
  readonly family: unknown;
  readonly cursor: unknown;
  readonly limit: unknown;
  readonly schemaErrors: readonly { readonly field: string; readonly message: string }[];
}

export interface ListCatalogTemplatesService {
  list(request: ListCatalogTemplatesRequest): Promise<TemplatePage>;
}

export interface ListCatalogTemplatesServiceDependencies {
  readonly repository: ListCatalogTemplatesRepository;
}

function validationError(field: string, message: string): never {
  throw catalogueValidationFailed([{ field, message }]);
}

function parseFamily(value: unknown): CatalogProductFamily | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !CATALOG_PRODUCT_FAMILIES.some((family) => family === value)
  ) {
    return validationError("family", "must be a supported catalogue product family");
  }
  return value as CatalogProductFamily;
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

function parseCursor(value: unknown): CatalogTemplateListCursorPosition | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    return validationError("cursor", "must be a valid catalogue page cursor");
  }
  try {
    return decodeCatalogTemplateListCursor(value);
  } catch {
    return validationError("cursor", "must be a valid catalogue page cursor");
  }
}

export function createListCatalogTemplatesService(
  dependencies: ListCatalogTemplatesServiceDependencies,
): ListCatalogTemplatesService {
  return {
    async list(request): Promise<TemplatePage> {
      if (request.schemaErrors.length > 0) {
        throw catalogueValidationFailed(request.schemaErrors);
      }
      const family = parseFamily(request.family);
      const limit = parseLimit(request.limit);
      const cursor = parseCursor(request.cursor);
      const normalizedFamilyFilter = family ?? null;
      if (cursor !== undefined && cursor.familyFilter !== normalizedFamilyFilter) {
        return validationError("cursor", "must match the requested family filter");
      }

      const records = await dependencies.repository.list({
        tenantId: request.principal.tenantId,
        family,
        cursor,
        fetchLimit: limit + 1,
      });
      const hasMore = records.length > limit;
      const visibleRecords = records.slice(0, limit);
      const lastVisible = visibleRecords.at(-1);

      return {
        data: visibleRecords.map(toServiceTemplate),
        page: {
          next_cursor:
            hasMore && lastVisible !== undefined
              ? encodeCatalogTemplateListCursor({
                  familyFilter: normalizedFamilyFilter,
                  family: lastVisible.family,
                  slug: lastVisible.slug,
                  id: lastVisible.id,
                })
              : null,
          has_more: hasMore,
        },
      };
    },
  };
}
