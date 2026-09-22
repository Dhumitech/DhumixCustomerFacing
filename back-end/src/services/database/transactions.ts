import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import type { DatabaseExecutor, TransactionWork } from "../../types/database.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    | "SET LOCAL ROLE dhumi_envelope_janitor"
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
      throw new AggregateError([error, destroyConnection], "Database transaction and rollback failed");
    }
    throw error;
  } finally {
    client.release(destroyConnection);
  }
}

export async function withEnvelopeJanitorTransaction<Result>(
  pool: Pool,
  work: TransactionWork<Result>,
): Promise<Result> {
  return runTransaction(
    pool,
    "SET LOCAL ROLE dhumi_envelope_janitor",
    async () => undefined,
    work,
  );
}

export async function withIdentityTransaction<Result>(
  pool: Pool,
  work: TransactionWork<Result>,
): Promise<Result> {
  return runTransaction(pool, "SET LOCAL ROLE dhumi_identity", async () => undefined, work);
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
      const context = await client.query<{ tenant_id: string }>(
        "SELECT set_config('app.tenant_id', $1, true) AS tenant_id",
        [tenantId],
      );
      if (context.rows[0]?.tenant_id !== tenantId) {
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
    async () => undefined,
    work,
  );
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
      const context = await client.query<{ tenant_id: string }>(
        "SELECT set_config('app.tenant_id', $1, true) AS tenant_id",
        [tenantId],
      );
      if (context.rows[0]?.tenant_id !== tenantId) {
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
      const context = await client.query<{ tenant_id: string }>(
        "SELECT set_config('app.tenant_id', $1, true) AS tenant_id",
        [tenantId],
      );
      if (context.rows[0]?.tenant_id !== tenantId) {
        throw new Error("Transaction-local result-recorder Tenant context could not be established");
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
      const context = await client.query<{ tenant_id: string }>(
        "SELECT set_config('app.tenant_id', $1, true) AS tenant_id",
        [tenantId],
      );
      if (context.rows[0]?.tenant_id !== tenantId) {
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
