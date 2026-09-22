import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import { createDatabasePools } from "../../src/services/database/pools.js";
import {
  withIdentityTransaction,
  withTenantTransaction,
} from "../../src/services/database/transactions.js";
import { createListRunsRepository } from "../../src/services/runQuery/listRunsRepository.js";
import { createListRunsService } from "../../src/services/runQuery/listRunsService.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const config = enabled ? loadRuntimeConfig() : undefined;

if (enabled && config?.database.database !== "dhumi_test") {
  throw new Error("List-Runs database tests may run only against dhumi_test");
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
        `run-list-${nonce}@example.test`,
        "$argon2id$run-list-fixture-not-a-real-password",
        `Run list ${nonce.slice(0, 8)}`,
        JSON.stringify([
          {
            document_type: "terms",
            document_version: "run-list-v1",
            document_hash_hex: sha256(`run-list-legal-${nonce}`).toString("hex"),
            disclosure_version: "run-list-v1",
            locale: "en",
          },
        ]),
        `run-list-${nonce}`,
        sha256(`run-list-request-${nonce}`),
        sha256(`run-list-actor-${nonce}`),
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
    throw new Error("Could not establish a Run-list database fixture");
  }
  return { userId: row.user_id, tenantId: row.tenant_id };
}

async function evidenceCounts(tenantId: string) {
  return withIdentityTransaction(must(pools).identity, async (database) => {
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
}

describe.skipIf(!enabled)("list Runs against PostgreSQL", () => {
  it("enforces migration 0020 exact index and least-privilege join surface", async () => {
    const current = await fixture();
    const evidence = await withTenantTransaction(
      must(pools).customerApi,
      current.tenantId,
      async (database) => {
        const privileges = await database.query<{
          readonly runs_table_select: boolean;
          readonly run_id_select: boolean;
          readonly run_status_select: boolean;
          readonly run_internal_status_select: boolean;
          readonly run_input_select: boolean;
          readonly run_mapping_select: boolean;
          readonly version_table_select: boolean;
          readonly version_id_select: boolean;
          readonly version_service_id_select: boolean;
          readonly version_schema_hash_select: boolean;
        }>(
          `
            SELECT
              has_table_privilege(current_user, 'app.runs', 'SELECT') AS runs_table_select,
              has_column_privilege(current_user, 'app.runs', 'id', 'SELECT') AS run_id_select,
              has_column_privilege(current_user, 'app.runs', 'public_status', 'SELECT') AS run_status_select,
              has_column_privilege(current_user, 'app.runs', 'internal_status', 'SELECT') AS run_internal_status_select,
              has_column_privilege(current_user, 'app.runs', 'validated_input', 'SELECT') AS run_input_select,
              has_column_privilege(current_user, 'app.runs', 'provider_mapping_id', 'SELECT') AS run_mapping_select,
              has_table_privilege(current_user, 'app.service_versions', 'SELECT') AS version_table_select,
              has_column_privilege(current_user, 'app.service_versions', 'id', 'SELECT') AS version_id_select,
              has_column_privilege(current_user, 'app.service_versions', 'service_id', 'SELECT') AS version_service_id_select,
              has_column_privilege(current_user, 'app.service_versions', 'schema_hash', 'SELECT') AS version_schema_hash_select
          `,
        );
        const indexes = await database.query<{
          readonly indexname: string;
          readonly indexdef: string;
        }>(
          `
            SELECT indexname, indexdef
            FROM pg_indexes
            WHERE schemaname = 'app'
              AND tablename = 'runs'
              AND indexname IN (
                'runs_by_tenant_created_idx',
                'runs_by_tenant_status_created_id_idx',
                'runs_by_tenant_service_version_created_id_idx'
              )
            ORDER BY indexname
          `,
        );
        const rls = await database.query<{
          readonly enabled: boolean;
          readonly forced: boolean;
          readonly policy_uses_tenant: boolean;
        }>(
          `
            SELECT
              class_row.relrowsecurity AS enabled,
              class_row.relforcerowsecurity AS forced,
              EXISTS (
                SELECT 1
                FROM pg_policies
                WHERE schemaname = 'app'
                  AND tablename = 'runs'
                  AND policyname = 'runs_tenant_isolation'
                  AND qual LIKE '%current_tenant_id%'
              ) AS policy_uses_tenant
            FROM pg_class AS class_row
            WHERE class_row.oid = 'app.runs'::regclass
          `,
        );
        return {
          privileges: privileges.rows[0],
          indexes: indexes.rows,
          rls: rls.rows[0],
        };
      },
    );

    expect(evidence.privileges).toEqual({
      runs_table_select: false,
      run_id_select: true,
      run_status_select: true,
      run_internal_status_select: false,
      run_input_select: false,
      run_mapping_select: false,
      version_table_select: false,
      version_id_select: true,
      version_service_id_select: true,
      version_schema_hash_select: false,
    });
    expect(evidence.indexes.map((row) => row.indexname)).toEqual([
      "runs_by_tenant_created_idx",
      "runs_by_tenant_service_version_created_id_idx",
      "runs_by_tenant_status_created_id_idx",
    ]);
    expect(
      evidence.indexes.find(
        (row) => row.indexname === "runs_by_tenant_created_idx",
      )?.indexdef,
    ).toMatch(/tenant_id, created_at DESC, id DESC/);
    expect(
      evidence.indexes.find(
        (row) => row.indexname === "runs_by_tenant_status_created_id_idx",
      )?.indexdef,
    ).toMatch(/tenant_id, public_status, created_at DESC, id DESC/);
    expect(evidence.rls).toEqual({
      enabled: true,
      forced: true,
      policy_uses_tenant: true,
    });
  });

  it("returns an empty page without audit, outbox, or idempotency writes", async () => {
    const current = await fixture();
    const before = await evidenceCounts(current.tenantId);
    const result = await createListRunsService({
      repository: createListRunsRepository(must(pools).customerApi),
    }).list({
      principal: {
        kind: "browser",
        ...current,
        sessionId: randomUUID(),
      },
      status: undefined,
      serviceId: undefined,
      cursor: undefined,
      limit: undefined,
      schemaErrors: [],
    });

    expect(result).toEqual({
      data: [],
      page: { next_cursor: null, has_more: false },
    });
    expect(await evidenceCounts(current.tenantId)).toEqual(before);
  });

  it("fails closed without Tenant context and denies private Run columns", async () => {
    const current = await fixture();
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

    const forbiddenQueries = [
      "SELECT internal_status FROM app.runs LIMIT 1",
      "SELECT validated_input FROM app.runs LIMIT 1",
      "SELECT provider_mapping_id FROM app.runs LIMIT 1",
      "SELECT schema_hash FROM app.service_versions LIMIT 1",
      "SELECT created_by_api_key_id FROM app.service_versions LIMIT 1",
    ];
    for (const query of forbiddenQueries) {
      await expect(
        withTenantTransaction(must(pools).customerApi, current.tenantId, async (database) =>
          database.query(query),
        ),
      ).rejects.toThrow();
    }
  });
});
