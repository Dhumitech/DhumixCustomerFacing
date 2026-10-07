import type { Pool } from "pg";
import { ApplicationError } from "../../utils/applicationError.js";
import { withIdentityUserTransaction } from "../database/transactions.js";

export interface ActiveTenantCandidate {
  readonly tenantId: string;
}

export interface TenantAuthorizationRepository {
  findActiveTenantCandidates(userId: string, organizationId?: string): Promise<readonly ActiveTenantCandidate[]>;
}

interface ActiveTenantCandidateRow {
  readonly organization_id: string;
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
    async findActiveTenantCandidates(userId, organizationId): Promise<readonly ActiveTenantCandidate[]> {
      try {
        return await withIdentityUserTransaction(pool, userId, async (database) => {
          const result = await database.query<ActiveTenantCandidateRow>(
            `
              SELECT access.organization_id
              FROM app.users identity
              JOIN app.organization_members access
                ON access.user_id = identity.id
              JOIN app.organizations tenant
                ON tenant.id = access.organization_id
              WHERE identity.id = $1
                AND identity.state = 'active'
                AND access.state = 'active'
                AND tenant.state = 'active'
                AND ($2::uuid IS NULL OR access.organization_id = $2::uuid)
              ORDER BY access.created_at, access.organization_id
              LIMIT 2
            `,
            [userId, organizationId ?? null],
          );

          return result.rows.map((row) => ({ tenantId: row.organization_id }));
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
