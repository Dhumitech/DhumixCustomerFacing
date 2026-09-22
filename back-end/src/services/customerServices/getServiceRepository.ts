import type { Pool } from "pg";
import { ApplicationError } from "../../utils/applicationError.js";
import { withTenantTransaction } from "../database/transactions.js";
import type {
  ServiceProductFamily,
  ServiceState,
} from "./listServicesRepository.js";

export interface GetServiceRecord {
  readonly id: string;
  readonly name: string;
  readonly templateSlug: string;
  readonly templateVersion: number;
  readonly version: number;
  readonly family: ServiceProductFamily;
  readonly state: ServiceState;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
}

export interface GetServiceRepositoryInput {
  readonly tenantId: string;
  readonly serviceId: string;
}

export interface GetServiceRepository {
  findById(input: GetServiceRepositoryInput): Promise<GetServiceRecord | undefined>;
}

interface GetServiceRow {
  readonly id: string;
  readonly name: string;
  readonly template_slug: string;
  readonly template_version: number;
  readonly version: number;
  readonly family: ServiceProductFamily;
  readonly state: ServiceState;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly created_at: Date;
}

function internalFailure(cause: unknown): ApplicationError {
  return new ApplicationError({
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Internal server error",
    cause,
  });
}

export function createGetServiceRepository(pool: Pool): GetServiceRepository {
  return {
    async findById(input): Promise<GetServiceRecord | undefined> {
      try {
        return await withTenantTransaction(pool, input.tenantId, async (database) => {
          const result = await database.query<GetServiceRow>(
            `
              SELECT
                service.id,
                service.name,
                template.slug AS template_slug,
                template_version.version AS template_version,
                service_version.version,
                template.product_family AS family,
                service.state,
                service_version.validated_configuration AS configuration,
                service.created_at
              FROM app.services AS service
              INNER JOIN app.service_versions AS service_version
                ON service_version.tenant_id = service.tenant_id
               AND service_version.service_id = service.id
               AND service_version.version = service.current_version
              INNER JOIN app.service_template_versions AS template_version
                ON template_version.id = service_version.service_template_version_id
              INNER JOIN app.service_templates AS template
                ON template.id = template_version.service_template_id
               AND template.id = service.service_template_id
              WHERE service.tenant_id = $1
                AND service.id = $2::uuid
              LIMIT 1
            `,
            [input.tenantId, input.serviceId],
          );

          const row = result.rows[0];
          return row === undefined
            ? undefined
            : {
                id: row.id,
                name: row.name,
                templateSlug: row.template_slug,
                templateVersion: row.template_version,
                version: row.version,
                family: row.family,
                state: row.state,
                configuration: row.configuration,
                createdAt: row.created_at,
              };
        });
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw internalFailure(error);
      }
    },
  };
}
