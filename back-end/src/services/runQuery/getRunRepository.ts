import { RUN_PUBLIC_STATUS_SQL } from "../../helpers/runPublicStatus.js";
import type { Pool } from "pg";
import type { RunPublicStatus } from "../../helpers/runListCursor.js";
import { ApplicationError } from "../../utils/applicationError.js";
import { withOrganizationReadTransaction } from "../database/transactions.js";

export interface GetRunRecord {
  readonly createdByUserId?:string|null;
  readonly retryOfRunId?:string|null;
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
  readonly userId: string;
  readonly runId: string;
}

export interface GetRunRepository {
  findById(input: GetRunRepositoryInput): Promise<GetRunRecord | undefined>;
}

interface GetRunRow {
  readonly created_by_user_id:string|null;
  readonly retry_of_run_id:string|null;
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
        return await withOrganizationReadTransaction(
          pool,
          { tenantId: input.tenantId, userId: input.userId },
          async (database) => {
            const result = await database.query<GetRunRow>(
              `
              SELECT
                run.id,
                run.created_by_user_id,
                run.retry_of_run_id,
                run.service_id,
                ${RUN_PUBLIC_STATUS_SQL} AS public_status,
                run.customer_error_code,
                run.retryable,
                run.created_at,
                run.updated_at,
                run.completed_at
              FROM app.runs AS run
              WHERE run.organization_id = $1
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
                  createdByUserId:row.created_by_user_id,retryOfRunId:row.retry_of_run_id,
                  serviceId: row.service_id,
                  status: row.public_status,
                  customerErrorCode: row.customer_error_code,
                  retryable: row.retryable,
                  createdAt: row.created_at,
                  updatedAt: row.updated_at,
                  completedAt: row.completed_at,
                };
          },
        );
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw internalFailure(error);
      }
    },
  };
}
