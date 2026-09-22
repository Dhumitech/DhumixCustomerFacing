import type { Pool } from "pg";
import { ApplicationError } from "../../utils/applicationError.js";
import { withIdentityTransaction } from "../database/transactions.js";

export interface ActiveTenantCandidate {
  readonly tenantId: string;
}

export interface TenantAuthorizationRepository {
  findActiveTenantCandidates(userId: string): Promise<readonly ActiveTenantCandidate[]>;
}

interface ActiveTenantCandidateRow {
  readonly tenant_id: string;
}

function internalFailure(cause: unknown): ApplicationError {
  return new ApplicationError({
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Internal server error",
    cause,
  });
}

export function createTenantAuthorizationRepository(
  pool: Pool,
): TenantAuthorizationRepository {
  return {
    async findActiveTenantCandidates(userId): Promise<readonly ActiveTenantCandidate[]> {
      try {
        return await withIdentityTransaction(pool, async (database) => {
          const result = await database.query<ActiveTenantCandidateRow>(
            `
              SELECT access.tenant_id
              FROM app.users identity
              JOIN app.tenant_user_access access
                ON access.user_id = identity.id
              JOIN app.tenants tenant
                ON tenant.id = access.tenant_id
              WHERE identity.id = $1
                AND identity.state = 'active'
                AND access.state = 'active'
                AND tenant.state = 'active'
              ORDER BY access.created_at, access.tenant_id
              LIMIT 2
            `,
            [userId],
          );

          return result.rows.map((row) => ({ tenantId: row.tenant_id }));
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
