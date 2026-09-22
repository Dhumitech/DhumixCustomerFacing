import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import { createServiceConfigurationValidator } from "../../src/helpers/serviceConfigurationValidator.js";
import { createCancelRunRepository } from "../../src/services/admission/cancelRunRepository.js";
import { createCancelRunService } from "../../src/services/admission/cancelRunService.js";
import { createRunRepository } from "../../src/services/admission/createRunRepository.js";
import { createRunService } from "../../src/services/admission/createRunService.js";
import { createDatabasePools } from "../../src/services/database/pools.js";

const enabled =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" &&
  process.env.RUN_CANCEL_RUN_PRIVILEGED_TESTS === "true";
const config = enabled ? loadRuntimeConfig() : undefined;
const privilegedUrl = enabled ? process.env.PRIVILEGED_TEST_DATABASE_URL : undefined;
const privilegedPassword = enabled ? process.env.PGPASSWORD : undefined;

if (enabled && config?.database.database !== "dhumi_test") {
  throw new Error("Privileged cancel-Run tests may run only against dhumi_test");
}
if (enabled && (!privilegedUrl || !privilegedPassword)) {
  throw new Error("Privileged cancel-Run tests require the secure wrapper script");
}

const runtimePools = enabled && config
  ? createDatabasePools(config.database, () => {})
  : undefined;
const privilegedPool = enabled
  ? new Pool({
      connectionString: privilegedUrl,
      password: privilegedPassword,
      application_name: "dhumi-cancel-run-privileged-tests",
      max: 3,
    })
  : undefined;

const TENANT = "76000000-0000-4000-8000-000000000001";
const USER = "76000000-0000-4000-8000-000000000002";
const TEMPLATE_EVIDENCE = "76000000-0000-4000-8000-000000000003";
const MAPPING_EVIDENCE = "76000000-0000-4000-8000-000000000004";
const FEATURE_EVIDENCE = "76000000-0000-4000-8000-000000000005";
const FEATURE_FLAG = "76000000-0000-4000-8000-000000000006";
const ADAPTER_DEFINITION = "76000000-0000-4000-8000-000000000007";
const ADAPTER_VERSION = "76000000-0000-4000-8000-000000000008";
const TEMPLATE = "76000000-0000-4000-8000-000000000009";
const TEMPLATE_VERSION = "76000000-0000-4000-8000-00000000000a";
const PROVIDER_CREDENTIAL = "76000000-0000-4000-8000-00000000000b";
const PROVIDER_MAPPING = "76000000-0000-4000-8000-00000000000c";
const SERVICE = "76000000-0000-4000-8000-00000000000d";
const SERVICE_VERSION = "76000000-0000-4000-8000-00000000000e";

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
    await database.query(
      "DELETE FROM app.outbox_events WHERE tenant_id = $1 AND topic IN ('jobs.execute', 'jobs.cancel')",
      [TENANT],
    );
    await database.query(
      "DELETE FROM app.audit_events WHERE tenant_id = $1 AND action IN ('run.create', 'run.cancel')",
      [TENANT],
    );
    await database.query(
      "DELETE FROM app.idempotency_records WHERE tenant_id = $1 AND operation_code IN ('runs.create', 'runs.cancel')",
      [TENANT],
    );
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

