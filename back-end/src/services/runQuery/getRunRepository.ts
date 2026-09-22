import type { Pool } from "pg";
import type { RunPublicStatus } from "../../helpers/runListCursor.js";
import { ApplicationError } from "../../utils/applicationError.js";
import { withTenantTransaction } from "../database/transactions.js";

export interface GetRunRecord {
  readonly id: string;
  readonly serviceId: string;
  readonly status: RunPublicStatus;
  readonly customerErrorCode: string | null;
  readonly retryable: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
}

export interface GetRunRepositoryInput {
  readonly tenantId: string;
  readonly runId: string;
}

export interface GetRunRepository {
  findById(input: GetRunRepositoryInput): Promise<GetRunRecord | undefined>;
}

interface GetRunRow {
  readonly id: string;
  readonly service_id: string;
  readonly public_status: RunPublicStatus;
  readonly customer_error_code: string | null;
  readonly retryable: boolean;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly completed_at: Date | null;
}

function internalFailure(cause: unknown): ApplicationError {
  return new ApplicationError({
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Internal server error",
    cause,
  });
}

export function createGetRunRepository(pool: Pool): GetRunRepository {
  return {
    async findById(input): Promise<GetRunRecord | undefined> {
      try {
        return await withTenantTransaction(pool, input.tenantId, async (database) => {
          const result = await database.query<GetRunRow>(
            `
              SELECT
                run.id,
                service_version.service_id,
                run.public_status,
                run.customer_error_code,
                run.retryable,
                run.created_at,
                run.updated_at,
                run.completed_at
              FROM app.runs AS run
              INNER JOIN app.service_versions AS service_version
                ON service_version.tenant_id = run.tenant_id
               AND service_version.id = run.service_version_id
              WHERE run.tenant_id = $1
                AND run.id = $2::uuid
              LIMIT 1
            `,
            [input.tenantId, input.runId],
          );

          const row = result.rows[0];
          return row === undefined
            ? undefined
            : {
                id: row.id,
                serviceId: row.service_id,
                status: row.public_status,
                customerErrorCode: row.customer_error_code,
                retryable: row.retryable,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                completedAt: row.completed_at,
              };
        });
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw internalFailure(error);
      }
    },
  };
}
