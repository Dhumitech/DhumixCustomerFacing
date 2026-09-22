import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import { createDatabasePools } from "../../src/services/database/pools.js";
import { verifyDatabasePools } from "../../src/services/database/roleVerification.js";
import {
  withAdmissionTenantTransaction,
  withIdentityTransaction,
  withTenantTransaction,
} from "../../src/services/database/transactions.js";

const databaseTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";

interface SignupFixture {
  readonly user_id: string;
  readonly tenant_id: string;
  readonly replayed: boolean;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

async function createSignupFixture(
  pool: Pool,
  fixtureName: "tenant-a" | "tenant-b",
): Promise<SignupFixture> {
  const fixture = await withIdentityTransaction(pool, async (database) => {
    const legalHash = sha256(`dhumi-runtime-test-legal-${fixtureName}`).toString("hex");
    const result = await database.query<SignupFixture>(
      `
        SELECT user_id, tenant_id, replayed
        FROM app.create_signup($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
      `,
      [
        `runtime-${fixtureName}@example.test`,
        "$argon2id$runtime-integration-fixture-not-a-real-password",
        `Runtime integration ${fixtureName}`,
        JSON.stringify([
          {
            document_type: "terms",
            document_version: "runtime-test-v1",
            document_hash_hex: legalHash,
            disclosure_version: "runtime-test-v1",
            locale: "en",
          },
        ]),
        `runtime-integration-signup-${fixtureName}`,
        sha256(`runtime-integration-request-${fixtureName}`),
        sha256(`runtime-integration-actor-${fixtureName}`),
        randomUUID(),
      ],
    );
    return result.rows[0];
  });

  if (fixture?.user_id === undefined || fixture.tenant_id === undefined) {
    throw new Error(`Could not establish deterministic ${fixtureName} database fixture`);
  }
  return fixture;
}

async function countTenantsWithoutContext(pool: Pool): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE dhumi_customer_api");
    const result = await client.query<{ count: string }>("SELECT count(*) FROM app.tenants");
    await client.query("ROLLBACK");
    return Number(result.rows[0]?.count ?? -1);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function assertCustomerCannotAssumeIdentity(pool: Pool): Promise<void> {
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await expect(client.query("SET LOCAL ROLE dhumi_identity")).rejects.toThrow();
  } finally {
    try {
      if (transactionStarted) {
        await client.query("ROLLBACK");
      }
    } finally {
      client.release();
    }
  }
}

describe.skipIf(!databaseTestsEnabled)("restricted database runtime connections", () => {
  it("enforces capability roles, Tenant RLS, transaction-local context and rollback", async () => {
    const config = loadRuntimeConfig();
    if (config.database.database !== "dhumi_test") {
      throw new Error("Database runtime integration tests may run only against dhumi_test");
    }

    const unexpectedPoolErrors: Error[] = [];
    const pools = createDatabasePools(config.database, (_poolName, error) => {
      unexpectedPoolErrors.push(error);
    });
    try {
      await verifyDatabasePools(
        pools,
        config.database.identity.user,
        config.database.customerApi.user,
        config.database.admission.user,
      );

      const identityRole = await withIdentityTransaction(pools.identity, async (database) => {
        const result = await database.query<{ current_role: string }>("SELECT current_role");
        return result.rows[0]?.current_role;
      });
      expect(identityRole).toBe("dhumi_identity");

      const admissionRole = await withAdmissionTenantTransaction(
        pools.admission,
        "11111111-1111-4111-8111-111111111111",
        async (database) => {
          const result = await database.query<{ current_role: string }>("SELECT current_role");
          return result.rows[0]?.current_role;
        },
      );
      expect(admissionRole).toBe("dhumi_admission");

      const tenantA = await createSignupFixture(pools.identity, "tenant-a");
      const tenantB = await createSignupFixture(pools.identity, "tenant-b");
      expect(tenantA.tenant_id).not.toBe(tenantB.tenant_id);

      expect(await countTenantsWithoutContext(pools.customerApi)).toBe(0);
      await assertCustomerCannotAssumeIdentity(pools.customerApi);

      const visibleTenantIds = await withTenantTransaction(
        pools.customerApi,
        tenantA.tenant_id,
        async (database) => {
          const result = await database.query<{ id: string }>(
            "SELECT id FROM app.tenants WHERE id IN ($1, $2) ORDER BY id",
            [tenantA.tenant_id, tenantB.tenant_id],
          );
          return result.rows.map((row) => row.id);
        },
      );
      expect(visibleTenantIds).toEqual([tenantA.tenant_id]);

      // SET LOCAL and the Tenant setting must disappear when the pooled
      // transaction ends. A reused connection without context sees no rows.
      expect(await countTenantsWithoutContext(pools.customerApi)).toBe(0);

      const rollbackRequestId = randomUUID();
      await expect(
        withIdentityTransaction(pools.identity, async (database) => {
          await database.query(
            `
              INSERT INTO app.audit_events (
                tenant_id, actor_user_id, action, target_type, target_id, outcome, request_id
              ) VALUES ($1, $2, 'runtime.rollback_test', 'tenant', $1, 'test', $3)
            `,
            [tenantA.tenant_id, tenantA.user_id, rollbackRequestId],
          );
          throw new Error("intentional rollback test");
        }),
      ).rejects.toThrow("intentional rollback test");

      const rolledBackCount = await withIdentityTransaction(pools.identity, async (database) => {
        const result = await database.query<{ count: string }>(
          "SELECT count(*) FROM app.audit_events WHERE request_id = $1",
          [rollbackRequestId],
        );
        return Number(result.rows[0]?.count ?? -1);
      });
      expect(rolledBackCount).toBe(0);
      expect(unexpectedPoolErrors).toEqual([]);
    } finally {
      await pools.close();
    }
  });
});
