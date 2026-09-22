import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import { createDatabasePools } from "../../src/services/database/pools.js";
import {
  withIdentityTransaction,
  withTenantTransaction,
} from "../../src/services/database/transactions.js";
import { createListRunEventsRepository } from "../../src/services/runQuery/listRunEventsRepository.js";
import { createListRunEventsService } from "../../src/services/runQuery/listRunEventsService.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const config = enabled ? loadRuntimeConfig() : undefined;

if (enabled && config?.database.database !== "dhumi_test") {
  throw new Error("List-Run-events database tests may run only against dhumi_test");
}

const pools = enabled && config ? createDatabasePools(config.database, () => {}) : undefined;

afterAll(async () => {
  await pools?.close();
});

function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("database integration configuration is unavailable");
  }
  return value;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

interface Fixture {
  readonly userId: string;
  readonly tenantId: string;
}

interface SignupRow {
  readonly user_id: string | null;
  readonly tenant_id: string | null;
}

async function fixture(): Promise<Fixture> {
  const nonce = randomUUID();
  const row = await withIdentityTransaction(must(pools).identity, async (database) => {
    const result = await database.query<SignupRow>(
      `
        SELECT user_id, tenant_id
        FROM app.create_signup($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
      `,
      [
        `run-events-${nonce}@example.test`,
        "$argon2id$run-events-fixture-not-a-real-password",
        `Run events ${nonce.slice(0, 8)}`,
        JSON.stringify([
          {
            document_type: "terms",
            document_version: "run-events-v1",
            document_hash_hex: sha256(`run-events-legal-${nonce}`).toString("hex"),
            disclosure_version: "run-events-v1",
            locale: "en",
          },
        ]),
        `run-events-${nonce}`,
        sha256(`run-events-request-${nonce}`),
        sha256(`run-events-actor-${nonce}`),
        randomUUID(),
      ],
    );
    return result.rows[0];
  });

  if (
    row?.user_id === null ||
    row?.user_id === undefined ||
    row.tenant_id === null ||
    row.tenant_id === undefined
  ) {
    throw new Error("Could not establish a Run-event database fixture");
  }
  return { userId: row.user_id, tenantId: row.tenant_id };
}

async function evidenceCounts(tenantId: string) {
  const evidence = await withIdentityTransaction(must(pools).identity, async (database) => {
    const result = await database.query<{
      readonly idempotency: string;
      readonly audit: string;
      readonly outbox: string;
    }>(
      `
        SELECT
          (SELECT count(*) FROM app.idempotency_records WHERE tenant_id = $1)::text AS idempotency,
          (SELECT count(*) FROM app.audit_events WHERE tenant_id = $1)::text AS audit,
          (SELECT count(*) FROM app.outbox_events WHERE tenant_id = $1)::text AS outbox
      `,
      [tenantId],
    );
    return result.rows[0];
  });
  const runEvents = await withTenantTransaction(
    must(pools).customerApi,
    tenantId,
    async (database) => {
      const result = await database.query<{ readonly count: string }>(
        "SELECT count(*)::text AS count FROM app.run_events WHERE tenant_id = $1",
        [tenantId],
      );
      return result.rows[0]?.count;
    },
  );
  return { ...evidence, runEvents };
}

