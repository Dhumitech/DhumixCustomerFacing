import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import { createServiceConfigurationValidator } from "../../src/helpers/serviceConfigurationValidator.js";
import { createRetryRunRepository } from "../../src/services/admission/retryRunRepository.js";
import { createRetryRunService } from "../../src/services/admission/retryRunService.js";
import { createDatabasePools } from "../../src/services/database/pools.js";

const enabled =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" &&
  process.env.RUN_RETRY_RUN_PRIVILEGED_TESTS === "true";
const config = enabled ? loadRuntimeConfig() : undefined;
const privilegedUrl = enabled ? process.env.PRIVILEGED_TEST_DATABASE_URL : undefined;
const privilegedPassword = enabled ? process.env.PGPASSWORD : undefined;

if (enabled && config?.database.database !== "dhumi_test") {
  throw new Error("Privileged retry-Run tests may run only against dhumi_test");
}
if (enabled && (!privilegedUrl || !privilegedPassword)) {
  throw new Error("Privileged retry-Run tests require the secure wrapper script");
}

const runtimePools = enabled && config
  ? createDatabasePools(config.database, () => {})
  : undefined;
const privilegedPool = enabled
  ? new Pool({
      connectionString: privilegedUrl,
      password: privilegedPassword,
      application_name: "dhumi-retry-run-privileged-tests",
      max: 3,
    })
  : undefined;

const TENANT = "77000000-0000-4000-8000-000000000001";
const USER = "77000000-0000-4000-8000-000000000002";
const TEMPLATE_EVIDENCE = "77000000-0000-4000-8000-000000000003";
const MAPPING_EVIDENCE = "77000000-0000-4000-8000-000000000004";
const FEATURE_EVIDENCE = "77000000-0000-4000-8000-000000000005";
const FEATURE_FLAG = "77000000-0000-4000-8000-000000000006";
const ADAPTER_DEFINITION = "77000000-0000-4000-8000-000000000007";
const ADAPTER_VERSION = "77000000-0000-4000-8000-000000000008";
const TEMPLATE = "77000000-0000-4000-8000-000000000009";
const TEMPLATE_VERSION = "77000000-0000-4000-8000-00000000000a";
const PROVIDER_CREDENTIAL = "77000000-0000-4000-8000-00000000000b";
const PROVIDER_MAPPING = "77000000-0000-4000-8000-00000000000c";
const SERVICE = "77000000-0000-4000-8000-00000000000d";
const SERVICE_VERSION = "77000000-0000-4000-8000-00000000000e";
const SOURCE_RUN = "77000000-0000-4000-8000-00000000000f";

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

async function cleanupRunAggregates(): Promise<void> {
  await inTransaction(must(privilegedPool), async (database) => {
    await database.query("SET LOCAL session_replication_role = replica");
    await database.query("DELETE FROM app.outbox_events WHERE tenant_id = $1", [TENANT]);
    await database.query("DELETE FROM app.audit_events WHERE tenant_id = $1 AND action = 'run.retry'", [TENANT]);
    await database.query("DELETE FROM app.idempotency_records WHERE tenant_id = $1 AND operation_code = 'runs.retry'", [TENANT]);
    await database.query("DELETE FROM app.run_attempts WHERE tenant_id = $1", [TENANT]);
    await database.query("DELETE FROM app.provider_cost_holds WHERE tenant_id = $1", [TENANT]);
    await database.query("DELETE FROM app.run_events WHERE tenant_id = $1", [TENANT]);
    await database.query("DELETE FROM app.runs WHERE tenant_id = $1", [TENANT]);
  });
}

async function cleanupAll(): Promise<void> {
  await cleanupRunAggregates();
  await inTransaction(must(privilegedPool), async (database) => {
    await database.query("SET LOCAL session_replication_role = replica");
    await database.query("DELETE FROM app.service_versions WHERE id = $1", [SERVICE_VERSION]);
    await database.query("DELETE FROM app.services WHERE id = $1", [SERVICE]);
    await database.query("DELETE FROM app.provider_mappings WHERE id = $1", [PROVIDER_MAPPING]);
    await database.query("DELETE FROM app.provider_credentials WHERE id = $1", [PROVIDER_CREDENTIAL]);
    await database.query("DELETE FROM app.service_template_versions WHERE id = $1", [TEMPLATE_VERSION]);
    await database.query("DELETE FROM app.service_templates WHERE id = $1", [TEMPLATE]);
    await database.query("DELETE FROM app.adapter_versions WHERE id = $1", [ADAPTER_VERSION]);
    await database.query("DELETE FROM app.adapter_definitions WHERE id = $1", [ADAPTER_DEFINITION]);
    await database.query("DELETE FROM app.feature_flags WHERE id = $1", [FEATURE_FLAG]);
    await database.query(
      "DELETE FROM app.launch_evidence WHERE id = ANY($1::uuid[])",
      [[TEMPLATE_EVIDENCE, MAPPING_EVIDENCE, FEATURE_EVIDENCE]],
    );
    await database.query("DELETE FROM app.tenant_user_access WHERE tenant_id = $1", [TENANT]);
    await database.query("DELETE FROM app.tenants WHERE id = $1", [TENANT]);
    await database.query("DELETE FROM app.users WHERE id = $1", [USER]);
  });
}

