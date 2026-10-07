import type { Pool } from "pg";
import { ApplicationError } from "../../utils/applicationError.js";
import { withOrganizationReadTransaction } from "../database/transactions.js";

export interface ListUsageEventsRecord {
  readonly id: string;
  readonly runId: string;
  readonly productFamily: string;
  readonly meter: string;
  readonly quantity: string;
  readonly unit: string;
  readonly outcome: string;
  readonly observedAt: Date;
  readonly cursorObservedAt: string;
}

export interface ListUsageEventsRepositoryInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly from: string;
  readonly to: string;
  readonly beforeObservedAt: string | undefined;
  readonly beforeId: string | undefined;
  readonly fetchLimit: number;
}

export interface ListUsageEventsRepository {
  findPage(input: ListUsageEventsRepositoryInput): Promise<readonly ListUsageEventsRecord[]>;
}

interface UsageEventRow {
  readonly id: string;
  readonly run_id: string;
  readonly product_family: string;
  readonly meter_code: string;
  readonly quantity: string;
  readonly unit: string;
  readonly outcome: string;
  readonly observed_at: Date;
  readonly cursor_observed_at: string;
}

function internalFailure(cause: unknown): ApplicationError {
  return new ApplicationError({
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Internal server error",
    cause,
  });
}

export function createListUsageEventsRepository(pool: Pool): ListUsageEventsRepository {
  return {
    async findPage(input): Promise<readonly ListUsageEventsRecord[]> {
      if (!Number.isInteger(input.fetchLimit) || input.fetchLimit < 2 || input.fetchLimit > 101) {
        throw new TypeError("fetchLimit must be an integer between 2 and 101");
      }

      try {
        return await withOrganizationReadTransaction(
          pool,
          { tenantId: input.tenantId, userId: input.userId },
          async (database) => {
            const result = await database.query<UsageEventRow>(
              `
                SELECT
                  event.id,
                  event.run_id,
                  template.product_family,
                  event.meter_code,
                  event.quantity::text AS quantity,
                  event.unit,
                  event.outcome,
                  event.observed_at,
                  to_char(
                    event.observed_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                  ) AS cursor_observed_at
                FROM app.usage_events event JOIN app.runs run ON run.organization_id=event.organization_id AND run.id=event.run_id
                JOIN app.service_template_versions version ON version.id=run.template_version_id
                JOIN app.service_templates template ON template.id=version.service_template_id
                WHERE event.organization_id=app.current_organization_id() AND event.observed_at>=$1::timestamptz AND event.observed_at<$2::timestamptz
                  AND ($3::timestamptz IS NULL OR (event.observed_at,event.id)<($3::timestamptz,$4::uuid))
                ORDER BY event.observed_at DESC,event.id DESC LIMIT $5::integer
              `,
              [
                input.from,
                input.to,
                input.beforeObservedAt ?? null,
                input.beforeId ?? null,
                input.fetchLimit,
              ],
            );

            return result.rows.map((row) => ({
              id: row.id,
              runId: row.run_id,
              productFamily: row.product_family,
              meter: row.meter_code,
              quantity: row.quantity,
              unit: row.unit,
              outcome: row.outcome,
              observedAt: row.observed_at,
              cursorObservedAt: row.cursor_observed_at,
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
