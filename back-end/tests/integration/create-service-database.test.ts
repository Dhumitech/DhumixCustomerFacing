import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import { createDatabasePools } from "../../src/services/database/pools.js";
import {
  withAdmissionTenantTransaction,
  withIdentityTransaction,
} from "../../src/services/database/transactions.js";
import { createServiceRepository } from "../../src/services/customerServices/createServiceRepository.js";
import { createServiceService } from "../../src/services/customerServices/createServiceService.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const config = enabled ? loadRuntimeConfig() : undefined;

if (enabled && config?.database.database !== "dhumi_test") {
  throw new Error("Create-Service database tests may run only against dhumi_test");
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
        `service-create-${nonce}@example.test`,
        "$argon2id$service-create-fixture-not-a-real-password",
        `Service create ${nonce.slice(0, 8)}`,
        JSON.stringify([
          {
            document_type: "terms",
            document_version: "service-create-v1",
            document_hash_hex: sha256(`service-create-legal-${nonce}`).toString("hex"),
            disclosure_version: "service-create-v1",
            locale: "en",
          },
        ]),
        `service-create-signup-${nonce}`,
        sha256(`service-create-request-${nonce}`),
        sha256(`service-create-actor-${nonce}`),
        randomUUID(),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("Could not create the Service fixture");
    return { userId: row.user_id, tenantId: row.tenant_id };
  });
}

