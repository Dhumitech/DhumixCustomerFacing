import type { TrustedBrowsePrincipal } from "../tenantAccess/trustedBrowsePrincipal.js";
import { toServiceTemplate, type ServiceTemplate } from "./catalogTemplate.js";
import { catalogTemplateNotFound } from "./catalogueErrors.js";
import type { GetCatalogTemplateRepository } from "./getCatalogTemplateRepository.js";

const CATALOG_TEMPLATE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MIN_SLUG_LENGTH = 3;
const MAX_SLUG_LENGTH = 100;

export interface GetCatalogTemplateRequest {
  readonly principal: TrustedBrowsePrincipal;
  readonly slug: unknown;
  readonly schemaErrors: readonly { readonly field: string; readonly message: string }[];
}

export interface GetCatalogTemplateService {
  get(request: GetCatalogTemplateRequest): Promise<ServiceTemplate>;
}

export interface GetCatalogTemplateServiceDependencies {
  readonly repository: GetCatalogTemplateRepository;
}

function validSlug(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= MIN_SLUG_LENGTH &&
    value.length <= MAX_SLUG_LENGTH &&
    CATALOG_TEMPLATE_SLUG_PATTERN.test(value)
  );
}

export function createGetCatalogTemplateService(
  dependencies: GetCatalogTemplateServiceDependencies,
): GetCatalogTemplateService {
  return {
    async get(request): Promise<ServiceTemplate> {
      if (request.schemaErrors.length > 0 || !validSlug(request.slug)) {
        throw catalogTemplateNotFound();
      }

      const record = await dependencies.repository.findBySlug({
        userId: request.principal.userId,
        ...(request.principal.tenantId === undefined
          ? {}
          : { tenantId: request.principal.tenantId }),
        slug: request.slug,
      });
      if (record === undefined) throw catalogTemplateNotFound();
      return toServiceTemplate(record);
    },
  };
}
