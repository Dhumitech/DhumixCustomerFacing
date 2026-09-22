import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import { createDatabasePools } from "../../src/services/database/pools.js";
import {
  withIdentityTransaction,
  withTenantTransaction,
} from "../../src/services/database/transactions.js";
import { createGetServiceRepository } from "../../src/services/customerServices/getServiceRepository.js";
import { createGetServiceService } from "../../src/services/customerServices/getServiceService.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const config = enabled ? loadRuntimeConfig() : undefined;

if (enabled && config?.database.database !== "dhumi_test") {
  throw new Error("Get-Service database tests may run only against dhumi_test");
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
        `service-detail-${nonce}@example.test`,
        "$argon2id$service-detail-fixture-not-a-real-password",
        `Service detail ${nonce.slice(0, 8)}`,
        JSON.stringify([{
          document_type: "terms",
          document_version: "service-detail-v1",
          document_hash_hex: sha256(`service-detail-legal-${nonce}`).toString("hex"),
          disclosure_version: "service-detail-v1",
          locale: "en",
        }]),
        `service-detail-${nonce}`,
        sha256(`service-detail-request-${nonce}`),
        sha256(`service-detail-actor-${nonce}`),
        randomUUID(),
      ],
    );
    return result.rows[0];
  });
  if (
    row?.user_id === null || row?.user_id === undefined ||
    row.tenant_id === null || row.tenant_id === undefined
  ) {
    throw new Error("Could not establish a Service-detail database fixture");
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

describe.skipIf(!enabled)("get Service against PostgreSQL", () => {
  it("enforces migration 0017's one-column detail grant and retained denials", async () => {
    const current = await fixture();
    const privileges = await withTenantTransaction(
      must(pools).customerApi,
      current.tenantId,
      async (database) => {
        const result = await database.query<{
          readonly table_select: boolean;
          readonly configuration_select: boolean;
          readonly schema_hash_select: boolean;
          readonly creator_user_select: boolean;
          readonly creator_key_select: boolean;
          readonly version_created_select: boolean;
          readonly service_updated_select: boolean;
        }>(
          `
            SELECT
              has_table_privilege(current_user, 'app.service_versions', 'SELECT') AS table_select,
              has_column_privilege(current_user, 'app.service_versions', 'validated_configuration', 'SELECT') AS configuration_select,
              has_column_privilege(current_user, 'app.service_versions', 'schema_hash', 'SELECT') AS schema_hash_select,
              has_column_privilege(current_user, 'app.service_versions', 'created_by_user_id', 'SELECT') AS creator_user_select,
              has_column_privilege(current_user, 'app.service_versions', 'created_by_api_key_id', 'SELECT') AS creator_key_select,
              has_column_privilege(current_user, 'app.service_versions', 'created_at', 'SELECT') AS version_created_select,
              has_column_privilege(current_user, 'app.services', 'updated_at', 'SELECT') AS service_updated_select
          `,
        );
        return result.rows[0];
      },
    );

    expect(privileges).toEqual({
      table_select: false,
      configuration_select: true,
      schema_hash_select: false,
      creator_user_select: false,
      creator_key_select: false,
      version_created_select: false,
      service_updated_select: false,
    });
  });

  it("returns an invisible item as 404 without audit, outbox, or idempotency writes", async () => {
    const current = await fixture();
    const before = await evidenceCounts(current.tenantId);
    const service = createGetServiceService({
      repository: createGetServiceRepository(must(pools).customerApi),
    });

    await expect(service.get({
      principal: { kind: "browser", ...current, sessionId: randomUUID() },
      serviceId: randomUUID(),
      schemaErrors: [],
    })).rejects.toMatchObject({ status: 404, code: "RESOURCE_NOT_FOUND" });
    expect(await evidenceCounts(current.tenantId)).toEqual(before);
  });

  it("fails closed without Tenant context and keeps private columns unreadable", async () => {
    const current = await fixture();
    const client = await must(pools).customerApi.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE dhumi_customer_api");
      expect((await client.query("SELECT id, name FROM app.services")).rows).toEqual([]);
      expect((await client.query(
        "SELECT service_id, version, validated_configuration FROM app.service_versions",
      )).rows).toEqual([]);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    for (const query of [
      "SELECT schema_hash FROM app.service_versions LIMIT 1",
      "SELECT created_by_user_id FROM app.service_versions LIMIT 1",
      "SELECT created_by_api_key_id FROM app.service_versions LIMIT 1",
      "SELECT created_at FROM app.service_versions LIMIT 1",
      "SELECT updated_at FROM app.services LIMIT 1",
    ]) {
      await expect(
        withTenantTransaction(must(pools).customerApi, current.tenantId, async (database) =>
          database.query(query),
        ),
      ).rejects.toThrow();
    }
  });
});
