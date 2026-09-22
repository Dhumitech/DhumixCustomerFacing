import type { Pool } from "pg";
import { ApplicationError } from "../../utils/applicationError.js";
import { withIdentityTransaction } from "../database/transactions.js";

export interface BrowserSessionLookup {
  readonly userId: string;
  readonly sessionId: string;
}

export interface BrowserAuthenticationRepository {
  hasActiveSession(input: BrowserSessionLookup): Promise<boolean>;
}

function internalFailure(cause: unknown): ApplicationError {
  return new ApplicationError({
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Internal server error",
    cause,
  });
}

export function createBrowserAuthenticationRepository(
  pool: Pool,
): BrowserAuthenticationRepository {
  return {
    async hasActiveSession(input): Promise<boolean> {
      try {
        return await withIdentityTransaction(pool, async (database) => {
          const result = await database.query<{ authenticated: boolean }>(
            `
              SELECT EXISTS (
                SELECT 1
                FROM app.auth_sessions
                WHERE id = $1
                  AND user_id = $2
                  AND state = 'active'
                  AND clock_timestamp() < expires_at
              ) AS authenticated
            `,
            [input.sessionId, input.userId],
          );
          return result.rows[0]?.authenticated === true;
        });
      } catch (error) {
        if (error instanceof ApplicationError) {
          throw error;
        }
        throw internalFailure(error);
      }
    },
  };
}