async function seedRelease(): Promise<void> {
  await inTransaction(must(privilegedPool), async (database) => {
    await database.query("SET CONSTRAINTS ALL DEFERRED");
    await database.query(
      "INSERT INTO app.users (id, email_normalized, password_hash) VALUES ($1, 'retry-run-concurrency@example.test', '$argon2id$test-only')",
      [USER],
    );
    await database.query("INSERT INTO app.tenants (id, display_name) VALUES ($1, 'Retry Run concurrency')", [TENANT]);
    await database.query("INSERT INTO app.tenant_user_access (tenant_id, user_id) VALUES ($1, $2)", [TENANT, USER]);
    await database.query(
      `
        INSERT INTO app.launch_evidence (
          id, evidence_code, scope_type, scope_key, state, restricted_reference,
          effective_at, approved_by, approved_at
        ) VALUES
          ($1, 'retry-run-template', 'template', $2, 'approved',
            'restricted:test-template', clock_timestamp() - interval '1 hour',
            'test-principal', clock_timestamp() - interval '1 hour'),
          ($3, 'retry-run-mapping', 'mapping', $4, 'approved',
            'restricted:test-mapping', clock_timestamp() - interval '1 hour',
            'test-principal', clock_timestamp() - interval '1 hour'),
          ($5, 'retry-run-feature', 'feature', $6, 'approved',
            'restricted:test-feature', clock_timestamp() - interval '1 hour',
            'test-principal', clock_timestamp() - interval '1 hour')
      `,
      [TEMPLATE_EVIDENCE, TEMPLATE_VERSION, MAPPING_EVIDENCE, PROVIDER_MAPPING, FEATURE_EVIDENCE, FEATURE_FLAG],
    );
    await database.query(
      `INSERT INTO app.feature_flags (
         id, feature_code, environment, state, launch_evidence_id,
         changed_by, changed_reason
       ) VALUES ($1, 'marketplace_dataset', 'test', 'enabled', $2,
         'test-principal', 'rollback-safe retry proof')`,
      [FEATURE_FLAG, FEATURE_EVIDENCE],
    );
    await database.query(
      "INSERT INTO app.adapter_definitions (id, code, product_family) VALUES ($1, 'retry-run-concurrency', 'marketplace_dataset')",
      [ADAPTER_DEFINITION],
    );
    await database.query(
      `INSERT INTO app.adapter_versions (
         id, adapter_definition_id, semantic_version, code_artifact_digest, state
       ) VALUES ($1, $2, '1.0.0', $3, 'enabled')`,
      [ADAPTER_VERSION, ADAPTER_DEFINITION, sha256("retry-run-adapter")],
    );
    await database.query(
      "INSERT INTO app.service_templates (id, slug, product_family, state) VALUES ($1, 'retry-run-concurrency', 'marketplace_dataset', 'draft')",
      [TEMPLATE],
    );
    await database.query(
      `INSERT INTO app.service_template_versions (
         id, service_template_id, version, public_name, public_description,
         input_schema, configuration_schema, presentation_metadata,
         output_schema, availability_copy, availability_state,
         adapter_version_id, launch_evidence_id, effective_at, published_at
       ) VALUES (
         $1, $2, 1, 'Retry Run concurrency', 'Privileged self-cleaning fixture',
         $3::jsonb, $3::jsonb,
         '{"domain_slug":"test","domain_name":"Test","category":"test","icon_key":"test","operation_group":"Test","operation_name":"Run","display_priority":999}'::jsonb,
         '{"type":"object"}'::jsonb, 'Available', 'available',
         $4, $5, clock_timestamp() - interval '1 hour',
         clock_timestamp() - interval '1 hour'
       )`,
      [
        TEMPLATE_VERSION,
        TEMPLATE,
        JSON.stringify({
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: { query: { type: "string", minLength: 1 } },
        }),
        ADAPTER_VERSION,
        TEMPLATE_EVIDENCE,
      ],
    );
    await database.query(
      "UPDATE app.service_templates SET state = 'published', current_public_version_id = $2 WHERE id = $1",
      [TEMPLATE, TEMPLATE_VERSION],
    );
    await database.query(
      `INSERT INTO app.provider_credentials (
         id, provider_code, environment, vault_secret_reference,
         permission_label, state, activated_at
       ) VALUES ($1, 'bright_data', 'test', 'vault://test-only/retry-run',
         'test-only', 'active', clock_timestamp() - interval '1 hour')`,
      [PROVIDER_CREDENTIAL],
    );
    await database.query(
      `INSERT INTO app.provider_mappings (
         id, service_template_version_id, adapter_version_id,
         provider_credential_id, environment, operation_code,
         provider_resource_ciphertext, provider_resource_fingerprint,
         output_policy, commercial_config_version, config_version,
         launch_evidence_id, state
       ) VALUES ($1, $2, $3, $4, 'test', 'marketplace.snapshot',
         convert_to('private-test-only', 'UTF8'), $5, '{}'::jsonb,
         'test-v1', 'test-v1', $6, 'enabled')`,
      [PROVIDER_MAPPING, TEMPLATE_VERSION, ADAPTER_VERSION, PROVIDER_CREDENTIAL, sha256("retry-run-resource"), MAPPING_EVIDENCE],
    );
    await database.query(
      `INSERT INTO app.services (
         id, tenant_id, service_template_id, name, state, current_version
       ) VALUES ($1, $2, $3, 'Retry Run Service', 'active', 1)`,
      [SERVICE, TENANT, TEMPLATE],
    );
    await database.query(
      `INSERT INTO app.service_versions (
         id, tenant_id, service_id, version, service_template_version_id,
         validated_configuration, schema_hash, created_by_user_id,
         created_by_api_key_id
       ) VALUES ($1, $2, $3, 1, $4, '{}'::jsonb, $5, $6, NULL)`,
      [SERVICE_VERSION, TENANT, SERVICE, TEMPLATE_VERSION, sha256("retry-run-schema"), USER],
    );
    await database.query("SET CONSTRAINTS ALL IMMEDIATE");
  });
}

