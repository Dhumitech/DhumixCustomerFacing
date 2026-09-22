import type { Pool } from "pg";
import type { ServiceListCursorPosition } from "../../helpers/serviceListCursor.js";
import { ApplicationError } from "../../utils/applicationError.js";
import { withTenantTransaction } from "../database/transactions.js";

export type ServiceProductFamily = "marketplace_dataset" | "scraper_library";
export type ServiceState = "active" | "disabled";

export interface ListServicesRecord {
  readonly id: string;
  readonly name: string;
  readonly templateSlug: string;
  readonly templateVersion: number;
  readonly version: number;
  readonly family: ServiceProductFamily;
  readonly state: ServiceState;
  readonly createdAt: Date;
}

export interface ListServicesRepositoryInput {
  readonly tenantId: string;
  readonly cursor: ServiceListCursorPosition | undefined;
  readonly fetchLimit: number;
}

export interface ListServicesRepository {
  list(input: ListServicesRepositoryInput): Promise<readonly ListServicesRecord[]>;
}

interface ListServicesRow {
  readonly id: string;
  readonly name: string;
  readonly template_slug: string;
  readonly template_version: number;
  readonly version: number;
  readonly family: ServiceProductFamily;
  readonly state: ServiceState;
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

export function createListServicesRepository(pool: Pool): ListServicesRepository {
  return {
    async list(input): Promise<readonly ListServicesRecord[]> {
      if (
        !Number.isInteger(input.fetchLimit) ||
        input.fetchLimit < 2 ||
        input.fetchLimit > 101
      ) {
        throw new TypeError("fetchLimit must be an integer between 2 and 101");
      }

      try {
        return await withTenantTransaction(pool, input.tenantId, async (database) => {
          const result = await database.query<ListServicesRow>(
            `
              SELECT
                service.id,
                service.name,
                template.slug AS template_slug,
                template_version.version AS template_version,
                service_version.version,
                template.product_family AS family,
                service.state,
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
                AND (
                  $2::timestamptz IS NULL
                  OR (service.created_at, service.id) < ($2::timestamptz, $3::uuid)
                )
              ORDER BY service.created_at DESC, service.id DESC
              LIMIT $4::integer
            `,
            [
              input.tenantId,
              input.cursor?.createdAt ?? null,
              input.cursor?.id ?? null,
              input.fetchLimit,
            ],
          );

          return result.rows.map((row) => ({
            id: row.id,
            name: row.name,
            templateSlug: row.template_slug,
            templateVersion: row.template_version,
            version: row.version,
            family: row.family,
            state: row.state,
            createdAt: row.created_at,
          }));
        });
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw internalFailure(error);
      }
    },
  };
}
