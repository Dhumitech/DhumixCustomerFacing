import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import { createDatabasePools } from "../../src/services/database/pools.js";
import {
  withIdentityTransaction,
  withTenantTransaction,
} from "../../src/services/database/transactions.js";
import { createGetRunRepository } from "../../src/services/runQuery/getRunRepository.js";
import { createGetRunService } from "../../src/services/runQuery/getRunService.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const config = enabled ? loadRuntimeConfig() : undefined;

if (enabled && config?.database.database !== "dhumi_test") {
  throw new Error("Get-Run database tests may run only against dhumi_test");
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

interface Fixture {
  readonly userId: string;
  readonly tenantId: string;
}

async function fixture(): Promise<Fixture> {
  const nonce = randomUUID();
  return withIdentityTransaction(must(pools).identity, async (database) => {
    const result = await database.query<{ user_id: string; tenant_id: string }>(
      `
        SELECT user_id, tenant_id
        FROM app.create_signup($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
      `,
      [
        `run-get-${nonce}@example.test`,
        "$argon2id$run-get-fixture-not-a-real-password",
        `Run get ${nonce.slice(0, 8)}`,
        JSON.stringify([
          {
            document_type: "terms",
            document_version: "run-get-v1",
            document_hash_hex: sha256(`run-get-legal-${nonce}`).toString("hex"),
            disclosure_version: "run-get-v1",
            locale: "en",
          },
        ]),
        `run-get-${nonce}`,
        sha256(`run-get-request-${nonce}`),
        sha256(`run-get-actor-${nonce}`),
        randomUUID(),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("Could not establish a Get-Run fixture");
    return { userId: row.user_id, tenantId: row.tenant_id };
  });
}

async function evidenceCounts(tenantId: string) {
  return withIdentityTransaction(must(pools).identity, async (database) => {
    const result = await database.query<{
      idempotency: string;
      audit: string;
      outbox: string;
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
}

describe.skipIf(!enabled)("get Run against PostgreSQL", () => {
  it("returns generic not-found for an absent owned Run without durable writes", async () => {
    const current = await fixture();
    const before = await evidenceCounts(current.tenantId);
    const repository = createGetRunRepository(must(pools).customerApi);

    expect(
      await repository.findById({ tenantId: current.tenantId, runId: randomUUID() }),
    ).toBeUndefined();
    await expect(
      createGetRunService({ repository }).get({
        principal: {
          kind: "browser",
          ...current,
          sessionId: randomUUID(),
        },
        runId: randomUUID(),
        schemaErrors: [],
      }),
    ).rejects.toMatchObject({ status: 404, code: "RESOURCE_NOT_FOUND" });
    expect(await evidenceCounts(current.tenantId)).toEqual(before);
  });

  it("uses the Run primary key and migration 0020's narrow join capability", async () => {
    const current = await fixture();
    const evidence = await withTenantTransaction(
      must(pools).customerApi,
      current.tenantId,
      async (database) => {
        const privilege = await database.query<{
          version_id_select: boolean;
          version_table_select: boolean;
          version_schema_hash_select: boolean;
        }>(
          `
            SELECT
              has_column_privilege(current_user, 'app.service_versions', 'id', 'SELECT') AS version_id_select,
              has_table_privilege(current_user, 'app.service_versions', 'SELECT') AS version_table_select,
              has_column_privilege(current_user, 'app.service_versions', 'schema_hash', 'SELECT') AS version_schema_hash_select
          `,
        );
        const primaryKey = await database.query<{ present: boolean }>(
          `
            SELECT EXISTS (
              SELECT 1
              FROM pg_constraint
              WHERE conrelid = 'app.runs'::regclass
                AND contype = 'p'
                AND conname = 'runs_pkey'
            ) AS present
          `,
        );
        return {
          privilege: privilege.rows[0],
          primaryKey: primaryKey.rows[0]?.present,
        };
      },
    );

    expect(evidence).toEqual({
      privilege: {
        version_id_select: true,
        version_table_select: false,
        version_schema_hash_select: false,
      },
      primaryKey: true,
    });
  });

  it("fails closed without Tenant context and denies private Run columns", async () => {
    const client = await must(pools).customerApi.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE dhumi_customer_api");
      expect((await client.query("SELECT id FROM app.runs")).rows).toEqual([]);
      expect(
        (await client.query("SELECT id, service_id FROM app.service_versions")).rows,
      ).toEqual([]);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    const current = await fixture();
    for (const query of [
      "SELECT internal_status FROM app.runs LIMIT 1",
      "SELECT validated_input FROM app.runs LIMIT 1",
      "SELECT provider_mapping_id FROM app.runs LIMIT 1",
      "SELECT schema_hash FROM app.service_versions LIMIT 1",
    ]) {
      await expect(
        withTenantTransaction(must(pools).customerApi, current.tenantId, async (database) =>
          database.query(query),
        ),
      ).rejects.toThrow();
    }
  });
});