async function seedSource(): Promise<void> {
  await inTransaction(must(privilegedPool), async (database) => {
    await database.query(
      `INSERT INTO app.runs (
         id, tenant_id, service_version_id, service_template_version_id,
         adapter_version_id, provider_mapping_id, commercial_config_version,
         validated_input, template_launch_evidence_id, mapping_launch_evidence_id,
         feature_flag_id, feature_launch_evidence_id, public_status,
         internal_status, state_version, retryable, customer_error_code,
         completed_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 'test-v1', '{"query":"laptop"}'::jsonb,
         $7, $8, $9, $10, 'failed', 'UPSTREAM_FAILED', 2, true,
         'UPSTREAM_FAILED', clock_timestamp()
       )`,
      [SOURCE_RUN, TENANT, SERVICE_VERSION, TEMPLATE_VERSION, ADAPTER_VERSION, PROVIDER_MAPPING, TEMPLATE_EVIDENCE, MAPPING_EVIDENCE, FEATURE_FLAG, FEATURE_EVIDENCE],
    );
  });
}

function operation() {
  return createRetryRunService({
    repository: createRetryRunRepository(must(runtimePools).admission),
    validator: createServiceConfigurationValidator(),
    csrf: { issue: () => "unused", verify: () => true },
    providerEnvironment: "test",
  });
}

function request(idempotencyKey: string, requestId: string | null = randomUUID()) {
  return {
    principal: {
      kind: "browser" as const,
      tenantId: TENANT,
      userId: USER,
      sessionId: randomUUID(),
    },
    csrfToken: "valid-csrf-token-value",
    idempotencyKey,
    runId: SOURCE_RUN,
    bodyPresent: false,
    schemaErrors: [],
    requestId,
    ipFingerprint: sha256("127.0.0.1"),
  };
}

