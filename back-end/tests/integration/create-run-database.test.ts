import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import { createRunRepository } from "../../src/services/admission/createRunRepository.js";
import { createRunService } from "../../src/services/admission/createRunService.js";
import { createDatabasePools } from "../../src/services/database/pools.js";
import {
  withAdmissionTenantTransaction,
  withIdentityTransaction,
} from "../../src/services/database/transactions.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const config = enabled ? loadRuntimeConfig() : undefined;

if (enabled && config?.database.database !== "dhumi_test") {
  throw new Error("Create-Run database tests may run only against dhumi_test");
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
        `run-create-${nonce}@example.test`,
        "$argon2id$run-create-fixture-not-a-real-password",
        `Run create ${nonce.slice(0, 8)}`,
        JSON.stringify([
          {
            document_type: "terms",
            document_version: "run-create-v1",
            document_hash_hex: sha256(`run-create-legal-${nonce}`).toString("hex"),
            disclosure_version: "run-create-v1",
            locale: "en",
          },
        ]),
        `run-create-signup-${nonce}`,
        sha256(`run-create-request-${nonce}`),
        sha256(`run-create-actor-${nonce}`),
        randomUUID(),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("Could not create the Run fixture");
    return { userId: row.user_id, tenantId: row.tenant_id };
  });
}

describe.skipIf(!enabled)("create Run against PostgreSQL", () => {
  it("enforces migration 0018 integrity, private grants and the mock profile", async () => {
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
                'runs_validated_input_object_check',
                'idempotency_records_run_create_semantics_check',
                'outbox_events_jobs_execute_shape_check'
              )
            ORDER BY conname
          `,
        );
        const privileges = await database.query<{
          run_input_insert: boolean;
          run_input_select: boolean;
          run_status_update: boolean;
          feature_state: boolean;
          feature_reason: boolean;
          mapping_commercial: boolean;
          mapping_ciphertext: boolean;
          outbox_payload_insert: boolean;
          outbox_claim_update: boolean;
          customer_run_input: boolean;
        }>(
          `
            SELECT
              has_column_privilege(current_user, 'app.runs', 'validated_input', 'INSERT') AS run_input_insert,
              has_column_privilege(current_user, 'app.runs', 'validated_input', 'SELECT') AS run_input_select,
              has_column_privilege(current_user, 'app.runs', 'public_status', 'UPDATE') AS run_status_update,
              has_column_privilege(current_user, 'app.feature_flags', 'state', 'SELECT') AS feature_state,
              has_column_privilege(current_user, 'app.feature_flags', 'changed_reason', 'SELECT') AS feature_reason,
              has_column_privilege(current_user, 'app.provider_mappings', 'commercial_config_version', 'SELECT') AS mapping_commercial,
              has_column_privilege(current_user, 'app.provider_mappings', 'provider_resource_ciphertext', 'SELECT') AS mapping_ciphertext,
              has_column_privilege(current_user, 'app.outbox_events', 'payload', 'INSERT') AS outbox_payload_insert,
              has_column_privilege(current_user, 'app.outbox_events', 'claimed_at', 'UPDATE') AS outbox_claim_update,
              has_column_privilege('dhumi_customer_api', 'app.runs', 'validated_input', 'SELECT') AS customer_run_input
          `,
        );
        const capacity = await database.query<{
          profile_code: string;
          estimated_amount_micros: string;
          currency_code: string;
          unit: string;
          evidence_reference: string;
        }>("SELECT * FROM app.require_phase5_mock_run_capacity('test')");
        const lockFunction = await database.query<{ present: boolean; definer: boolean }>(
          `
            SELECT
              to_regprocedure('app.lock_service_for_run(uuid)') IS NOT NULL AS present,
              prosecdef AS definer
            FROM pg_proc
            WHERE oid = to_regprocedure('app.lock_service_for_run(uuid)')
          `,
        );
        return {
          constraints: constraints.rows,
          privileges: privileges.rows[0],
          capacity: capacity.rows[0],
          lockFunction: lockFunction.rows[0],
        };
      },
    );

    expect(evidence.constraints).toHaveLength(3);
    expect(evidence.privileges).toEqual({
      run_input_insert: true,
      run_input_select: false,
      run_status_update: false,
      feature_state: true,
      feature_reason: false,
      mapping_commercial: true,
      mapping_ciphertext: false,
      outbox_payload_insert: true,
      outbox_claim_update: false,
      customer_run_input: false,
    });
    expect(evidence.capacity).toEqual({
      profile_code: "phase5_mock_admission_v1",
      estimated_amount_micros: "0",
      currency_code: "USD",
      unit: "mock_run",
      evidence_reference: "phase5_mock_admission_v1",
    });
    expect(evidence.lockFunction).toEqual({ present: true, definer: true });
  });

  it("rolls back the claim for a missing or cross-Tenant Service", async () => {
    const current = await fixture();
    const idempotencyKey = `missing-run-service-${randomUUID()}`;
    const target = createRunService({
      repository: createRunRepository(must(pools).admission),
      validator: {
        validate() {
          return { valid: true, schemaHash: Buffer.alloc(32) };
        },
      },
      csrf: { issue: () => "", verify: () => true },
      providerEnvironment: "test",
    });

    await expect(
      target.create({
        principal: {
          kind: "browser",
          tenantId: current.tenantId,
          userId: current.userId,
          sessionId: randomUUID(),
        },
        csrfToken: "valid-csrf-token-value",
        idempotencyKey,
        serviceId: randomUUID(),
        body: { input: {} },
        schemaErrors: [],
        requestId: randomUUID(),
        ipFingerprint: sha256("127.0.0.1"),
      }),
    ).rejects.toMatchObject({ status: 404, code: "RESOURCE_NOT_FOUND" });

    const count = await withIdentityTransaction(must(pools).identity, async (database) => {
      const result = await database.query<{ count: string }>(
        `
          SELECT count(*)::text AS count
          FROM app.idempotency_records
          WHERE tenant_id = $1
            AND operation_code = 'runs.create'
            AND idempotency_key = $2
        `,
        [current.tenantId, idempotencyKey],
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
        client.query("SELECT * FROM app.require_phase5_mock_run_capacity('test')"),
      ).rejects.toThrow();
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
