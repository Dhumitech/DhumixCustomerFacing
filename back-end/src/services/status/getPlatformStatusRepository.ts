import type { Pool } from "pg";
import { ApplicationError } from "../../utils/applicationError.js";
import { withCustomerApiTransaction } from "../database/transactions.js";

export interface PlatformProductStatusRecord {
  readonly family: string;
  readonly state: string;
  readonly message?: string | null;
  readonly updatedAt: Date;
}

export interface GetPlatformStatusRepository {
  get(): Promise<readonly PlatformProductStatusRecord[]>;
}

interface PlatformStatusRow {
  readonly family: string;
  readonly state: string;
  readonly message: string | null;
  readonly updated_at: Date;
}

function internalFailure(cause: unknown): ApplicationError {
  return new ApplicationError({
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Internal server error",
    cause,
  });
}

export function createGetPlatformStatusRepository(
  pool: Pool,
  providerEnvironment: "local" | "test" | "production",
): GetPlatformStatusRepository {
  return {
    async get(): Promise<readonly PlatformProductStatusRecord[]> {
      try {
        return await withCustomerApiTransaction(pool, async (database) => {
          const result = await database.query<PlatformStatusRow>(
            `
              SELECT status.family, status.state, status.message, status.updated_at
              FROM app.get_platform_status_v2($1) AS status
            `,
            [providerEnvironment],
          );
          return result.rows.map((row) => ({
            family: row.family,
            state: row.state,
            message: row.message,
            updatedAt: row.updated_at,
          }));
        });
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw internalFailure(error);
      }
    },
  };
}