async function counts(keys: readonly string[]) {
  const result = await must(privilegedPool).query<{
    runs: number;
    holds: number;
    events: number;
    audits: number;
    outbox: number;
    claims: number;
  }>(
    `
      SELECT
        (SELECT count(*)::integer FROM app.runs
          WHERE tenant_id = $1 AND retry_of_run_id = $2) AS runs,
        (SELECT count(*)::integer FROM app.provider_cost_holds AS hold
          JOIN app.runs AS run ON run.id = hold.run_id
          WHERE run.tenant_id = $1 AND run.retry_of_run_id = $2) AS holds,
        (SELECT count(*)::integer FROM app.run_events AS event
          JOIN app.runs AS run ON run.id = event.run_id
          WHERE run.tenant_id = $1 AND run.retry_of_run_id = $2) AS events,
        (SELECT count(*)::integer FROM app.audit_events
          WHERE tenant_id = $1 AND action = 'run.retry') AS audits,
        (SELECT count(*)::integer FROM app.outbox_events AS event
          JOIN app.runs AS run ON run.id = event.aggregate_id
          WHERE run.tenant_id = $1 AND run.retry_of_run_id = $2
            AND event.topic = 'jobs.execute') AS outbox,
        (SELECT count(*)::integer FROM app.idempotency_records
          WHERE tenant_id = $1 AND operation_code = 'runs.retry'
            AND idempotency_key = ANY($3::text[])) AS claims
    `,
    [TENANT, SOURCE_RUN, keys],
  );
  return result.rows[0];
}

describe.skipIf(!enabled)("retry Run privileged PostgreSQL races", () => {
  beforeAll(async () => {
    await cleanupAll();
    await seedRelease();
  });
  beforeEach(async () => {
    await cleanupRunAggregates();
    await seedSource();
  });
  afterAll(async () => {
    if (enabled) await cleanupAll();
    await Promise.all([runtimePools?.close(), privilegedPool?.end()]);
  });

  it("serializes same-key callers into one complete child and exact replay", async () => {
    const key = "retry-run-concurrency-same-0001";
    const results = await Promise.all(
      Array.from({ length: 8 }, () => operation().retry(request(key))),
    );
    expect(new Set(results.map((run) => JSON.stringify(run))).size).toBe(1);
    expect(await counts([key])).toEqual({
      runs: 1,
      holds: 1,
      events: 1,
      audits: 1,
      outbox: 1,
      claims: 1,
    });

    const child = await must(privilegedPool).query<{
      retry_of_run_id: string;
      public_status: string;
      internal_status: string;
      validated_input: unknown;
    }>(
      `SELECT retry_of_run_id, public_status, internal_status, validated_input
       FROM app.runs WHERE id = $1`,
      [results[0]?.run_id],
    );
    expect(child.rows[0]).toEqual({
      retry_of_run_id: SOURCE_RUN,
      public_status: "queued",
      internal_status: "QUEUED",
      validated_input: { query: "laptop" },
    });
  });

  it("allows two different keys to create two safe children for one source", async () => {
    const keys = ["retry-run-different-key-0001", "retry-run-different-key-0002"];
    const results = await Promise.all(keys.map((key) => operation().retry(request(key))));
    expect(new Set(results.map((run) => run.run_id)).size).toBe(2);
    expect(await counts(keys)).toEqual({
      runs: 2,
      holds: 2,
      events: 2,
      audits: 2,
      outbox: 2,
      claims: 2,
    });
  });

  it("blocks an unresolved ambiguous Attempt without leaving a claim", async () => {
    await must(privilegedPool).query(
      `INSERT INTO app.run_attempts (
         tenant_id, run_id, attempt_number, kind, state, adapter_version_id,
         provider_mapping_id, provider_credential_id
       ) VALUES ($1, $2, 1, 'submission', 'ambiguous', $3, $4, $5)`,
      [TENANT, SOURCE_RUN, ADAPTER_VERSION, PROVIDER_MAPPING, PROVIDER_CREDENTIAL],
    );
    const key = "retry-run-ambiguous-0001";
    await expect(operation().retry(request(key))).rejects.toMatchObject({
      status: 409,
      code: "STATE_CONFLICT",
    });
    expect(await counts([key])).toEqual({
      runs: 0,
      holds: 0,
      events: 0,
      audits: 0,
      outbox: 0,
      claims: 0,
    });
  });

  it("rolls the complete child aggregate back when the late audit insert fails", async () => {
    const key = "retry-run-audit-fail-0001";
    await expect(operation().retry(request(key, "not-a-uuid"))).rejects.toMatchObject({
      status: 500,
      code: "INTERNAL_ERROR",
    });
    expect(await counts([key])).toEqual({
      runs: 0,
      holds: 0,
      events: 0,
      audits: 0,
      outbox: 0,
      claims: 0,
    });
  });
});
