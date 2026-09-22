import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import { createRetryRunRepository } from "../../src/services/admission/retryRunRepository.js";
import { createRetryRunService } from "../../src/services/admission/retryRunService.js";
import { createDatabasePools } from "../../src/services/database/pools.js";
import {
  withAdmissionTenantTransaction,
  withIdentityTransaction,
} from "../../src/services/database/transactions.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const config = enabled ? loadRuntimeConfig() : undefined;

if (enabled && config?.database.database !== "dhumi_test") {
  throw new Error("Retry-Run database tests may run only against dhumi_test");
}

const pools = enabled && config ? createDatabasePools(config.database, () => {}) : undefined;

afterAll(async () => {
  await pools?.close();
});

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("database integration configuration is unavailable");
  return value;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

async function fixture(): Promise<{ readonly userId: string; readonly tenantId: string }> {
  const nonce = randomUUID();
  return withIdentityTransaction(must(pools).identity, async (database) => {
    const result = await database.query<{ user_id: string; tenant_id: string }>(
      `
        SELECT user_id, tenant_id
        FROM app.create_signup($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
      `,
      [
        `run-retry-${nonce}@example.test`,
        "$argon2id$run-retry-fixture-not-a-real-password",
        `Run retry ${nonce.slice(0, 8)}`,
        JSON.stringify([
          {
            document_type: "terms",
            document_version: "run-retry-v1",
            document_hash_hex: sha256(`run-retry-legal-${nonce}`).toString("hex"),
            disclosure_version: "run-retry-v1",
            locale: "en",
          },
        ]),
        `run-retry-signup-${nonce}`,
        sha256(`run-retry-request-${nonce}`),
        sha256(`run-retry-actor-${nonce}`),
        randomUUID(),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("Could not establish a Retry-Run fixture");
    return { userId: row.user_id, tenantId: row.tenant_id };
  });
}

describe.skipIf(!enabled)("retry Run against PostgreSQL", () => {
  it("enforces migration 0022 integrity and narrow Admission capability", async () => {
    const current = await fixture();
    const evidence = await withAdmissionTenantTransaction(
      must(pools).admission,
      current.tenantId,
      async (database) => {
        const constraints = await database.query<{ conname: string }>(
          `
            SELECT conname
            FROM pg_constraint
            WHERE connamespace = 'app'::regnamespace
              AND conname IN (
                'idempotency_records_run_retry_semantics_check',
                'runs_retry_not_self_check'
              )
            ORDER BY conname
          `,
        );
        const functionEvidence = await database.query<{
          present: boolean;
          definer: boolean;
          execute: boolean;
          customer_execute: boolean;
        }>(
          `
            SELECT
              to_regprocedure('app.lock_run_for_retry(uuid)') IS NOT NULL AS present,
              (SELECT prosecdef FROM pg_proc
                WHERE oid = to_regprocedure('app.lock_run_for_retry(uuid)')) AS definer,
              has_function_privilege(
                current_user, 'app.lock_run_for_retry(uuid)', 'EXECUTE'
              ) AS execute,
              has_function_privilege(
                'dhumi_customer_api', 'app.lock_run_for_retry(uuid)', 'EXECUTE'
              ) AS customer_execute
          `,
        );
        const privileges = await database.query<{
          lineage_insert: boolean;
          input_select: boolean;
          attempt_state_select: boolean;
          run_update: boolean;
          related_select: boolean;
          related_update: boolean;
          tenant_update: boolean;
        }>(
          `
            SELECT
              has_column_privilege(current_user, 'app.runs', 'retry_of_run_id', 'INSERT') AS lineage_insert,
              has_column_privilege(current_user, 'app.runs', 'validated_input', 'SELECT') AS input_select,
              has_column_privilege(current_user, 'app.run_attempts', 'state', 'SELECT') AS attempt_state_select,
              has_table_privilege(current_user, 'app.runs', 'UPDATE') AS run_update,
              has_column_privilege(
                current_user,
                'app.idempotency_records',
                'related_resource_id',
                'SELECT'
              ) AS related_select,
              has_column_privilege(
                current_user,
                'app.idempotency_records',
                'related_resource_id',
                'UPDATE'
              ) AS related_update,
              has_column_privilege(
                current_user,
                'app.idempotency_records',
                'tenant_id',
                'UPDATE'
              ) AS tenant_update
          `,
        );
        const ownerPolicy = await database.query<{ owner_admitted: boolean }>(
          `
            SELECT EXISTS (
              SELECT 1
              FROM pg_policy
              WHERE polrelid = 'app.service_versions'::regclass
                AND polname = 'service_versions_tenant_isolation'
                AND 'dhumi_owner'::regrole::oid = ANY(polroles)
                AND pg_get_expr(polqual, polrelid) =
                  '(tenant_id = app.current_tenant_id())'
                AND pg_get_expr(polwithcheck, polrelid) =
                  '(tenant_id = app.current_tenant_id())'
            ) AS owner_admitted
          `,
        );
        return {
          constraints: constraints.rows.map((row) => row.conname),
          functionEvidence: functionEvidence.rows[0],
          privileges: privileges.rows[0],
          ownerPolicy: ownerPolicy.rows[0],
        };
      },
    );
    expect(evidence.constraints).toEqual([
      "idempotency_records_run_retry_semantics_check",
      "runs_retry_not_self_check",
    ]);
    expect(evidence.functionEvidence).toEqual({
      present: true,
      definer: true,
      execute: true,
      customer_execute: false,
    });
    expect(evidence.privileges).toEqual({
      lineage_insert: true,
      input_select: false,
      attempt_state_select: false,
      run_update: false,
      related_select: true,
      related_update: true,
      tenant_update: false,
    });
    expect(evidence.ownerPolicy).toEqual({ owner_admitted: true });
  });

  it("rolls back a retry claim when the Tenant-owned source is absent", async () => {
    const current = await fixture();
    const key = `run-retry-missing-${randomUUID()}`;
    const validate = vi.fn(() => ({ valid: true as const, schemaHash: Buffer.alloc(32) }));
    const target = createRetryRunService({
      repository: createRetryRunRepository(must(pools).admission),
      validator: { validate },
      csrf: { issue: () => "unused", verify: () => true },
      providerEnvironment: "test",
    });
    await expect(
      target.retry({
        principal: {
          kind: "browser",
          ...current,
          sessionId: randomUUID(),
        },
        csrfToken: "valid-csrf-token-value",
        idempotencyKey: key,
        runId: randomUUID(),
        bodyPresent: false,
        schemaErrors: [],
        requestId: randomUUID(),
        ipFingerprint: sha256("127.0.0.1"),
      }),
    ).rejects.toMatchObject({ status: 404, code: "RESOURCE_NOT_FOUND" });
    expect(validate).not.toHaveBeenCalled();

    const count = await withIdentityTransaction(must(pools).identity, async (database) => {
      const result = await database.query<{ count: string }>(
        `
          SELECT count(*)::text AS count
          FROM app.idempotency_records
          WHERE tenant_id = $1
            AND operation_code = 'runs.retry'
            AND idempotency_key = $2
        `,
        [current.tenantId, key],
      );
      return result.rows[0]?.count;
    });
    expect(count).toBe("0");
  });

  it("fails closed when Admission has no trusted Tenant context", async () => {
    const client = await must(pools).admission.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE dhumi_admission");
      await expect(
        client.query("SELECT * FROM app.lock_run_for_retry($1::uuid)", [randomUUID()]),
      ).rejects.toThrow();
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
