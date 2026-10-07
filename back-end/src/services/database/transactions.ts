import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import type { DatabaseExecutor, TransactionWork } from "../../types/database.js";
import { ApplicationError } from "../../utils/applicationError.js";
import { authenticationRequired } from "../identity/sessionErrors.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function executorFor(client: PoolClient): DatabaseExecutor {
  return {
    async query<Row extends QueryResultRow = QueryResultRow>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<QueryResult<Row>> {
      return client.query<Row>(text, [...values]);
    },
  };
}

async function rollback(client: PoolClient): Promise<Error | undefined> {
  try {
    await client.query("ROLLBACK");
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error("Database rollback failed");
  }
}

async function runTransaction<Result>(
  pool: Pool,
  capabilityStatement:
    | "SET LOCAL ROLE dhumi_identity"
    | "SET LOCAL ROLE dhumi_customer_api"
    | "SET LOCAL ROLE dhumi_admission"
    | "SET LOCAL ROLE dhumi_result_recorder"
    | "SET LOCAL ROLE dhumi_outbox_dispatcher"
    | "SET LOCAL ROLE dhumi_job_manager"
    | "SET LOCAL ROLE dhumi_operator",
  setup: (client: PoolClient) => Promise<void>,
  work: TransactionWork<Result>,
): Promise<Result> {
  const client = await pool.connect();
  let destroyConnection: Error | undefined;

  try {
    await client.query("BEGIN");
    await client.query(capabilityStatement);
    await setup(client);
    const result = await work(executorFor(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    destroyConnection = await rollback(client);
    if (destroyConnection !== undefined) {
      throw new AggregateError(
        [error, destroyConnection],
        "Database transaction and rollback failed",
      );
    }
    throw error;
  } finally {
    client.release(destroyConnection);
  }
}

export async function withIdentityTransaction<Result>(
  pool: Pool,
  work: TransactionWork<Result>,
): Promise<Result> {
  return runTransaction(
    pool,
    "SET LOCAL ROLE dhumi_identity",
    async (client) => {
      await client.query(
        "SELECT set_config('app.user_id', '', true), set_config('app.organization_id', '', true), set_config('app.verification_id', '', true), set_config('app.invite_token_hash', '', true)",
      );
    },
    work,
  );
}

/** Bind a backend-authenticated user for identity-capability RLS reads. */
export async function withIdentityUserTransaction<Result>(
  pool: Pool,
  userId: string,
  work: TransactionWork<Result>,
): Promise<Result> {
  if (!UUID_PATTERN.test(userId)) throw new TypeError("userId must be a valid UUID");
  return withIdentityTransaction(pool, async (database) => {
    const context = await database.query<{ user_id: string }>(
      "SELECT set_config('app.user_id', $1, true) AS user_id",
      [userId],
    );
    if (context.rows[0]?.user_id !== userId)
      throw new Error("Transaction-local User context could not be established");
    return work(database);
  });
}

export async function withTenantTransaction<Result>(
  pool: Pool,
  tenantId: string,
  work: TransactionWork<Result>,
): Promise<Result> {
  if (!UUID_PATTERN.test(tenantId)) {
    throw new TypeError("tenantId must be a valid UUID");
  }

  return runTransaction(
    pool,
    "SET LOCAL ROLE dhumi_customer_api",
    async (client) => {
      const context = await client.query<{ organization_id: string }>(
        "SELECT set_config('app.organization_id', $1, true) AS organization_id",
        [tenantId],
      );
      if (context.rows[0]?.organization_id !== tenantId) {
        throw new Error("Transaction-local Tenant context could not be established");
      }
    },
    work,
  );
}

/**
 * Runs a global, customer-safe read through the existing customer API
 * capability without manufacturing a Tenant context. Only database functions
 * explicitly granted to that capability can be reached through this seam.
 */
export async function withCustomerApiTransaction<Result>(
  pool: Pool,
  work: TransactionWork<Result>,
): Promise<Result> {
  return runTransaction(
    pool,
    "SET LOCAL ROLE dhumi_customer_api",
    async (client) => {
      await client.query(
        "SELECT set_config('app.user_id', '', true), set_config('app.organization_id', '', true)",
      );
    },
    work,
  );
}

export interface OrganizationTransactionContext {
  readonly userId: string;
  readonly tenantId: string;
}

export interface BrowseTransactionContext {
  readonly userId: string;
  readonly tenantId?: string;
}

function organizationNotFound(): ApplicationError {
  return new ApplicationError({
    status: 404,
    code: "RESOURCE_NOT_FOUND",
    title: "Organization not found",
  });
}

async function withCustomerContext<Result>(
  pool: Pool,
  context: BrowseTransactionContext,
  role: "SET LOCAL ROLE dhumi_customer_api" | "SET LOCAL ROLE dhumi_admission",
  access: "read" | "write" | "browse",
  work: TransactionWork<Result>,
): Promise<Result> {
  if (!UUID_PATTERN.test(context.userId)) throw new TypeError("userId must be a valid UUID");
  if (context.tenantId !== undefined && !UUID_PATTERN.test(context.tenantId)) {
    throw new TypeError("tenantId must be a valid UUID");
  }
  const lockMembership = access === "write";
  if (access !== "browse" && context.tenantId === undefined) {
    throw new TypeError("An organization is required for a protected resource transaction");
  }
  return runTransaction(
    pool,
    role,
    async (client) => {
      await client.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      const established = await client.query<{ user_id: string; organization_id: string }>(
        "SELECT set_config('app.user_id', $1, true) AS user_id, set_config('app.organization_id', $2, true) AS organization_id",
        [context.userId, context.tenantId ?? ""],
      );
      if (
        established.rows[0]?.user_id !== context.userId ||
        established.rows[0]?.organization_id !== (context.tenantId ?? "")
      ) {
        throw new Error("Transaction-local customer context could not be established");
      }
      const user = await client.query<{ id: string }>(
        "SELECT id FROM app.users WHERE id = $1 AND state = 'active'",
        [context.userId],
      );
      if (user.rows[0]?.id !== context.userId) throw authenticationRequired();
      if (context.tenantId === undefined) return;

      // Static variants: never interpolate request data or hold these locks over
      // storage/provider calls. Every writer uses organization -> membership.
      const organization = await client.query<{ id: string }>(
        lockMembership
          ? "SELECT id FROM app.organizations WHERE id = $1 AND state = 'active' FOR SHARE"
          : "SELECT id FROM app.organizations WHERE id = $1 AND state = 'active'",
        [context.tenantId],
      );
      if (organization.rows[0]?.id !== context.tenantId) throw organizationNotFound();
      const membership = await client.query<{ user_id: string }>(
        lockMembership
          ? "SELECT user_id FROM app.organization_members WHERE organization_id = $1 AND user_id = $2 AND state = 'active' FOR SHARE"
          : "SELECT user_id FROM app.organization_members WHERE organization_id = $1 AND user_id = $2 AND state = 'active'",
        [context.tenantId, context.userId],
      );
      if (membership.rows[0]?.user_id !== context.userId) throw organizationNotFound();
    },
    work,
  );
}

/** Organization reads recheck scope in the resource transaction, without locks. */
export function withOrganizationReadTransaction<Result>(
  pool: Pool,
  context: OrganizationTransactionContext,
  work: TransactionWork<Result>,
): Promise<Result> {
  return withCustomerContext(pool, context, "SET LOCAL ROLE dhumi_customer_api", "read", work);
}

/** Administration takes the exclusive organization lock before member locks.
 * Never enter through the ordinary FOR SHARE guard and upgrade its lock. */
export function withOrganizationAdministrationTransaction<Result>(
  pool: Pool,
  context: OrganizationTransactionContext,
  work: TransactionWork<Result>,
): Promise<Result> {
  if (!UUID_PATTERN.test(context.userId) || !UUID_PATTERN.test(context.tenantId))
    throw new TypeError("Organization context must contain valid UUIDs");
  return runTransaction(pool, "SET LOCAL ROLE dhumi_customer_api", async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    const established = await client.query<{ user_id: string; organization_id: string }>(
      "SELECT set_config('app.user_id', $1, true) AS user_id, set_config('app.organization_id', $2, true) AS organization_id",
      [context.userId, context.tenantId],
    );
    if (established.rows[0]?.user_id !== context.userId || established.rows[0]?.organization_id !== context.tenantId)
      throw new Error("Transaction-local administration context could not be established");
    const user = await client.query<{ id: string }>(
      "SELECT id FROM app.users WHERE id = $1 AND state = 'active'", [context.userId],
    );
    if (user.rows[0]?.id !== context.userId) throw authenticationRequired();
    const organization = await client.query<{ id: string }>(
      "SELECT id FROM app.organizations WHERE id = $1 AND state = 'active' FOR UPDATE", [context.tenantId],
    );
    if (organization.rows[0]?.id !== context.tenantId) throw organizationNotFound();
    const members = await client.query<{ user_id: string; role: string; state: string }>(
      "SELECT user_id, role, state FROM app.organization_members WHERE organization_id = $1 ORDER BY user_id FOR UPDATE",
      [context.tenantId],
    );
    if (!members.rows.some((member) => member.user_id === context.userId && member.state === 'active' && member.role === 'admin'))
      throw new ApplicationError({ status: 403, code: "ACCESS_DENIED", title: "Organization administrator required" });
  }, work);
}

/** Customer writes hold organization and membership locks through commit. */
export function withOrganizationWriteTransaction<Result>(
  pool: Pool,
  context: OrganizationTransactionContext,
  work: TransactionWork<Result>,
): Promise<Result> {
  return withCustomerContext(pool, context, "SET LOCAL ROLE dhumi_customer_api", "write", work);
}

/** Admission uses its existing capability; never switches to an identity/admin role. */
export function withAdmissionOrganizationTransaction<Result>(
  pool: Pool,
  context: OrganizationTransactionContext,
  work: TransactionWork<Result>,
): Promise<Result> {
  return withCustomerContext(pool, context, "SET LOCAL ROLE dhumi_admission", "write", work);
}

/** Signed-in catalogue/sample reads may establish an empty organization context. */
export function withBrowseTransaction<Result>(
  pool: Pool,
  context: BrowseTransactionContext,
  work: TransactionWork<Result>,
): Promise<Result> {
  return withCustomerContext(pool, context, "SET LOCAL ROLE dhumi_customer_api", "browse", work);
}

export async function withAdmissionTenantTransaction<Result>(
  pool: Pool,
  tenantId: string,
  work: TransactionWork<Result>,
): Promise<Result> {
  if (!UUID_PATTERN.test(tenantId)) {
    throw new TypeError("tenantId must be a valid UUID");
  }

  return runTransaction(
    pool,
    "SET LOCAL ROLE dhumi_admission",
    async (client) => {
      const context = await client.query<{ organization_id: string }>(
        "SELECT set_config('app.organization_id', $1, true) AS organization_id",
        [tenantId],
      );
      if (context.rows[0]?.organization_id !== tenantId) {
        throw new Error("Transaction-local admission Tenant context could not be established");
      }
    },
    work,
  );
}

export async function withResultRecorderTenantTransaction<Result>(
  pool: Pool,
  tenantId: string,
  work: TransactionWork<Result>,
): Promise<Result> {
  if (!UUID_PATTERN.test(tenantId)) {
    throw new TypeError("tenantId must be a valid UUID");
  }

  return runTransaction(
    pool,
    "SET LOCAL ROLE dhumi_result_recorder",
    async (client) => {
      const context = await client.query<{ organization_id: string }>(
        "SELECT set_config('app.organization_id', $1, true) AS organization_id",
        [tenantId],
      );
      if (context.rows[0]?.organization_id !== tenantId) {
        throw new Error(
          "Transaction-local result-recorder Tenant context could not be established",
        );
      }
    },
    work,
  );
}

export async function withOutboxDispatcherTransaction<Result>(
  pool: Pool,
  work: TransactionWork<Result>,
): Promise<Result> {
  return runTransaction(
    pool,
    "SET LOCAL ROLE dhumi_outbox_dispatcher",
    async () => undefined,
    work,
  );
}

export async function withJobManagerTenantTransaction<Result>(
  pool: Pool,
  tenantId: string,
  work: TransactionWork<Result>,
): Promise<Result> {
  if (!UUID_PATTERN.test(tenantId)) {
    throw new TypeError("tenantId must be a valid UUID");
  }

  return runTransaction(
    pool,
    "SET LOCAL ROLE dhumi_job_manager",
    async (client) => {
      const context = await client.query<{ organization_id: string }>(
        "SELECT set_config('app.organization_id', $1, true) AS organization_id",
        [tenantId],
      );
      if (context.rows[0]?.organization_id !== tenantId) {
        throw new Error("Transaction-local Job Manager Tenant context could not be established");
      }
    },
    work,
  );
}

export async function withOperatorTransaction<Result>(
  pool: Pool,
  work: TransactionWork<Result>,
): Promise<Result> {
  return runTransaction(pool, "SET LOCAL ROLE dhumi_operator", async () => undefined, work);
}
