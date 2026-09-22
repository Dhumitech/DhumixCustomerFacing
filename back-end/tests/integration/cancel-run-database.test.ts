import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import { createCancelRunRepository } from "../../src/services/admission/cancelRunRepository.js";
import { createCancelRunService } from "../../src/services/admission/cancelRunService.js";
import { createDatabasePools } from "../../src/services/database/pools.js";
import {
  withAdmissionTenantTransaction,
  withIdentityTransaction,
} from "../../src/services/database/transactions.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const config = enabled ? loadRuntimeConfig() : undefined;

if (enabled && config?.database.database !== "dhumi_test") {
  throw new Error("Cancel-Run database tests may run only against dhumi_test");
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
        `run-cancel-${nonce}@example.test`,
        "$argon2id$run-cancel-fixture-not-a-real-password",
        `Run cancel ${nonce.slice(0, 8)}`,
        JSON.stringify([
          {
            document_type: "terms",
            document_version: "run-cancel-v1",
            document_hash_hex: sha256(`run-cancel-legal-${nonce}`).toString("hex"),
            disclosure_version: "run-cancel-v1",
            locale: "en",
          },
        ]),
        `run-cancel-signup-${nonce}`,
        sha256(`run-cancel-request-${nonce}`),
        sha256(`run-cancel-actor-${nonce}`),
        randomUUID(),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("Could not establish a Cancel-Run fixture");
    return { userId: row.user_id, tenantId: row.tenant_id };
  });
}

async function cancellationClaimCount(tenantId: string, key: string): Promise<string> {
  return withIdentityTransaction(must(pools).identity, async (database) => {
    const result = await database.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
        FROM app.idempotency_records
        WHERE tenant_id = $1
          AND operation_code = 'runs.cancel'
          AND idempotency_key = $2
      `,
      [tenantId, key],
    );
    return result.rows[0]?.count ?? "0";
  });
}

describe.skipIf(!enabled)("cancel Run against PostgreSQL", () => {
  it("enforces migration 0021 objects and Admission least privilege", async () => {
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
                'idempotency_records_run_cancel_semantics_check',
                'outbox_events_jobs_cancel_shape_check',
                'run_events_cancellation_requested_shape_check'
              )
            ORDER BY conname
          `,
        );
        const indexes = await database.query<{ indexname: string; indexdef: string }>(
          `
            SELECT indexname, indexdef
            FROM pg_indexes
            WHERE schemaname = 'app'
              AND indexname IN (
                'outbox_events_one_jobs_cancel_per_run_idx',
                'run_events_one_cancellation_requested_per_run_idx'
              )
            ORDER BY indexname
          `,
        );
        const functions = await database.query<{
          lock_present: boolean;
          lock_definer: boolean;
          lock_execute: boolean;
          transition_execute: boolean;
        }>(
          `
            SELECT
              to_regprocedure('app.lock_run_for_cancellation(uuid)') IS NOT NULL AS lock_present,
              (SELECT prosecdef FROM pg_proc
                WHERE oid = to_regprocedure('app.lock_run_for_cancellation(uuid)')) AS lock_definer,
              has_function_privilege(
                current_user,
                'app.lock_run_for_cancellation(uuid)',
                'EXECUTE'
              ) AS lock_execute,
              has_function_privilege(
                current_user,
                'app.transition_run(uuid,bigint,text,text,text,uuid,text,boolean,jsonb)',
                'EXECUTE'
              ) AS transition_execute
          `,
        );
        const privileges = await database.query<{
          run_update: boolean;
          hold_update: boolean;
          outbox_claim_update: boolean;
          outbox_published_update: boolean;
        }>(
          `
            SELECT
              has_table_privilege(current_user, 'app.runs', 'UPDATE') AS run_update,
              has_table_privilege(current_user, 'app.provider_cost_holds', 'UPDATE') AS hold_update,
              has_column_privilege(current_user, 'app.outbox_events', 'claimed_at', 'UPDATE') AS outbox_claim_update,
              has_column_privilege(current_user, 'app.outbox_events', 'published_at', 'UPDATE') AS outbox_published_update
          `,
        );
        return {
          constraints: constraints.rows,
          indexes: indexes.rows,
          functions: functions.rows[0],
          privileges: privileges.rows[0],
        };
      },
    );

    expect(evidence.constraints.map((row) => row.conname)).toEqual([
      "idempotency_records_run_cancel_semantics_check",
      "outbox_events_jobs_cancel_shape_check",
      "run_events_cancellation_requested_shape_check",
    ]);
    expect(evidence.indexes.map((row) => row.indexname)).toEqual([
      "outbox_events_one_jobs_cancel_per_run_idx",
      "run_events_one_cancellation_requested_per_run_idx",
    ]);
    expect(evidence.indexes.every((row) => /UNIQUE INDEX/.test(row.indexdef))).toBe(true);
    expect(evidence.functions).toEqual({
      lock_present: true,
      lock_definer: true,
      lock_execute: true,
      transition_execute: false,
    });
    expect(evidence.privileges).toEqual({
      run_update: false,
      hold_update: false,
      outbox_claim_update: false,
      outbox_published_update: false,
    });
  });

  it("rolls back a new cancellation claim when the owned Run is absent", async () => {
    const current = await fixture();
    const key = `run-cancel-missing-${randomUUID()}`;
    const target = createCancelRunService({
      repository: createCancelRunRepository(must(pools).admission),
      csrf: { issue: () => "unused", verify: () => true },
    });

    await expect(
      target.cancel({
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

    expect(await cancellationClaimCount(current.tenantId, key)).toBe("0");
  });

  it("fails closed without a trusted Tenant context", async () => {
    const client = await must(pools).admission.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE dhumi_admission");
      await expect(
        client.query("SELECT * FROM app.lock_run_for_cancellation($1::uuid)", [randomUUID()]),
      ).rejects.toThrow();
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
