import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import { createDatabasePools } from "../../src/services/database/pools.js";
import {
  withAdmissionTenantTransaction,
  withIdentityTransaction,
  withTenantTransaction,
} from "../../src/services/database/transactions.js";
import { createGetRunResultRepository } from "../../src/services/runQuery/getRunResultRepository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const config = enabled ? loadRuntimeConfig() : undefined;

if (enabled && config?.database.database !== "dhumi_test") {
  throw new Error("Amazon contract database tests may run only against dhumi_test");
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

async function tenantFixture(): Promise<string> {
  const nonce = randomUUID();
  return withIdentityTransaction(must(pools).identity, async (database) => {
    const result = await database.query<{ tenant_id: string }>(
      `
        SELECT tenant_id
        FROM app.create_signup($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
      `,
      [
        `amazon-contract-${nonce}@example.test`,
        "$argon2id$amazon-contract-fixture-not-a-real-password",
        `Amazon contract ${nonce.slice(0, 8)}`,
        JSON.stringify([
          {
            document_type: "terms",
            document_version: "amazon-contract-v1",
            document_hash_hex: sha256(`amazon-contract-legal-${nonce}`).toString("hex"),
            disclosure_version: "amazon-contract-v1",
            locale: "en",
          },
        ]),
        `amazon-contract-${nonce}`,
        sha256(`amazon-contract-request-${nonce}`),
        sha256(`amazon-contract-actor-${nonce}`),
        randomUUID(),
      ],
    );
    const tenantId = result.rows[0]?.tenant_id;
    if (tenantId === undefined) throw new Error("Could not create Amazon contract fixture");
    return tenantId;
  });
}

describe.skipIf(!enabled)("Amazon public-contract migrations against PostgreSQL", () => {
  it("exposes only the accepted catalogue schemas and presentation metadata", async () => {
    const tenantId = await tenantFixture();
    const customer = await withTenantTransaction(
      must(pools).customerApi,
      tenantId,
      async (database) => {
        const result = await database.query<{
          configuration_schema: boolean;
          presentation_metadata: boolean;
          output_schema: boolean;
          adapter_version_id: boolean;
        }>(`
          SELECT
            has_column_privilege(current_user, 'app.service_template_versions', 'configuration_schema', 'SELECT') AS configuration_schema,
            has_column_privilege(current_user, 'app.service_template_versions', 'presentation_metadata', 'SELECT') AS presentation_metadata,
            has_column_privilege(current_user, 'app.service_template_versions', 'output_schema', 'SELECT') AS output_schema,
            has_column_privilege(current_user, 'app.service_template_versions', 'adapter_version_id', 'SELECT') AS adapter_version_id
        `);
        return result.rows[0];
      },
    );
    const admission = await withAdmissionTenantTransaction(
      must(pools).admission,
      tenantId,
      async (database) => {
        const result = await database.query<{
          configuration_schema: boolean;
          presentation_metadata: boolean;
          input_schema: boolean;
        }>(`
          SELECT
            has_column_privilege(current_user, 'app.service_template_versions', 'configuration_schema', 'SELECT') AS configuration_schema,
            has_column_privilege(current_user, 'app.service_template_versions', 'presentation_metadata', 'SELECT') AS presentation_metadata,
            has_column_privilege(current_user, 'app.service_template_versions', 'input_schema', 'SELECT') AS input_schema
        `);
        return result.rows[0];
      },
    );

    expect(customer).toEqual({
      configuration_schema: true,
      presentation_metadata: true,
      output_schema: false,
      adapter_version_id: false,
    });
    expect(admission).toEqual({
      configuration_schema: true,
      presentation_metadata: false,
      input_schema: true,
    });
  });

  it("installs the service-filter indexes and the narrow result Artifact surface", async () => {
    const tenantId = await tenantFixture();
    const evidence = await withTenantTransaction(
      must(pools).customerApi,
      tenantId,
      async (database) => {
        const privileges = await database.query<{
          table_select: boolean;
          object_key: boolean;
          checksum: boolean;
          artifact_version: boolean;
          attempt_id: boolean;
          content_encoding: boolean;
          deleted_at: boolean;
        }>(`
          SELECT
            has_table_privilege(current_user, 'app.artifacts', 'SELECT') AS table_select,
            has_column_privilege(current_user, 'app.artifacts', 'object_key', 'SELECT') AS object_key,
            has_column_privilege(current_user, 'app.artifacts', 'checksum', 'SELECT') AS checksum,
            has_column_privilege(current_user, 'app.artifacts', 'artifact_version', 'SELECT') AS artifact_version,
            has_column_privilege(current_user, 'app.artifacts', 'attempt_id', 'SELECT') AS attempt_id,
            has_column_privilege(current_user, 'app.artifacts', 'content_encoding', 'SELECT') AS content_encoding,
            has_column_privilege(current_user, 'app.artifacts', 'deleted_at', 'SELECT') AS deleted_at
        `);
        const indexes = await database.query<{ indexname: string }>(`
          SELECT indexname
          FROM pg_indexes
          WHERE schemaname = 'app'
            AND indexname IN (
              'service_versions_by_tenant_service_id_id_idx',
              'runs_by_tenant_service_version_created_id_idx',
              'artifacts_validated_result_read_idx'
            )
          ORDER BY indexname
        `);
        const auditPrivileges = await database.query<{
          table_insert: boolean;
          tenant_id: boolean;
          actor_user_id: boolean;
          actor_api_key_id: boolean;
          target_id: boolean;
          safe_diff: boolean;
          reason: boolean;
        }>(`
          SELECT
            has_table_privilege(current_user, 'app.audit_events', 'INSERT') AS table_insert,
            has_column_privilege(current_user, 'app.audit_events', 'tenant_id', 'INSERT') AS tenant_id,
            has_column_privilege(current_user, 'app.audit_events', 'actor_user_id', 'INSERT') AS actor_user_id,
            has_column_privilege(current_user, 'app.audit_events', 'actor_api_key_id', 'INSERT') AS actor_api_key_id,
            has_column_privilege(current_user, 'app.audit_events', 'target_id', 'INSERT') AS target_id,
            has_column_privilege(current_user, 'app.audit_events', 'safe_diff', 'INSERT') AS safe_diff,
            has_column_privilege(current_user, 'app.audit_events', 'reason', 'INSERT') AS reason
        `);
        return {
          privileges: privileges.rows[0],
          indexes: indexes.rows,
          auditPrivileges: auditPrivileges.rows[0],
        };
      },
    );

    expect(evidence.privileges).toEqual({
      table_select: false,
      object_key: true,
      checksum: true,
      artifact_version: true,
      attempt_id: false,
      content_encoding: false,
      deleted_at: false,
    });
    expect(evidence.indexes.map((row) => row.indexname)).toEqual([
      "artifacts_validated_result_read_idx",
      "runs_by_tenant_service_version_created_id_idx",
      "service_versions_by_tenant_service_id_id_idx",
    ]);
    expect(evidence.auditPrivileges).toEqual({
      table_insert: false,
      tenant_id: true,
      actor_user_id: true,
      actor_api_key_id: true,
      target_id: true,
      safe_diff: true,
      reason: false,
    });
  });

  it("keeps absent and cross-Tenant results invisible under forced RLS", async () => {
    const firstTenant = await tenantFixture();
    const secondTenant = await tenantFixture();
    const repository = createGetRunResultRepository(must(pools).customerApi);
    const unknownRunId = randomUUID();

    await expect(
      repository.findResult({
        tenantId: firstTenant,
        runId: unknownRunId,
        representation: "normalized",
      }),
    ).resolves.toEqual({ kind: "not_found" });
    await expect(
      repository.findResult({
        tenantId: secondTenant,
        runId: unknownRunId,
        representation: "normalized",
      }),
    ).resolves.toEqual({ kind: "not_found" });
  });
});
