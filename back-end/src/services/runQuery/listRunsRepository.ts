import { RUN_PUBLIC_STATUS_SQL } from "../../helpers/runPublicStatus.js";
import type { Pool } from "pg";
import type { RunListCursorPosition, RunPublicStatus } from "../../helpers/runListCursor.js";
import { ApplicationError } from "../../utils/applicationError.js";
import { withOrganizationReadTransaction } from "../database/transactions.js";

export interface ListRunsRecord {
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

export interface ListRunsRepositoryInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly statusFilter: RunPublicStatus | null;
  readonly serviceIdFilter: string | null;
  readonly cursor: RunListCursorPosition | undefined;
  readonly fetchLimit: number;
}

export interface ListRunsRepository {
  list(input: ListRunsRepositoryInput): Promise<readonly ListRunsRecord[]>;
}

interface ListRunsRow {
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

export function createListRunsRepository(pool: Pool): ListRunsRepository {
  return {
    async list(input): Promise<readonly ListRunsRecord[]> {
      if (!Number.isInteger(input.fetchLimit) || input.fetchLimit < 2 || input.fetchLimit > 101) {
        throw new TypeError("fetchLimit must be an integer between 2 and 101");
      }

      try {
        return await withOrganizationReadTransaction(
          pool,
          { tenantId: input.tenantId, userId: input.userId },
          async (database) => {
            const result = await database.query<ListRunsRow>(
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
                AND ($2::text IS NULL OR (${RUN_PUBLIC_STATUS_SQL}) = $2::text)
                AND ($3::uuid IS NULL OR run.service_id = $3::uuid)
                AND (
                  $4::timestamptz IS NULL
                  OR (run.created_at, run.id) < ($4::timestamptz, $5::uuid)
                )
              ORDER BY run.created_at DESC, run.id DESC
              LIMIT $6::integer
            `,
              [
                input.tenantId,
                input.statusFilter,
                input.serviceIdFilter,
                input.cursor?.createdAt ?? null,
                input.cursor?.id ?? null,
                input.fetchLimit,
              ],
            );

            return result.rows.map((row) => ({
              id: row.id,
              createdByUserId:row.created_by_user_id,retryOfRunId:row.retry_of_run_id,
              serviceId: row.service_id,
              status: row.public_status,
              customerErrorCode: row.customer_error_code,
              retryable: row.retryable,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
              completedAt: row.completed_at,
            }));
          },
        );
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw internalFailure(error);
      }
    },
  };
}
