import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import { createServiceConfigurationValidator } from "../../src/helpers/serviceConfigurationValidator.js";
import { createDatabasePools } from "../../src/services/database/pools.js";
import { createServiceRepository } from "../../src/services/customerServices/createServiceRepository.js";
import { createServiceService } from "../../src/services/customerServices/createServiceService.js";

const enabled =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" &&
  process.env.RUN_CREATE_SERVICE_PRIVILEGED_TESTS === "true";
const config = enabled ? loadRuntimeConfig() : undefined;
const privilegedUrl = enabled ? process.env.PRIVILEGED_TEST_DATABASE_URL : undefined;
const privilegedPassword = enabled ? process.env.PGPASSWORD : undefined;

if (enabled && config?.database.database !== "dhumi_test") {
  throw new Error("Privileged create-Service tests may run only against dhumi_test");
}
if (enabled && (!privilegedUrl || !privilegedPassword)) {
  throw new Error("Privileged create-Service tests require the secure wrapper script");
}

const runtimePools = enabled && config
  ? createDatabasePools(config.database, () => {})
  : undefined;
const privilegedPool = enabled
  ? new Pool({
      connectionString: privilegedUrl,
      password: privilegedPassword,
      application_name: "dhumi-create-service-privileged-tests",
      max: 2,
    })
  : undefined;

const TENANT_A = "71000000-0000-4000-8000-000000000001";
const USER_A = "71000000-0000-4000-8000-000000000002";
const TENANT_B = "71000000-0000-4000-8000-000000000004";
const USER_B = "71000000-0000-4000-8000-000000000005";
const TEMPLATE_EVIDENCE = "71000000-0000-4000-8000-000000000006";
const MAPPING_EVIDENCE = "71000000-0000-4000-8000-000000000007";
const ADAPTER_DEFINITION = "71000000-0000-4000-8000-000000000008";
const ADAPTER_VERSION = "71000000-0000-4000-8000-000000000009";
const TEMPLATE = "71000000-0000-4000-8000-00000000000a";
const TEMPLATE_VERSION = "71000000-0000-4000-8000-00000000000b";
const PROVIDER_CREDENTIAL = "71000000-0000-4000-8000-00000000000c";
const PROVIDER_MAPPING = "71000000-0000-4000-8000-00000000000d";
const TEMPLATE_SLUG = "create-service-concurrency-fixture";

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Privileged test configuration is unavailable");
  return value;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

