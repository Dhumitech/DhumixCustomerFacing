import type { Pool } from "pg";
import { ApplicationError } from "../../utils/applicationError.js";
import { withTenantTransaction } from "../database/transactions.js";

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

export function createGetUsageSummaryRepository(
  pool: Pool,
): GetUsageSummaryRepository {
  return {
    async get(input): Promise<UsageSummaryRecord> {
      try {
        return await withTenantTransaction(
          pool,
          input.tenantId,
          async (database) => {
            const result = await database.query<UsageSummaryRow>(
              `
                SELECT
                  summary.meter_code,
                  summary.quantity::text AS quantity,
                  summary.unit,
                  summary.updated_at,
                  summary.reconciliation_state
                FROM app.get_usage_summary($1::timestamptz, $2::timestamptz)
                  AS summary
              `,
              [input.from, input.to],
            );
            const first = result.rows[0];
            if (first === undefined) {
              throw new Error("Usage summary function returned no projection row");
            }

            const items = result.rows.flatMap((row) => {
              if (
                row.meter_code === null ||
                row.quantity === null ||
                row.unit === null
              ) {
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
