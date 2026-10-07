import type { Pool } from "pg";
import { ApplicationError } from "../../utils/applicationError.js";
import { withOrganizationReadTransaction } from "../database/transactions.js";

export type WorkspaceState = "active" | "suspended" | "closing" | "closed";

export interface WorkspaceLookup {
  readonly userId: string;
  readonly tenantId: string;
}

export interface WorkspaceRecord {
  readonly role: "member" | "admin";
  readonly id: string;
  readonly name: string;
  readonly state: WorkspaceState;
  readonly createdAt: Date;
}

export interface WorkspaceRepository {
  findBrowserWorkspace(input: WorkspaceLookup): Promise<WorkspaceRecord | undefined>;
}

interface WorkspaceRow {
  readonly role: "member" | "admin";
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
    userId: string,
  ): Promise<WorkspaceRecord | undefined> {
    return withOrganizationReadTransaction(pool, { tenantId, userId }, async (database) => {
      const result = await database.query<WorkspaceRow>(
        `
          SELECT
            tenant.id,
            tenant.name AS name,
            tenant.state,
            tenant.created_at
            , (SELECT role FROM app.organization_members WHERE organization_id = tenant.id AND user_id = $2 AND state = 'active') AS role
          FROM app.organizations tenant
          WHERE tenant.id = $1
            AND tenant.state = 'active'
            AND EXISTS (
                SELECT 1
                FROM app.organization_members access
                WHERE access.organization_id = tenant.id
                  AND access.user_id = $2
                  AND access.state = 'active'
            )
        `,
        [tenantId, userId],
      );

      const row = result.rows[0];
      return row === undefined
        ? undefined
        : { id: row.id, name: row.name, state: row.state, createdAt: row.created_at, role: row.role };
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
  };
}