async function inTransaction(
  pool: Pool,
  work: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await work(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function cleanupFixtures(): Promise<void> {
  await inTransaction(must(privilegedPool), async (database) => {
    // Immutable history triggers are correct in production. This privileged,
    // deterministic cleanup is isolated to dhumi_test and is rerun before seed
    // so an interrupted previous process cannot leave customer-visible data.
    await database.query("SET LOCAL session_replication_role = replica");
    await database.query(
      "DELETE FROM app.idempotency_records WHERE tenant_id = ANY($1::uuid[])",
      [[TENANT_A, TENANT_B]],
    );
    await database.query(
      "DELETE FROM app.audit_events WHERE tenant_id = ANY($1::uuid[])",
      [[TENANT_A, TENANT_B]],
    );
    await database.query(
      "DELETE FROM app.service_versions WHERE tenant_id = ANY($1::uuid[])",
      [[TENANT_A, TENANT_B]],
    );
    await database.query(
      "DELETE FROM app.services WHERE tenant_id = ANY($1::uuid[])",
      [[TENANT_A, TENANT_B]],
    );
    await database.query("DELETE FROM app.provider_mappings WHERE id = $1", [PROVIDER_MAPPING]);
    await database.query("DELETE FROM app.service_template_versions WHERE id = $1", [TEMPLATE_VERSION]);
    await database.query("DELETE FROM app.service_templates WHERE id = $1", [TEMPLATE]);
    await database.query("DELETE FROM app.provider_credentials WHERE id = $1", [PROVIDER_CREDENTIAL]);
    await database.query("DELETE FROM app.adapter_versions WHERE id = $1", [ADAPTER_VERSION]);
    await database.query("DELETE FROM app.adapter_definitions WHERE id = $1", [ADAPTER_DEFINITION]);
    await database.query(
      "DELETE FROM app.launch_evidence WHERE id = ANY($1::uuid[])",
      [[TEMPLATE_EVIDENCE, MAPPING_EVIDENCE]],
    );
    await database.query(
      "DELETE FROM app.tenant_user_access WHERE tenant_id = ANY($1::uuid[])",
      [[TENANT_A, TENANT_B]],
    );
    await database.query(
      "DELETE FROM app.tenants WHERE id = ANY($1::uuid[])",
      [[TENANT_A, TENANT_B]],
    );
    await database.query(
      "DELETE FROM app.users WHERE id = ANY($1::uuid[])",
      [[USER_A, USER_B]],
    );
  });
}

async function seedFixtures(): Promise<void> {
  await inTransaction(must(privilegedPool), async (database) => {
    await database.query("SET CONSTRAINTS ALL DEFERRED");
    await database.query(
      `
        INSERT INTO app.users (id, email_normalized, password_hash)
        VALUES
          ($1, 'create-service-concurrency-a@example.test', '$argon2id$test-only-a'),
          ($2, 'create-service-concurrency-b@example.test', '$argon2id$test-only-b')
      `,
      [USER_A, USER_B],
    );
    await database.query(
      `
        INSERT INTO app.tenants (id, display_name)
        VALUES ($1, 'Create Service concurrency A'), ($2, 'Create Service concurrency B')
      `,
      [TENANT_A, TENANT_B],
    );
    await database.query(
      `
        INSERT INTO app.tenant_user_access (tenant_id, user_id)
        VALUES ($1, $2), ($3, $4)
      `,
      [TENANT_A, USER_A, TENANT_B, USER_B],
    );
    await database.query(
      `
        INSERT INTO app.launch_evidence (
          id, evidence_code, scope_type, scope_key, state, restricted_reference,
          effective_at, approved_by, approved_at
        ) VALUES
          ($1, 'create-service-concurrency-template', 'template', $2, 'approved',
            'restricted:test-only-template', clock_timestamp() - interval '1 hour',
            'test-principal', clock_timestamp() - interval '1 hour'),
          ($3, 'create-service-concurrency-mapping', 'mapping', $4, 'approved',
            'restricted:test-only-mapping', clock_timestamp() - interval '1 hour',
            'test-principal', clock_timestamp() - interval '1 hour')
      `,
      [TEMPLATE_EVIDENCE, TEMPLATE, MAPPING_EVIDENCE, PROVIDER_MAPPING],
    );
    await database.query(
      `INSERT INTO app.adapter_definitions (id, code, product_family)
       VALUES ($1, 'create-service-concurrency', 'marketplace_dataset')`,
      [ADAPTER_DEFINITION],
    );
    await database.query(
      `
        INSERT INTO app.adapter_versions (
          id, adapter_definition_id, semantic_version, code_artifact_digest, state
        ) VALUES ($1, $2, '1.0.0', $3, 'enabled')
      `,
      [ADAPTER_VERSION, ADAPTER_DEFINITION, sha256("create-service-concurrency-adapter")],
    );
    await database.query(
      `INSERT INTO app.service_templates (id, slug, product_family, state)
       VALUES ($1, $2, 'marketplace_dataset', 'draft')`,
      [TEMPLATE, TEMPLATE_SLUG],
    );
    await database.query(
      `
        INSERT INTO app.service_template_versions (
          id, service_template_id, version, public_name, public_description,
          input_schema, configuration_schema, presentation_metadata,
          output_schema, availability_copy, availability_state,
          adapter_version_id, launch_evidence_id, effective_at, published_at
        ) VALUES (
          $1, $2, 1, 'Concurrency fixture', 'Privileged self-cleaning test fixture',
          $3::jsonb, $3::jsonb,
          '{"domain_slug":"test","domain_name":"Test","category":"test","icon_key":"test","operation_group":"Test","operation_name":"Run","display_priority":999}'::jsonb,
          '{"type":"object"}'::jsonb, 'Available', 'available',
          $4, $5, clock_timestamp() - interval '1 hour',
          clock_timestamp() - interval '1 hour'
        )
      `,
      [
        TEMPLATE_VERSION,
        TEMPLATE,
        JSON.stringify({
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: { query: { type: "string", minLength: 1, maxLength: 100 } },
        }),
        ADAPTER_VERSION,
        TEMPLATE_EVIDENCE,
      ],
    );
    await database.query(
      `UPDATE app.service_templates
       SET state = 'published', current_public_version_id = $2
       WHERE id = $1`,
      [TEMPLATE, TEMPLATE_VERSION],
    );
    await database.query(
      `
        INSERT INTO app.provider_credentials (
          id, provider_code, environment, vault_secret_reference,
          permission_label, state, activated_at
        ) VALUES (
          $1, 'bright_data', 'test', 'vault://test-only/create-service-concurrency',
          'test-only', 'active', clock_timestamp() - interval '1 hour'
        )
      `,
      [PROVIDER_CREDENTIAL],
    );
    await database.query(
      `
        INSERT INTO app.provider_mappings (
          id, service_template_version_id, adapter_version_id,
          provider_credential_id, environment, operation_code,
          provider_resource_ciphertext, provider_resource_fingerprint,
          output_policy, commercial_config_version, config_version,
          launch_evidence_id, state
        ) VALUES (
          $1, $2, $3, $4, 'test', 'marketplace.snapshot',
          convert_to('private-test-only', 'UTF8'), $5, '{}'::jsonb,
          'test-v1', 'test-v1', $6, 'enabled'
        )
      `,
      [
        PROVIDER_MAPPING,
        TEMPLATE_VERSION,
        ADAPTER_VERSION,
        PROVIDER_CREDENTIAL,
        sha256("create-service-concurrency-resource"),
        MAPPING_EVIDENCE,
      ],
    );
    await database.query("SET CONSTRAINTS ALL IMMEDIATE");
  });
}

function service() {
  return createServiceService({
    repository: createServiceRepository(must(runtimePools).admission),
    validator: createServiceConfigurationValidator(),
    csrf: { issue: () => "unused", verify: () => true },
    providerEnvironment: "test",
  });
}

function browserRequest(input: {
  readonly tenantId?: string;
  readonly userId?: string;
  readonly idempotencyKey: string;
  readonly name: string;
  readonly query?: string;
  readonly requestId?: string | null;
}) {
  return {
    principal: {
      kind: "browser" as const,
      tenantId: input.tenantId ?? TENANT_A,
      userId: input.userId ?? USER_A,
      sessionId: randomUUID(),
    },
    csrfToken: "valid-csrf-token-value",
    idempotencyKey: input.idempotencyKey,
    body: {
      template_slug: TEMPLATE_SLUG,
      name: input.name,
      configuration: { query: input.query ?? "laptop" },
    },
    schemaErrors: [],
    requestId: input.requestId === undefined ? randomUUID() : input.requestId,
    ipFingerprint: sha256("127.0.0.1"),
  };
}

async function aggregateCounts(tenantId: string, name: string, keys: readonly string[]) {
  const result = await must(privilegedPool).query<{
    services: number;
    versions: number;
    audits: number;
    claims: number;
  }>(
    `
      SELECT
        (SELECT count(*)::int FROM app.services
          WHERE tenant_id = $1 AND name = $2) AS services,
        (SELECT count(*)::int FROM app.service_versions AS version
          JOIN app.services AS service ON service.id = version.service_id
          WHERE service.tenant_id = $1 AND service.name = $2) AS versions,
        (SELECT count(*)::int FROM app.audit_events AS audit
          JOIN app.services AS service ON service.id = audit.target_id
          WHERE audit.tenant_id = $1 AND service.name = $2
            AND audit.action = 'services.create') AS audits,
        (SELECT count(*)::int FROM app.idempotency_records
          WHERE tenant_id = $1 AND operation_code = 'services.create'
            AND idempotency_key = ANY($3::text[])) AS claims
    `,
    [tenantId, name, keys],
  );
  return result.rows[0];
}

beforeAll(async () => {
  const identity = await must(privilegedPool).query<{
    current_database: string;
    rolsuper: boolean;
  }>(
    `SELECT current_database(), rolsuper
     FROM pg_roles WHERE rolname = current_user`,
  );
  expect(identity.rows[0]).toEqual({ current_database: "dhumi_test", rolsuper: true });
  await cleanupFixtures();
  await seedFixtures();
});

afterAll(async () => {
  try {
    if (privilegedPool) await cleanupFixtures();
  } finally {
    await Promise.all([runtimePools?.close(), privilegedPool?.end()]);
  }
});

describe.skipIf(!enabled)("create Service privileged PostgreSQL races", () => {
  it("serializes same-key callers into one aggregate and exact replay", async () => {
    const operation = service();
    const key = "concurrency-same-key-0001";
    const name = "Same key race";
    const results = await Promise.all(
      Array.from({ length: 8 }, () => operation.create(browserRequest({ idempotencyKey: key, name }))),
    );

    expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1);
    expect(await aggregateCounts(TENANT_A, name, [key])).toEqual({
      services: 1,
      versions: 1,
      audits: 1,
      claims: 1,
    });

    await expect(
      operation.create(browserRequest({ idempotencyKey: key, name, query: "different" })),
    ).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    expect(await aggregateCounts(TENANT_A, name, [key])).toEqual({
      services: 1,
      versions: 1,
      audits: 1,
      claims: 1,
    });
  });

  it("returns one success and one state conflict for different keys with one name", async () => {
    const operation = service();
    const keys = ["concurrency-name-key-0001", "concurrency-name-key-0002"] as const;
    const name = "Same name race";
    const outcomes = await Promise.allSettled([
      operation.create(browserRequest({ idempotencyKey: keys[0], name, query: "first" })),
      operation.create(browserRequest({ idempotencyKey: keys[1], name, query: "second" })),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { status: 409, code: "STATE_CONFLICT" },
    });
    expect(await aggregateCounts(TENANT_A, name, keys)).toEqual({
      services: 1,
      versions: 1,
      audits: 1,
      claims: 1,
    });
  });

  it("keeps identical names and key text independent across Tenants", async () => {
    const operation = service();
    const key = "concurrency-cross-tenant-0001";
    const name = "Cross Tenant name";
    const [first, second] = await Promise.all([
      operation.create(browserRequest({ idempotencyKey: key, name })),
      operation.create(browserRequest({
        tenantId: TENANT_B,
        userId: USER_B,
        idempotencyKey: key,
        name,
      })),
    ]);

    expect(first.id).not.toBe(second.id);
    expect(await aggregateCounts(TENANT_A, name, [key])).toEqual({
      services: 1,
      versions: 1,
      audits: 1,
      claims: 1,
    });
    expect(await aggregateCounts(TENANT_B, name, [key])).toEqual({
      services: 1,
      versions: 1,
      audits: 1,
      claims: 1,
    });
  });

  it("persists the browser creator and audit actor", async () => {
    const created = await service().create(browserRequest({ idempotencyKey: "concurrency-browser-actor-0001", name: "Browser actor" }));
    const attribution = await must(privilegedPool).query(
      `SELECT version.created_by_user_id, audit.actor_user_id
       FROM app.service_versions AS version
       JOIN app.audit_events AS audit ON audit.tenant_id = version.tenant_id AND audit.target_id = version.service_id
       WHERE version.service_id = $1`, [created.id]);
    expect(attribution.rows[0]).toEqual({ created_by_user_id: USER_A, actor_user_id: USER_A });
  });

  it("rolls the complete aggregate back when the late audit insert fails", async () => {
    const operation = service();
    const key = "concurrency-audit-fail-0001";
    const name = "Audit rollback";
    await expect(
      operation.create(browserRequest({
        idempotencyKey: key,
        name,
        requestId: "not-a-uuid",
      })),
    ).rejects.toMatchObject({ status: 500, code: "INTERNAL_ERROR" });
    expect(await aggregateCounts(TENANT_A, name, [key])).toEqual({
      services: 0,
      versions: 0,
      audits: 0,
      claims: 0,
    });
  });
});
