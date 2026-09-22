import type { Pool } from "pg";
import { ApplicationError } from "../../utils/applicationError.js";
import { withTenantTransaction } from "../database/transactions.js";

export type WorkspaceState = "active" | "suspended" | "closing" | "closed";

export interface WorkspaceLookup {
  readonly userId: string;
  readonly tenantId: string;
}

export interface WorkspaceRecord {
  readonly id: string;
  readonly name: string;
  readonly state: WorkspaceState;
  readonly createdAt: Date;
}

export interface WorkspaceRepository {
  findBrowserWorkspace(input: WorkspaceLookup): Promise<WorkspaceRecord | undefined>;
  findApiKeyWorkspace(tenantId: string): Promise<WorkspaceRecord | undefined>;
}

interface WorkspaceRow {
  readonly id: string;
  readonly name: string;
  readonly state: WorkspaceState;
  readonly created_at: Date;
}

function internalFailure(cause: unknown): ApplicationError {
  return new ApplicationError({
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Internal server error",
    cause,
  });
}

export function createWorkspaceRepository(pool: Pool): WorkspaceRepository {
  async function findWorkspace(
    tenantId: string,
    userId: string | undefined,
  ): Promise<WorkspaceRecord | undefined> {
    return withTenantTransaction(pool, tenantId, async (database) => {
      const result = await database.query<WorkspaceRow>(
        `
          SELECT
            tenant.id,
            tenant.display_name AS name,
            tenant.state,
            tenant.created_at
          FROM app.tenants tenant
          WHERE tenant.id = $1
            AND tenant.state = 'active'
            AND (
              $2::uuid IS NULL
              OR EXISTS (
                SELECT 1
                FROM app.tenant_user_access access
                WHERE access.tenant_id = tenant.id
                  AND access.user_id = $2
                  AND access.state = 'active'
              )
            )
        `,
        [tenantId, userId ?? null],
      );

      const row = result.rows[0];
      return row === undefined
        ? undefined
        : { id: row.id, name: row.name, state: row.state, createdAt: row.created_at };
    });
  }

  return {
    async findBrowserWorkspace(input): Promise<WorkspaceRecord | undefined> {
      try {
        return await findWorkspace(input.tenantId, input.userId);
      } catch (error) {
        if (error instanceof ApplicationError) {
          throw error;
        }
        throw internalFailure(error);
      }
    },
    async findApiKeyWorkspace(tenantId): Promise<WorkspaceRecord | undefined> {
      try {
        return await findWorkspace(tenantId, undefined);
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw internalFailure(error);
      }
    },
  };
}
