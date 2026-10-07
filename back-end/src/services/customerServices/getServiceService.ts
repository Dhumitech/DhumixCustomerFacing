import type { TrustedTenantPrincipal } from "../tenantAccess/trustedTenantPrincipal.js";
import type { GetServiceRecord, GetServiceRepository } from "./getServiceRepository.js";
import type { Service } from "./listServicesService.js";
import { serviceNotFound } from "./serviceErrors.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ServiceDetail extends Service {
  readonly configuration: Readonly<Record<string, unknown>>;
}

export interface GetServiceRequest {
  readonly principal: TrustedTenantPrincipal;
  readonly serviceId: unknown;
  readonly schemaErrors: readonly { readonly field: string; readonly message: string }[];
}

export interface GetServiceService {
  get(request: GetServiceRequest): Promise<ServiceDetail>;
}

export interface GetServiceServiceDependencies {
  readonly repository: GetServiceRepository;
}

function isServiceId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function publicService(record: GetServiceRecord): ServiceDetail {
  return {
    id: record.id,
    name: record.name,
    template_slug: record.templateSlug,
    template_version: record.templateVersion,
    version: record.version,
    family: record.family,
    state: record.state,
    configuration: record.configuration,
    created_at: record.createdAt.toISOString(),
  };
}

export function createGetServiceService(
  dependencies: GetServiceServiceDependencies,
): GetServiceService {
  return {
    async get(request): Promise<ServiceDetail> {
      if (request.schemaErrors.length > 0 || !isServiceId(request.serviceId)) {
        throw serviceNotFound();
      }

      const record = await dependencies.repository.findById({
        tenantId: request.principal.tenantId,
        userId: request.principal.userId,
        serviceId: request.serviceId,
      });
      if (record === undefined) throw serviceNotFound();
      return publicService(record);
    },
  };
}
