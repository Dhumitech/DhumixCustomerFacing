import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import { createDatabasePools } from "../../src/services/database/pools.js";
import {
  withIdentityTransaction,
  withTenantTransaction,
} from "../../src/services/database/transactions.js";
import { createListServicesRepository } from "../../src/services/customerServices/listServicesRepository.js";
import { createListServicesService } from "../../src/services/customerServices/listServicesService.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const config = enabled ? loadRuntimeConfig() : undefined;

if (enabled && config?.database.database !== "dhumi_test") {
  throw new Error("List-Services database tests may run only against dhumi_test");
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
        `service-list-${nonce}@example.test`,
        "$argon2id$service-list-fixture-not-a-real-password",
        `Service list ${nonce.slice(0, 8)}`,
        JSON.stringify([
          {
            document_type: "terms",
            document_version: "service-list-v1",
            document_hash_hex: sha256(`service-list-legal-${nonce}`).toString("hex"),
            disclosure_version: "service-list-v1",
            locale: "en",
          },
        ]),
        `service-list-${nonce}`,
        sha256(`service-list-request-${nonce}`),
        sha256(`service-list-actor-${nonce}`),
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
    throw new Error("Could not establish a Service-list database fixture");
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

describe.skipIf(!enabled)("list Services against PostgreSQL", () => {
  it("enforces migration 0015 integrity, RLS, index, and column-scoped privileges", async () => {
    const current = await fixture();
    const evidence = await withTenantTransaction(
      must(pools).customerApi,
      current.tenantId,
      async (database) => {
        const privileges = await database.query<{
          readonly services_table_select: boolean;
          readonly services_id_select: boolean;
          readonly services_created_select: boolean;
          readonly services_updated_select: boolean;
          readonly versions_table_select: boolean;
          readonly versions_number_select: boolean;
          readonly versions_configuration_select: boolean;
          readonly versions_schema_hash_select: boolean;
          readonly versions_creator_select: boolean;
          readonly versions_created_select: boolean;
        }>(
          `
            SELECT
              has_table_privilege(current_user, 'app.services', 'SELECT') AS services_table_select,
              has_column_privilege(current_user, 'app.services', 'id', 'SELECT') AS services_id_select,
              has_column_privilege(current_user, 'app.services', 'created_at', 'SELECT') AS services_created_select,
              has_column_privilege(current_user, 'app.services', 'updated_at', 'SELECT') AS services_updated_select,
              has_table_privilege(current_user, 'app.service_versions', 'SELECT') AS versions_table_select,
              has_column_privilege(current_user, 'app.service_versions', 'version', 'SELECT') AS versions_number_select,
              has_column_privilege(current_user, 'app.service_versions', 'validated_configuration', 'SELECT') AS versions_configuration_select,
              has_column_privilege(current_user, 'app.service_versions', 'schema_hash', 'SELECT') AS versions_schema_hash_select,
              has_column_privilege(current_user, 'app.service_versions', 'created_by_user_id', 'SELECT') AS versions_creator_select,
              has_column_privilege(current_user, 'app.service_versions', 'created_at', 'SELECT') AS versions_created_select
          `,
        );
        const constraints = await database.query<{
          readonly conname: string;
          readonly definition: string;
          readonly condeferrable: boolean;
          readonly condeferred: boolean;
        }>(
          `
            SELECT
              constraint_row.conname,
              pg_get_constraintdef(constraint_row.oid) AS definition,
              constraint_row.condeferrable,
              constraint_row.condeferred
            FROM pg_constraint AS constraint_row
            WHERE constraint_row.connamespace = 'app'::regnamespace
              AND constraint_row.conname IN (
                'services_state_check',
                'service_versions_tenant_service_version_key',
                'services_current_version_fk'
              )
            ORDER BY constraint_row.conname
          `,
        );
        const policies = await database.query<{
          readonly tablename: string;
          readonly qual: string;
        }>(
          `
            SELECT tablename, qual
            FROM pg_policies
            WHERE schemaname = 'app'
              AND policyname IN (
                'service_templates_customer_read',
                'service_template_versions_customer_read'
              )
            ORDER BY tablename
          `,
        );
        const index = await database.query<{ readonly indexdef: string }>(
          `
            SELECT indexdef
            FROM pg_indexes
            WHERE schemaname = 'app'
              AND tablename = 'services'
              AND indexname = 'services_tenant_created_id_idx'
          `,
        );
        const trigger = await database.query<{
          readonly trigger_name: string;
          readonly function_name: string;
          readonly security_definer: boolean;
          readonly function_config: readonly string[] | null;
        }>(
          `
            SELECT
              trigger_row.tgname AS trigger_name,
              function_row.proname AS function_name,
              function_row.prosecdef AS security_definer,
              function_row.proconfig AS function_config
            FROM pg_trigger AS trigger_row
            INNER JOIN pg_proc AS function_row
              ON function_row.oid = trigger_row.tgfoid
            WHERE trigger_row.tgrelid = 'app.service_versions'::regclass
              AND trigger_row.tgname = 'service_versions_validate_template_pin'
              AND NOT trigger_row.tgisinternal
          `,
        );
        return {
          privileges: privileges.rows[0],
          constraints: constraints.rows,
          policies: policies.rows,
          index: index.rows[0],
          trigger: trigger.rows[0],
        };
      },
    );

    expect(evidence.privileges).toEqual({
      services_table_select: false,
      services_id_select: true,
      services_created_select: true,
      services_updated_select: false,
      versions_table_select: false,
      versions_number_select: true,
      // Migration 0017 deliberately adds this one detail-read column while
      // the list repository and serializer continue to omit it.
      versions_configuration_select: true,
      versions_schema_hash_select: false,
      versions_creator_select: false,
      versions_created_select: false,
    });
    expect(evidence.constraints.map((row) => row.conname)).toEqual([
      "service_versions_tenant_service_version_key",
      "services_current_version_fk",
      "services_state_check",
    ]);
    expect(
      evidence.constraints.find((row) => row.conname === "services_state_check")
        ?.definition,
    ).toMatch(/active.*disabled/);
    expect(
      evidence.constraints.find((row) => row.conname === "services_state_check")
        ?.definition,
    ).not.toContain("archived");
    expect(
      evidence.constraints.find((row) => row.conname === "services_current_version_fk"),
    ).toMatchObject({ condeferrable: true, condeferred: true });
    expect(evidence.policies).toHaveLength(2);
    expect(evidence.policies.every((policy) => policy.qual.includes("current_tenant_id"))).toBe(
      true,
    );
    expect(evidence.policies.find((policy) => policy.tablename === "service_templates")?.qual).toMatch(
      /services|service_template_id/,
    );
    expect(
      evidence.policies.find((policy) => policy.tablename === "service_template_versions")
        ?.qual,
    ).toMatch(/launch_evidence|approved|service_versions/);
    expect(evidence.index?.indexdef).toMatch(
      /tenant_id, created_at DESC, id DESC/,
    );
    expect(evidence.trigger).toMatchObject({
      trigger_name: "service_versions_validate_template_pin",
      function_name: "validate_service_template_version_pin",
      security_definer: false,
    });
    expect(evidence.trigger?.function_config).toContain("search_path=pg_catalog, app");
  });

  it("returns an empty page without audit, outbox, or idempotency writes", async () => {
    const current = await fixture();
    const before = await evidenceCounts(current.tenantId);
    const result = await createListServicesService({
      repository: createListServicesRepository(must(pools).customerApi),
    }).list({
      principal: {
        kind: "browser",
        ...current,
        sessionId: randomUUID(),
      },
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

  it("fails closed without Tenant context and denies private Service-version columns", async () => {
    const current = await fixture();
    const client = await must(pools).customerApi.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE dhumi_customer_api");
      expect((await client.query("SELECT id, name FROM app.services")).rows).toEqual([]);
      expect(
        (
          await client.query(
            "SELECT tenant_id, service_id, version, validated_configuration FROM app.service_versions",
          )
        ).rows,
      ).toEqual([]);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    const forbiddenQueries = [
      "SELECT updated_at FROM app.services LIMIT 1",
      "SELECT schema_hash FROM app.service_versions LIMIT 1",
      "SELECT created_by_user_id FROM app.service_versions LIMIT 1",
      "SELECT created_at FROM app.service_versions LIMIT 1",
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