describe.skipIf(!enabled)("list Run events against PostgreSQL", () => {
  it("enforces migration 0025 exact columns, forced RLS, ordering key, and immutability", async () => {
    const current = await fixture();
    const evidence = await withTenantTransaction(
      must(pools).customerApi,
      current.tenantId,
      async (database) => {
        const privileges = await database.query<{
          readonly tableSelect: boolean;
          readonly idSelect: boolean;
          readonly tenantSelect: boolean;
          readonly runSelect: boolean;
          readonly sequenceSelect: boolean;
          readonly typeSelect: boolean;
          readonly occurredSelect: boolean;
          readonly sourceSelect: boolean;
          readonly attemptSelect: boolean;
          readonly keySelect: boolean;
          readonly payloadSelect: boolean;
          readonly evidenceSelect: boolean;
          readonly recordedSelect: boolean;
          readonly insertAllowed: boolean;
          readonly updateAllowed: boolean;
          readonly deleteAllowed: boolean;
        }>(
          `
            SELECT
              has_table_privilege(current_user, 'app.run_events', 'SELECT') AS "tableSelect",
              has_column_privilege(current_user, 'app.run_events', 'id', 'SELECT') AS "idSelect",
              has_column_privilege(current_user, 'app.run_events', 'tenant_id', 'SELECT') AS "tenantSelect",
              has_column_privilege(current_user, 'app.run_events', 'run_id', 'SELECT') AS "runSelect",
              has_column_privilege(current_user, 'app.run_events', 'sequence', 'SELECT') AS "sequenceSelect",
              has_column_privilege(current_user, 'app.run_events', 'event_type', 'SELECT') AS "typeSelect",
              has_column_privilege(current_user, 'app.run_events', 'occurred_at', 'SELECT') AS "occurredSelect",
              has_column_privilege(current_user, 'app.run_events', 'source', 'SELECT') AS "sourceSelect",
              has_column_privilege(current_user, 'app.run_events', 'attempt_id', 'SELECT') AS "attemptSelect",
              has_column_privilege(current_user, 'app.run_events', 'event_idempotency_key', 'SELECT') AS "keySelect",
              has_column_privilege(current_user, 'app.run_events', 'safe_payload', 'SELECT') AS "payloadSelect",
              has_column_privilege(current_user, 'app.run_events', 'evidence_reference', 'SELECT') AS "evidenceSelect",
              has_column_privilege(current_user, 'app.run_events', 'recorded_at', 'SELECT') AS "recordedSelect",
              has_table_privilege(current_user, 'app.run_events', 'INSERT') AS "insertAllowed",
              has_table_privilege(current_user, 'app.run_events', 'UPDATE') AS "updateAllowed",
              has_table_privilege(current_user, 'app.run_events', 'DELETE') AS "deleteAllowed"
          `,
        );
        const structure = await database.query<{
          readonly forced: boolean;
          readonly policyUsesTenant: boolean;
          readonly orderingKey: boolean;
          readonly immutableTrigger: boolean;
        }>(
          `
            SELECT
              class_row.relforcerowsecurity AS forced,
              EXISTS (
                SELECT 1
                FROM pg_policies
                WHERE schemaname = 'app'
                  AND tablename = 'run_events'
                  AND policyname = 'run_events_tenant_isolation'
                  AND qual LIKE '%current_tenant_id%'
              ) AS "policyUsesTenant",
              to_regclass('app.run_events_run_id_sequence_key') IS NOT NULL AS "orderingKey",
              EXISTS (
                SELECT 1
                FROM pg_trigger
                WHERE tgrelid = 'app.run_events'::regclass
                  AND tgname = 'run_events_immutable'
                  AND NOT tgisinternal
              ) AS "immutableTrigger"
            FROM pg_class AS class_row
            WHERE class_row.oid = 'app.run_events'::regclass
          `,
        );
        return {
          privileges: privileges.rows[0],
          structure: structure.rows[0],
        };
      },
    );

    expect(evidence.privileges).toEqual({
      tableSelect: false,
      idSelect: true,
      tenantSelect: true,
      runSelect: true,
      sequenceSelect: true,
      typeSelect: true,
      occurredSelect: true,
      sourceSelect: false,
      attemptSelect: false,
      keySelect: false,
      payloadSelect: false,
      evidenceSelect: false,
      recordedSelect: false,
      insertAllowed: false,
      updateAllowed: false,
      deleteAllowed: false,
    });
    expect(evidence.structure).toEqual({
      forced: true,
      policyUsesTenant: true,
      orderingKey: true,
      immutableTrigger: true,
    });
  });

  it("returns a generic invisible-Run failure without any durable write", async () => {
    const current = await fixture();
    const before = await evidenceCounts(current.tenantId);

    await expect(
      createListRunEventsService({
        repository: createListRunEventsRepository(must(pools).customerApi),
      }).list({
        principal: {
          kind: "browser",
          ...current,
          sessionId: randomUUID(),
        },
        runId: randomUUID(),
        cursor: undefined,
        limit: undefined,
        schemaErrors: [],
      }),
    ).rejects.toMatchObject({ status: 404, code: "RESOURCE_NOT_FOUND" });

    expect(await evidenceCounts(current.tenantId)).toEqual(before);
  });

  it("fails closed without Tenant context and denies every private event column", async () => {
    const current = await fixture();
    const client = await must(pools).customerApi.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE dhumi_customer_api");
      expect(
        (
          await client.query(
            "SELECT id, tenant_id, run_id, sequence, event_type, occurred_at FROM app.run_events",
          )
        ).rows,
      ).toEqual([]);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    const forbiddenQueries = [
      "SELECT source FROM app.run_events LIMIT 1",
      "SELECT attempt_id FROM app.run_events LIMIT 1",
      "SELECT event_idempotency_key FROM app.run_events LIMIT 1",
      "SELECT safe_payload FROM app.run_events LIMIT 1",
      "SELECT evidence_reference FROM app.run_events LIMIT 1",
      "SELECT recorded_at FROM app.run_events LIMIT 1",
      "DELETE FROM app.run_events WHERE false",
    ];
    for (const query of forbiddenQueries) {
      await expect(
        withTenantTransaction(
          must(pools).customerApi,
          current.tenantId,
          async (database) => database.query(query),
        ),
      ).rejects.toThrow();
    }
  });
});