async function seed(): Promise<void> {
  await inTransaction(must(privilegedPool), async (database) => {
    await database.query("SET CONSTRAINTS ALL DEFERRED");
    await database.query(
      "INSERT INTO app.users (id, email_normalized, password_hash) VALUES ($1, 'cancel-run-concurrency@example.test', '$argon2id$test-only')",
      [USER],
    );
    await database.query(
      "INSERT INTO app.tenants (id, display_name) VALUES ($1, 'Cancel Run concurrency')",
      [TENANT],
    );
    await database.query(
      "INSERT INTO app.tenant_user_access (tenant_id, user_id) VALUES ($1, $2)",
      [TENANT, USER],
    );
    await database.query(
      `
        INSERT INTO app.launch_evidence (
          id, evidence_code, scope_type, scope_key, state, restricted_reference,
          effective_at, approved_by, approved_at
        ) VALUES
          ($1, 'cancel-run-template', 'template', $2, 'approved',
            'restricted:test-template', clock_timestamp() - interval '1 hour',
            'test-principal', clock_timestamp() - interval '1 hour'),
          ($3, 'cancel-run-mapping', 'mapping', $4, 'approved',
            'restricted:test-mapping', clock_timestamp() - interval '1 hour',
            'test-principal', clock_timestamp() - interval '1 hour'),
          ($5, 'cancel-run-feature', 'feature', $6, 'approved',
            'restricted:test-feature', clock_timestamp() - interval '1 hour',
            'test-principal', clock_timestamp() - interval '1 hour')
      `,
      [
        TEMPLATE_EVIDENCE,
        TEMPLATE_VERSION,
        MAPPING_EVIDENCE,
        PROVIDER_MAPPING,
        FEATURE_EVIDENCE,
        FEATURE_FLAG,
      ],
    );
    await database.query(
      `
        INSERT INTO app.feature_flags (
          id, feature_code, environment, state, launch_evidence_id,
          changed_by, changed_reason
        ) VALUES ($1, 'marketplace_dataset', 'test', 'enabled', $2,
          'test-principal', 'privileged cancellation test')
      `,
      [FEATURE_FLAG, FEATURE_EVIDENCE],
    );
    await database.query(
      "INSERT INTO app.adapter_definitions (id, code, product_family) VALUES ($1, 'cancel-run-concurrency', 'marketplace_dataset')",
      [ADAPTER_DEFINITION],
    );
    await database.query(
      `INSERT INTO app.adapter_versions (
         id, adapter_definition_id, semantic_version, code_artifact_digest, state
       ) VALUES ($1, $2, '1.0.0', $3, 'enabled')`,
      [ADAPTER_VERSION, ADAPTER_DEFINITION, sha256("cancel-run-adapter")],
    );
    await database.query(
      "INSERT INTO app.service_templates (id, slug, product_family, state) VALUES ($1, 'cancel-run-concurrency', 'marketplace_dataset', 'draft')",
      [TEMPLATE],
    );
    await database.query(
      `
        INSERT INTO app.service_template_versions (
          id, service_template_id, version, public_name, public_description,
          input_schema, configuration_schema, presentation_metadata,
          output_schema, availability_copy, availability_state,
          adapter_version_id, launch_evidence_id, effective_at, published_at
        ) VALUES (
          $1, $2, 1, 'Cancel Run concurrency', 'Privileged self-cleaning fixture',
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
      `
        INSERT INTO app.provider_credentials (
          id, provider_code, environment, vault_secret_reference,
          permission_label, state, activated_at
        ) VALUES ($1, 'bright_data', 'test', 'vault://test-only/cancel-run',
          'test-only', 'active', clock_timestamp() - interval '1 hour')
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
        ) VALUES ($1, $2, $3, $4, 'test', 'marketplace.snapshot',
          convert_to('private-test-only', 'UTF8'), $5, '{}'::jsonb,
          'test-v1', 'test-v1', $6, 'enabled')
      `,
      [
        PROVIDER_MAPPING,
        TEMPLATE_VERSION,
        ADAPTER_VERSION,
        PROVIDER_CREDENTIAL,
        sha256("cancel-run-resource"),
        MAPPING_EVIDENCE,
      ],
    );
    await database.query(
      `INSERT INTO app.services (
         id, tenant_id, service_template_id, name, state, current_version
       ) VALUES ($1, $2, $3, 'Cancel Run Service', 'active', 1)`,
      [SERVICE, TENANT, TEMPLATE],
    );
    await database.query(
      `INSERT INTO app.service_versions (
         id, tenant_id, service_id, version, service_template_version_id,
         validated_configuration, schema_hash, created_by_user_id,
         created_by_api_key_id
       ) VALUES ($1, $2, $3, 1, $4, '{}'::jsonb, $5, $6, NULL)`,
      [SERVICE_VERSION, TENANT, SERVICE, TEMPLATE_VERSION, sha256("cancel-run-schema"), USER],
    );
    await database.query("SET CONSTRAINTS ALL IMMEDIATE");
  });
}

function createOperation() {
  return createRunService({
    repository: createRunRepository(must(runtimePools).admission),
    validator: createServiceConfigurationValidator(),
    csrf: { issue: () => "unused", verify: () => true },
    providerEnvironment: "test",
  });
}

function cancelOperation() {
  return createCancelRunService({
    repository: createCancelRunRepository(must(runtimePools).admission),
    csrf: { issue: () => "unused", verify: () => true },
  });
}

async function queuedRun(query: string) {
  return createOperation().create({
    principal: {
      kind: "browser",
      tenantId: TENANT,
      userId: USER,
      sessionId: randomUUID(),
    },
    csrfToken: "valid-csrf-token-value",
    idempotencyKey: `run-create-for-cancel-${randomUUID()}`,
    serviceId: SERVICE,
    body: { input: { query } },
    schemaErrors: [],
    requestId: randomUUID(),
    ipFingerprint: sha256("127.0.0.1"),
  });
}

function cancelRequest(runId: string, key: string, requestId: string | null = randomUUID()) {
  return {
    principal: {
      kind: "browser" as const,
      tenantId: TENANT,
      userId: USER,
      sessionId: randomUUID(),
    },
    csrfToken: "valid-csrf-token-value",
    idempotencyKey: key,
    runId,
    bodyPresent: false,
    schemaErrors: [],
    requestId,
    ipFingerprint: sha256("127.0.0.1"),
  };
}

async function cancellationEvidence(runId: string, keys: readonly string[]) {
  const result = await must(privilegedPool).query<{
    public_status: string;
    internal_status: string;
    claims: number;
    events: number;
    audits: number;
    commands: number;
  }>(
    `
      SELECT
        run.public_status,
        run.internal_status,
        (SELECT count(*)::int FROM app.idempotency_records
          WHERE tenant_id = $1 AND operation_code = 'runs.cancel'
            AND idempotency_key = ANY($3::text[])) AS claims,
        (SELECT count(*)::int FROM app.run_events
          WHERE tenant_id = $1 AND run_id = $2
            AND event_type = 'cancellation_requested') AS events,
        (SELECT count(*)::int FROM app.audit_events
          WHERE tenant_id = $1 AND target_id = $2
            AND action = 'run.cancel') AS audits,
        (SELECT count(*)::int FROM app.outbox_events
          WHERE tenant_id = $1 AND aggregate_id = $2
            AND topic = 'jobs.cancel') AS commands
      FROM app.runs AS run
      WHERE run.tenant_id = $1 AND run.id = $2
    `,
    [TENANT, runId, keys],
  );
  return result.rows[0];
}

beforeAll(async () => {
  const identity = await must(privilegedPool).query<{ current_database: string; rolsuper: boolean }>(
    "SELECT current_database(), rolsuper FROM pg_roles WHERE rolname = current_user",
  );
  expect(identity.rows[0]).toEqual({ current_database: "dhumi_test", rolsuper: true });
  await cleanupAll();
  await seed();
});

beforeEach(async () => {
  await cleanupRunAggregates();
});

afterAll(async () => {
  try {
    if (privilegedPool) await cleanupAll();
  } finally {
    await Promise.all([runtimePools?.close(), privilegedPool?.end()]);
  }
});

describe.skipIf(!enabled)("cancel Run privileged PostgreSQL races", () => {
  it("serializes same-key callers into one intent and exact replay", async () => {
    const run = await queuedRun("same-key");
    const key = "cancel-run-concurrency-same-key-0001";
    const results = await Promise.all(
      Array.from({ length: 8 }, () => cancelOperation().cancel(cancelRequest(run.run_id, key))),
    );

    expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1);
    expect(results[0]).toMatchObject({
      id: run.run_id,
      service_id: SERVICE,
      status: "queued",
      error_code: null,
      retryable: false,
      completed_at: null,
    });
    expect(await cancellationEvidence(run.run_id, [key])).toEqual({
      public_status: "queued",
      internal_status: "QUEUED",
      claims: 1,
      events: 1,
      audits: 1,
      commands: 1,
    });
  });

  it("serializes different keys into one command and two completed claims", async () => {
    const run = await queuedRun("different-keys");
    const keys = [
      "cancel-run-concurrency-different-key-a",
      "cancel-run-concurrency-different-key-b",
    ];
    const results = await Promise.all(
      keys.map((key) => cancelOperation().cancel(cancelRequest(run.run_id, key))),
    );

    expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1);
    expect(results[0]?.id).toBe(run.run_id);
    expect(await cancellationEvidence(run.run_id, keys)).toEqual({
      public_status: "queued",
      internal_status: "QUEUED",
      claims: 2,
      events: 1,
      audits: 2,
      commands: 1,
    });
  });

  it("keeps later Job Manager transition event ordering collision-free", async () => {
    const run = await queuedRun("transition-order");
    const key = "cancel-run-concurrency-transition-0001";
    await cancelOperation().cancel(cancelRequest(run.run_id, key));

    const versionResult = await must(privilegedPool).query<{ state_version: string }>(
      "SELECT state_version::text AS state_version FROM app.runs WHERE tenant_id = $1 AND id = $2",
      [TENANT, run.run_id],
    );
    const expectedStateVersion = versionResult.rows[0]?.state_version;
    expect(expectedStateVersion).toBe("1");

    await inTransaction(must(privilegedPool), async (database) => {
      await database.query("SET LOCAL ROLE dhumi_job_manager");
      await database.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT]);

      const claimResult = await database.query<{
        disposition: string;
        attempt_id: string | null;
        fence_token: string | null;
        run_state_version: string;
        cancellation_requested: boolean;
      }>(
        `
          SELECT
            disposition,
            attempt_id,
            fence_token,
            run_state_version::text,
            cancellation_requested
          FROM app.claim_run_attempt(
            $1::uuid, 'submission', interval '1 minute'
          )
        `,
        [run.run_id],
      );
      const claim = claimResult.rows[0];
      expect(claim).toMatchObject({
        disposition: "claimed",
        run_state_version: expectedStateVersion,
        cancellation_requested: true,
      });
      expect(claim?.attempt_id).not.toBeNull();
      expect(claim?.fence_token).not.toBeNull();

      await database.query(
        `
          SELECT app.transition_run_fenced(
            $1::uuid, $2::bigint, 'CANCELLED', 'cancelled', $3,
            $4::uuid, $5::uuid, NULL, false,
            '{"status":"cancelled"}'::jsonb
          )
        `,
        [
          run.run_id,
          expectedStateVersion,
          `job.cancelled.v1:${claim?.attempt_id}`,
          claim?.attempt_id,
          claim?.fence_token,
        ],
      );

      const finishResult = await database.query<{ finished: boolean }>(
        `
          SELECT app.finish_run_attempt_claim(
            $1::uuid, $2::uuid, 'completed', 'cancelled_before_execution'
          ) AS finished
        `,
        [claim?.attempt_id, claim?.fence_token],
      );
      expect(finishResult.rows[0]?.finished).toBe(true);
    });

    const result = await must(privilegedPool).query<{
      public_status: string;
      internal_status: string;
      sequences: string[];
      event_types: string[];
    }>(
      `
        SELECT
          run.public_status,
          run.internal_status,
          ARRAY_AGG(event.sequence::text ORDER BY event.sequence) AS sequences,
          ARRAY_AGG(event.event_type ORDER BY event.sequence) AS event_types
        FROM app.runs AS run
        JOIN app.run_events AS event
          ON event.tenant_id = run.tenant_id AND event.run_id = run.id
        WHERE run.tenant_id = $1 AND run.id = $2
        GROUP BY run.public_status, run.internal_status
      `,
      [TENANT, run.run_id],
    );
    expect(result.rows[0]).toEqual({
      public_status: "cancelled",
      internal_status: "CANCELLED",
      sequences: ["1", "2", "3"],
      event_types: ["accepted", "cancellation_requested", "cancelled"],
    });
  });

  it("rolls the entire cancellation intent back when the late audit insert fails", async () => {
    const run = await queuedRun("audit-rollback");
    const key = "cancel-run-concurrency-audit-fail-0001";
    await expect(
      cancelOperation().cancel(cancelRequest(run.run_id, key, "not-a-uuid")),
    ).rejects.toMatchObject({ status: 500, code: "INTERNAL_ERROR" });

    expect(await cancellationEvidence(run.run_id, [key])).toEqual({
      public_status: "queued",
      internal_status: "QUEUED",
      claims: 0,
      events: 0,
      audits: 0,
      commands: 0,
    });
  });
});
