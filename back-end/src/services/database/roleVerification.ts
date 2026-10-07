import type { Pool, QueryResultRow } from "pg";
import type { DatabasePools } from "./pools.js";

const CAPABILITY_ROLES = [
  "dhumi_customer_api",
  "dhumi_identity",
  "dhumi_admission",
  "dhumi_job_manager",
  "dhumi_result_recorder",
  "dhumi_outbox_dispatcher",
  "dhumi_envelope_janitor",
  "dhumi_operator",
  "dhumi_owner",
] as const;

type CapabilityRole = (typeof CAPABILITY_ROLES)[number];

interface RoleAttributesRow extends QueryResultRow {
  readonly rolname: string;
  readonly rolinherit: boolean;
  readonly rolsuper: boolean;
  readonly rolcreatedb: boolean;
  readonly rolcreaterole: boolean;
  readonly rolreplication: boolean;
  readonly rolbypassrls: boolean;
}

interface MembershipRow extends QueryResultRow {
  readonly role_name: string;
  readonly is_member: boolean;
}

function roleStatement(role: CapabilityRole): string {
  switch (role) {
    case "dhumi_identity":
      return "SET LOCAL ROLE dhumi_identity";
    case "dhumi_customer_api":
      return "SET LOCAL ROLE dhumi_customer_api";
    case "dhumi_admission":
      return "SET LOCAL ROLE dhumi_admission";
    case "dhumi_result_recorder":
      return "SET LOCAL ROLE dhumi_result_recorder";
    case "dhumi_outbox_dispatcher":
      return "SET LOCAL ROLE dhumi_outbox_dispatcher";
    case "dhumi_job_manager":
      return "SET LOCAL ROLE dhumi_job_manager";
    case "dhumi_operator":
      return "SET LOCAL ROLE dhumi_operator";
    default:
      throw new Error(`Runtime startup cannot assume capability role ${role}`);
  }
}

export async function verifyPoolRole(
  pool: Pool,
  expectedLoginRole: string,
  expectedCapabilityRole:
    | "dhumi_identity"
    | "dhumi_customer_api"
      | "dhumi_admission"
      | "dhumi_result_recorder"
      | "dhumi_outbox_dispatcher"
      | "dhumi_job_manager"
      | "dhumi_operator",
): Promise<void> {
  const attributes = await pool.query<RoleAttributesRow>(`
    SELECT
      rolname,
      rolinherit,
      rolsuper,
      rolcreatedb,
      rolcreaterole,
      rolreplication,
      rolbypassrls
    FROM pg_roles
    WHERE rolname = current_user
  `);

  const role = attributes.rows[0];
  if (attributes.rowCount !== 1 || role === undefined || role.rolname !== expectedLoginRole) {
    throw new Error("Database connection did not use the configured runtime LOGIN role");
  }

  if (
    role.rolinherit ||
    role.rolsuper ||
    role.rolcreatedb ||
    role.rolcreaterole ||
    role.rolreplication ||
    role.rolbypassrls
  ) {
    throw new Error(`Database runtime LOGIN role ${expectedLoginRole} has unsafe attributes`);
  }

  const memberships = await pool.query<MembershipRow>(
    `
      SELECT role_name, pg_has_role(current_user, role_name::name, 'MEMBER') AS is_member
      FROM unnest($1::text[]) AS role_list(role_name)
      ORDER BY role_name
    `,
    [[...CAPABILITY_ROLES]],
  );

  const activeMemberships = memberships.rows
    .filter((membership) => membership.is_member)
    .map((membership) => membership.role_name);

  if (
    activeMemberships.length !== 1 ||
    activeMemberships[0] !== expectedCapabilityRole
  ) {
    throw new Error(
      `Database runtime LOGIN role ${expectedLoginRole} must belong only to ${expectedCapabilityRole}`,
    );
  }

  const client = await pool.connect();
  let destroyConnection: Error | undefined;
  try {
    await client.query("BEGIN");
    await client.query(roleStatement(expectedCapabilityRole));
    const assumed = await client.query<{ current_role: string }>("SELECT current_role");
    if (assumed.rows[0]?.current_role !== expectedCapabilityRole) {
      throw new Error(`Could not assume required capability role ${expectedCapabilityRole}`);
    }
    await client.query("ROLLBACK");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      destroyConnection =
        rollbackError instanceof Error ? rollbackError : new Error("Database rollback failed");
    }
    throw error;
  } finally {
    client.release(destroyConnection);
  }
}

export async function verifyResultRecorderPool(
  pool: Pool,
  expectedLoginRole: string,
): Promise<void> {
  await verifyPoolRole(pool, expectedLoginRole, "dhumi_result_recorder");
}

export async function verifyOutboxDispatcherPool(
  pool: Pool,
  expectedLoginRole: string,
): Promise<void> {
  await verifyPoolRole(pool, expectedLoginRole, "dhumi_outbox_dispatcher");
}

export async function verifyJobManagerPool(
  pool: Pool,
  expectedLoginRole: string,
): Promise<void> {
  await verifyPoolRole(pool, expectedLoginRole, "dhumi_job_manager");
}

export async function verifyOperatorPool(
  pool: Pool,
  expectedLoginRole: string,
): Promise<void> {
  await verifyPoolRole(pool, expectedLoginRole, "dhumi_operator");
}

export async function verifyDatabasePools(
  pools: DatabasePools,
  expectedIdentityLogin: string,
  expectedCustomerApiLogin: string,
  expectedAdmissionLogin: string,
): Promise<void> {
  await Promise.all([
    verifyPoolRole(pools.identity, expectedIdentityLogin, "dhumi_identity"),
    verifyPoolRole(pools.customerApi, expectedCustomerApiLogin, "dhumi_customer_api"),
    verifyPoolRole(pools.admission, expectedAdmissionLogin, "dhumi_admission"),
  ]);
}