describe.skipIf(!enabled)("create Service against PostgreSQL", () => {
  it("enforces retained Service constraints and browser-only admission after 0070", async () => {
    const current = await fixture();
    const evidence = await withAdmissionTenantTransaction(
      must(pools).admission,
      current.tenantId,
      async (database) => {
        const constraints = await database.query<{
          conname: string;
          convalidated: boolean;
          definition: string;
        }>(
          `
            SELECT conname, convalidated, pg_get_constraintdef(oid) AS definition
            FROM pg_constraint
            WHERE connamespace = 'app'::regnamespace
              AND conname IN (
                'services_name_check',
                'service_versions_configuration_object_check',
                'service_versions_schema_hash_length_check',
                'service_versions_creator_user_tenant_fk',
                'service_versions_creator_api_key_tenant_fk',
                'service_versions_exactly_one_creator_check',
                'service_versions_browser_creator_check',
                'audit_events_actor_user_tenant_fk',
                'audit_events_actor_api_key_tenant_fk',
                'audit_events_at_most_one_actor_check',
                'idempotency_records_response_body_object_check',
                'idempotency_records_service_create_semantics_check'
              )
            ORDER BY conname
          `,
        );
        const privileges = await database.query<{
          mapping_id: boolean;
          mapping_ciphertext: boolean;
          mapping_fingerprint: boolean;
          mapping_credential: boolean;
          adapter_state: boolean;
          adapter_request_schema: boolean;
          evidence_state: boolean;
          evidence_reference: boolean;
          replay_body_select: boolean;
          claim_hash_update: boolean;
          creator_user_insert: boolean;
          audit_actor_user_insert: boolean;
        }>(
          `
            SELECT
              has_column_privilege(current_user, 'app.provider_mappings', 'id', 'SELECT') AS mapping_id,
              has_column_privilege(current_user, 'app.provider_mappings', 'provider_resource_ciphertext', 'SELECT') AS mapping_ciphertext,
              has_column_privilege(current_user, 'app.provider_mappings', 'provider_resource_fingerprint', 'SELECT') AS mapping_fingerprint,
              has_column_privilege(current_user, 'app.provider_mappings', 'provider_credential_id', 'SELECT') AS mapping_credential,
              has_column_privilege(current_user, 'app.adapter_versions', 'state', 'SELECT') AS adapter_state,
              has_column_privilege(current_user, 'app.adapter_versions', 'request_schema', 'SELECT') AS adapter_request_schema,
              has_column_privilege(current_user, 'app.launch_evidence', 'state', 'SELECT') AS evidence_state,
              has_column_privilege(current_user, 'app.launch_evidence', 'restricted_reference', 'SELECT') AS evidence_reference,
              has_column_privilege(current_user, 'app.idempotency_records', 'response_body', 'SELECT') AS replay_body_select,
              has_column_privilege(current_user, 'app.idempotency_records', 'request_hash', 'UPDATE') AS claim_hash_update,
              has_column_privilege(current_user, 'app.service_versions', 'created_by_user_id', 'INSERT') AS creator_user_insert,
              has_column_privilege(current_user, 'app.audit_events', 'actor_user_id', 'INSERT') AS audit_actor_user_insert
          `,
        );
        return { constraints: constraints.rows, privileges: privileges.rows[0] };
      },
    );

    // The query also names the four retired constraints, so their return fails
    // this exact set rather than being mistaken for retained security checks.
    expect(evidence.constraints.map((row) => row.conname)).toEqual([
      "audit_events_actor_user_tenant_fk",
      "idempotency_records_response_body_object_check",
      "idempotency_records_service_create_semantics_check",
      "service_versions_browser_creator_check",
      "service_versions_configuration_object_check",
      "service_versions_creator_user_tenant_fk",
      "service_versions_schema_hash_length_check",
      "services_name_check",
    ]);
    expect(evidence.constraints.every((row) => row.convalidated)).toBe(true);
    expect(evidence.constraints.find(
      (row) => row.conname === "service_versions_browser_creator_check",
    )?.definition).toMatch(/created_by_user_id IS NOT NULL/);
    expect(evidence.privileges).toEqual({
      mapping_id: true,
      mapping_ciphertext: false,
      mapping_fingerprint: false,
      mapping_credential: false,
      adapter_state: true,
      adapter_request_schema: false,
      evidence_state: true,
      evidence_reference: false,
      replay_body_select: true,
      claim_hash_update: false,
      creator_user_insert: true,
      audit_actor_user_insert: true,
    });
  });

  it("rolls back the idempotency claim for an unknown Template", async () => {
    const current = await fixture();
    const idempotencyKey = `unknown-template-${randomUUID()}`;
    const service = createServiceService({
      repository: createServiceRepository(must(pools).admission),
      validator: {
        validate: vi.fn(() => ({ valid: true as const, schemaHash: Buffer.alloc(32) })),
      },
      csrf: { issue: vi.fn(), verify: vi.fn(() => true) },
      providerEnvironment: "test",
    });

    await expect(
      service.create({
        principal: {
          kind: "browser",
          tenantId: current.tenantId,
          userId: current.userId,
          sessionId: randomUUID(),
        },
        csrfToken: "valid-csrf-token-value",
        idempotencyKey,
        body: { template_slug: "does-not-exist", name: "No write", configuration: {} },
        schemaErrors: [],
        requestId: randomUUID(),
        ipFingerprint: sha256("127.0.0.1"),
      }),
    ).rejects.toMatchObject({ status: 422, code: "SERVICE_INPUT_INVALID" });

    const count = await withIdentityTransaction(must(pools).identity, async (database) => {
      const result = await database.query<{ count: string }>(
        `
          SELECT count(*)::text AS count
          FROM app.idempotency_records
          WHERE tenant_id = $1
            AND operation_code = 'services.create'
            AND idempotency_key = $2
        `,
        [current.tenantId, idempotencyKey],
      );
      return result.rows[0]?.count;
    });
    expect(count).toBe("0");
  });

  it("fails closed when the admission connection has no Tenant context", async () => {
    const client = await must(pools).admission.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE dhumi_admission");
      expect((await client.query("SELECT id FROM app.services")).rows).toEqual([]);
      await expect(
        client.query(
          `
            INSERT INTO app.idempotency_records (
              tenant_id, scope_kind, actor_fingerprint, operation_code,
              idempotency_key, request_hash, state, expires_at
            ) VALUES (
              $1, 'tenant', $2, 'services.create', $3, $4, 'in_progress',
              clock_timestamp() + interval '24 hours'
            )
          `,
          [randomUUID(), Buffer.alloc(32), `no-context-${randomUUID()}`, Buffer.alloc(32)],
        ),
      ).rejects.toThrow();
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
