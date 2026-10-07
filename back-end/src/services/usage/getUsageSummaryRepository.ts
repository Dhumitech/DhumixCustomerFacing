import type { Pool } from "pg";
import { ApplicationError } from "../../utils/applicationError.js";
import { withOrganizationReadTransaction } from "../database/transactions.js";

export interface UsageSummaryItemRecord {
  readonly meter: string;
  readonly quantity: string;
  readonly unit: string;
}

export interface UsageSummaryRecord {
  readonly items: readonly UsageSummaryItemRecord[];
  readonly updatedAt: Date;
  readonly state: string;
}

export interface GetUsageSummaryRepositoryInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly from: string;
  readonly to: string;
}

export interface GetUsageSummaryRepository {
  get(input: GetUsageSummaryRepositoryInput): Promise<UsageSummaryRecord>;
}

interface UsageSummaryRow {
  readonly meter_code: string | null;
  readonly quantity: string | null;
  readonly unit: string | null;
  readonly updated_at: Date;
  readonly reconciliation_state: string;
}

function internalFailure(cause: unknown): ApplicationError {
  return new ApplicationError({
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Internal server error",
    cause,
  });
}

export function createGetUsageSummaryRepository(pool: Pool): GetUsageSummaryRepository {
  return {
    async get(input): Promise<UsageSummaryRecord> {
      try {
        return await withOrganizationReadTransaction(
          pool,
          { tenantId: input.tenantId, userId: input.userId },
          async (database) => {
            const result = await database.query<UsageSummaryRow>(
              `
                WITH totals AS MATERIALIZED (
                  SELECT meter_code,sum(quantity)::text quantity,unit FROM app.usage_events
                  WHERE organization_id=app.current_organization_id() AND observed_at>=$1::timestamptz AND observed_at<$2::timestamptz
                    AND source='artifact' AND outcome='succeeded' GROUP BY meter_code,unit
                ) SELECT meter_code,quantity,unit,transaction_timestamp() updated_at,'observed'::text reconciliation_state FROM totals
                UNION ALL SELECT NULL,NULL,NULL,transaction_timestamp(),'observed' WHERE NOT EXISTS(SELECT 1 FROM totals)
                ORDER BY 1 NULLS LAST,3 NULLS LAST
              `,
              [input.from, input.to],
            );
            const first = result.rows[0];
            if (first === undefined) {
              throw new Error("Usage summary function returned no projection row");
            }

            const items = result.rows.flatMap((row) => {
              if (row.meter_code === null || row.quantity === null || row.unit === null) {
                return [];
              }
              return [
                {
                  meter: row.meter_code,
                  quantity: row.quantity,
                  unit: row.unit,
                },
              ];
            });

            return {
              items,
              updatedAt: first.updated_at,
              state: first.reconciliation_state,
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
