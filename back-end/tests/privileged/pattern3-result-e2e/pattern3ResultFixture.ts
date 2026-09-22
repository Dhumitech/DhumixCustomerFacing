import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { BlobServiceClient } from "@azure/storage-blob";
import { Pool, type PoolClient } from "pg";
import {
  loadResultRecorderConfig,
  type RuntimeConfig,
} from "../../../src/config/environment.js";
import { createPasswordHasher } from "../../../src/helpers/password.js";
import { createResultRecorderPool } from "../../../src/services/database/pools.js";
import { verifyResultRecorderPool } from "../../../src/services/database/roleVerification.js";
import { createResultArtifactFinalizerRepository } from "../../../src/services/storage/resultArtifactFinalizerRepository.js";
import { createResultIngestionService } from "../../../src/services/storage/resultIngestionService.js";
import { createConfiguredResultObjectStore } from "../../../src/services/storage/resultStorageComposition.js";

export const PATTERN3_FIXTURE_VERSION = 2 as const;

export interface Pattern3FixtureIdentity {
  readonly email: string;
  readonly password: string;
  readonly userId: string;
  readonly tenantId: string;
}

export interface Pattern3FixtureIds {
  readonly templateEvidenceId: string;
  readonly mappingEvidenceId: string;
  readonly featureEvidenceId: string;
  readonly featureFlagId: string;
  readonly adapterDefinitionId: string;
  readonly adapterVersionId: string;
  readonly templateId: string;
  readonly templateVersionId: string;
  readonly providerCredentialId: string;
  readonly providerMappingId: string;
  readonly serviceId: string;
  readonly serviceVersionId: string;
  readonly runId: string;
  readonly attemptId: string;
}

export interface Pattern3FixtureManifest {
  readonly version: typeof PATTERN3_FIXTURE_VERSION;
  readonly createdAt: string;
  readonly databaseName: "dhumi_test";
  readonly baseUrl: string;
  readonly owner: Pattern3FixtureIdentity;
  readonly otherTenant: Pattern3FixtureIdentity;
  readonly ids: Pattern3FixtureIds;
  readonly result: {
    readonly artifactId: string;
    readonly objectKey: string;
    readonly contentType: "application/json";
    readonly expectedBody: string;
    readonly byteCount: number;
    readonly checksumHex: string;
  };
  readonly rawResult: {
    readonly artifactId: string;
    readonly objectKey: string;
    readonly contentType: "application/json";
    readonly expectedBody: string;
    readonly byteCount: number;
    readonly checksumHex: string;
  };
}

export interface Pattern3Inspection {
  readonly artifact: {
    readonly id: string;
    readonly objectKey: string;
    readonly state: string;
    readonly byteCount: number;
    readonly checksumHex: string;
  };
  readonly object: {
    readonly byteCount: number;
    readonly checksumHex: string;
    readonly exactBytes: boolean;
  };
  readonly downloadAuthorizationAudits: number;
}

function sha256(value: string | Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

function createIds(): Pattern3FixtureIds {
  return {
    templateEvidenceId: randomUUID(),
    mappingEvidenceId: randomUUID(),
    featureEvidenceId: randomUUID(),
    featureFlagId: randomUUID(),
    adapterDefinitionId: randomUUID(),
    adapterVersionId: randomUUID(),
    templateId: randomUUID(),
    templateVersionId: randomUUID(),
    providerCredentialId: randomUUID(),
    providerMappingId: randomUUID(),
    serviceId: randomUUID(),
    serviceVersionId: randomUUID(),
    runId: randomUUID(),
    attemptId: randomUUID(),
  };
}

function fixtureIdentity(prefix: string): Pattern3FixtureIdentity {
  const nonce = randomUUID();
  return {
    email: `${prefix}-${nonce}@example.test`,
    password: `P3-${nonce}-aA1!`,
    userId: randomUUID(),
    tenantId: randomUUID(),
  };
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

export async function verifyPrivilegedFixturePool(pool: Pool): Promise<void> {
  const identity = await pool.query<{
    readonly current_database: string;
    readonly rolsuper: boolean;
  }>(
    `
      SELECT current_database(), rolsuper
      FROM pg_roles
      WHERE rolname = current_user
    `,
  );
  const row = identity.rows[0];
  if (row?.current_database !== "dhumi_test" || row.rolsuper !== true) {
    throw new Error("Pattern 3 fixture may run only as a superuser against dhumi_test");
  }
}

async function seedDatabase(
  pool: Pool,
  config: RuntimeConfig,
  owner: Pattern3FixtureIdentity,
  otherTenant: Pattern3FixtureIdentity,
  ids: Pattern3FixtureIds,
): Promise<void> {
  const passwordHasher = createPasswordHasher(config.passwordHash);
  const [ownerHash, otherHash] = await Promise.all([
    passwordHasher.hash(owner.password),
    passwordHasher.hash(otherTenant.password),
  ]);
  const suffix = ids.runId.replaceAll("-", "").slice(0, 16);
  const emptySchema = JSON.stringify({
    type: "object",
    additionalProperties: false,
    properties: {},
  });

  await inTransaction(pool, async (database) => {
    await database.query("SET CONSTRAINTS ALL DEFERRED");
    await database.query(
      `
        INSERT INTO app.users (id, email_normalized, password_hash)
        VALUES ($1, $2, $3), ($4, $5, $6)
      `,
      [
        owner.userId,
        owner.email,
        ownerHash,
        otherTenant.userId,
        otherTenant.email,
        otherHash,
      ],
    );
    await database.query(
      `
        INSERT INTO app.tenants (id, display_name)
        VALUES ($1, 'Pattern 3 owner fixture'), ($2, 'Pattern 3 isolation fixture')
      `,
      [owner.tenantId, otherTenant.tenantId],
    );
    await database.query(
      `
        INSERT INTO app.tenant_user_access (tenant_id, user_id)
        VALUES ($1, $2), ($3, $4)
      `,
      [owner.tenantId, owner.userId, otherTenant.tenantId, otherTenant.userId],
    );
    await database.query(
      `
        INSERT INTO app.launch_evidence (
          id, evidence_code, scope_type, scope_key, state, restricted_reference,
          effective_at, approved_by, approved_at
        ) VALUES
          ($1, $2, 'template', $3, 'approved', 'restricted:pattern3-template',
            clock_timestamp() - interval '1 hour', 'pattern3-fixture',
            clock_timestamp() - interval '1 hour'),
          ($4, $5, 'mapping', $6, 'approved', 'restricted:pattern3-mapping',
            clock_timestamp() - interval '1 hour', 'pattern3-fixture',
            clock_timestamp() - interval '1 hour'),
          ($7, $8, 'feature', $9, 'approved', 'restricted:pattern3-feature',
            clock_timestamp() - interval '1 hour', 'pattern3-fixture',
            clock_timestamp() - interval '1 hour')
      `,
      [
        ids.templateEvidenceId,
        `pattern3-template-${suffix}`,
        ids.templateVersionId,
        ids.mappingEvidenceId,
        `pattern3-mapping-${suffix}`,
        ids.providerMappingId,
        ids.featureEvidenceId,
        `pattern3-feature-${suffix}`,
        ids.featureFlagId,
      ],
    );
    await database.query(
      `
        INSERT INTO app.feature_flags (
          id, feature_code, environment, state, launch_evidence_id,
          changed_by, changed_reason
        ) VALUES ($1, $2, 'test', 'enabled', $3, 'pattern3-fixture',
          'Pattern 3 local result boundary verification')
      `,
      [ids.featureFlagId, "scraper_library", ids.featureEvidenceId],
    );
    await database.query(
      `
        INSERT INTO app.adapter_definitions (id, code, product_family)
        VALUES ($1, $2, 'scraper_library')
      `,
      [ids.adapterDefinitionId, `pattern3-result-${suffix}`],
    );
    await database.query(
      `
        INSERT INTO app.adapter_versions (
          id, adapter_definition_id, semantic_version, capability_metadata,
          request_schema, result_schema, error_schema, code_artifact_digest, state
        ) VALUES (
          $1, $2, '1.0.0', '{"execution_mode":"test_fixture"}'::jsonb,
          $3::jsonb, $3::jsonb, $3::jsonb, $4, 'enabled'
        )
      `,
      [ids.adapterVersionId, ids.adapterDefinitionId, emptySchema, sha256("pattern3-result-fixture")],
    );
    await database.query(
      `
        INSERT INTO app.service_templates (id, slug, product_family, state)
        VALUES ($1, $2, 'scraper_library', 'draft')
      `,
      [ids.templateId, `pattern3-result-${suffix}`],
    );
    await database.query(
      `
        INSERT INTO app.service_template_versions (
          id, service_template_id, version, public_name, public_description,
          input_schema, configuration_schema, presentation_metadata,
          output_schema, availability_copy, availability_state,
          adapter_version_id, launch_evidence_id, effective_at
        ) VALUES (
          $1, $2, 1, 'Pattern 3 result fixture',
          'Private fixture for the local result boundary E2E test',
          $3::jsonb, $3::jsonb,
          '{"domain_slug":"test","domain_name":"Test","category":"test","icon_key":"test","operation_group":"Test","operation_name":"Pattern 3 result","display_priority":999}'::jsonb,
          $3::jsonb, 'Fixture only', 'coming_soon', $4, $5,
          clock_timestamp() - interval '1 hour'
        )
      `,
      [
        ids.templateVersionId,
        ids.templateId,
        emptySchema,
        ids.adapterVersionId,
        ids.templateEvidenceId,
      ],
    );
    await database.query(
      `
        INSERT INTO app.provider_credentials (
          id, provider_code, environment, vault_secret_reference,
          permission_label, state, activated_at
        ) VALUES (
          $1, 'bright_data', 'test', $2, 'test-fixture-no-provider-call',
          'active', clock_timestamp() - interval '1 hour'
        )
      `,
      [ids.providerCredentialId, `vault://pattern3-fixture/${suffix}`],
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
          $1, $2, $3, $4, 'test', 'test.pattern3.result',
          convert_to('no-provider-call', 'UTF8'), $5, '{}'::jsonb,
          'test-v1', 'test-v1', $6, 'enabled'
        )
      `,
      [
        ids.providerMappingId,
        ids.templateVersionId,
        ids.adapterVersionId,
        ids.providerCredentialId,
        sha256("pattern3-result-mapping"),
        ids.mappingEvidenceId,
      ],
    );
    await database.query(
      `
        INSERT INTO app.services (
          id, tenant_id, service_template_id, name, state, current_version
        ) VALUES ($1, $2, $3, $4, 'active', 1)
      `,
      [ids.serviceId, owner.tenantId, ids.templateId, `Pattern 3 fixture ${suffix}`],
    );
    await database.query(
      `
        INSERT INTO app.service_versions (
          id, tenant_id, service_id, version, service_template_version_id,
          validated_configuration, schema_hash, created_by_user_id
        ) VALUES ($1, $2, $3, 1, $4, '{}'::jsonb, $5, $6)
      `,
      [
        ids.serviceVersionId,
        owner.tenantId,
        ids.serviceId,
        ids.templateVersionId,
        sha256("pattern3-service-schema"),
        owner.userId,
      ],
    );
    await database.query(
      `
        INSERT INTO app.runs (
          id, tenant_id, service_version_id, service_template_version_id,
          adapter_version_id, provider_mapping_id, commercial_config_version,
          public_status, internal_status, state_version, retryable,
          validated_input, template_launch_evidence_id,
          mapping_launch_evidence_id, feature_flag_id,
          feature_launch_evidence_id, started_at, completed_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, 'test-v1', 'ready', 'COMPLETED', 3,
          false, '{}'::jsonb, $7, $8, $9, $10,
          clock_timestamp() - interval '2 minutes',
          clock_timestamp() - interval '1 minute'
        )
      `,
      [
        ids.runId,
        owner.tenantId,
        ids.serviceVersionId,
        ids.templateVersionId,
        ids.adapterVersionId,
        ids.providerMappingId,
        ids.templateEvidenceId,
        ids.mappingEvidenceId,
        ids.featureFlagId,
        ids.featureEvidenceId,
      ],
    );
    await database.query(
      `
        INSERT INTO app.run_attempts (
          id, tenant_id, run_id, attempt_number, kind, state,
          outcome_class, adapter_version_id, provider_mapping_id,
          provider_credential_id, finished_at
        ) VALUES (
          $1, $2, $3, 1, 'download', 'completed', 'synthetic_fixture',
          $4, $5, $6, clock_timestamp() - interval '1 minute'
        )
      `,
      [
        ids.attemptId,
        owner.tenantId,
        ids.runId,
        ids.adapterVersionId,
        ids.providerMappingId,
        ids.providerCredentialId,
      ],
    );
    await database.query("SET CONSTRAINTS ALL IMMEDIATE");
  });
}

export async function preparePattern3Fixture(
  privilegedPool: Pool,
  config: RuntimeConfig,
  baseUrl: string,
): Promise<Pattern3FixtureManifest> {
  if (config.database.database !== "dhumi_test" || config.nodeEnv !== "test") {
    throw new Error("Pattern 3 fixture requires NODE_ENV=test and DATABASE_NAME=dhumi_test");
  }
  if (config.resultStorage.driver !== "azurite") {
    throw new Error("Pattern 3 fixture requires RESULT_STORAGE_DRIVER=azurite");
  }
  const resultRecorderConfig = loadResultRecorderConfig();
  const resultStorage = resultRecorderConfig.resultStorage;
  if (
    resultStorage.containerName !== config.resultStorage.containerName ||
    resultStorage.connectionString !== config.resultStorage.connectionString
  ) {
    throw new Error("API and result-recorder storage configuration must match");
  }
  await verifyPrivilegedFixturePool(privilegedPool);

  const ids = createIds();
  const owner = fixtureIdentity("pattern3-owner");
  const otherTenant = fixtureIdentity("pattern3-other");
  await seedDatabase(privilegedPool, config, owner, otherTenant, ids);

  const resultRecorder = createResultRecorderPool(resultRecorderConfig.database, () => undefined);
  try {
    await verifyResultRecorderPool(
      resultRecorder,
      resultRecorderConfig.database.credential.user,
    );
    const expectedBody = `${JSON.stringify({
      fixture: "pattern3-postman-e2e",
      run_id: ids.runId,
      exact_bytes: true,
    })}\n`;
    const rawExpectedBody = `${JSON.stringify({
      provider_fixture: "pattern3-postman-e2e",
      run_id: ids.runId,
      original_provider_bytes: true,
    })}\n`;
    const bytes = Buffer.from(expectedBody, "utf8");
    const rawBytes = Buffer.from(rawExpectedBody, "utf8");
    const store = await createConfiguredResultObjectStore(resultStorage);
    const ingestion = createResultIngestionService({
      store,
      finalizer: createResultArtifactFinalizerRepository(resultRecorder),
      maxBytes: resultStorage.maxBytes,
    });
    const rawIngested = await ingestion.ingest({
      identity: {
        tenantId: owner.tenantId,
        runId: ids.runId,
        attemptId: ids.attemptId,
        kind: "raw",
        artifactVersion: 1,
      },
      bytes: Readable.from([
        rawBytes.subarray(0, Math.min(13, rawBytes.byteLength)),
        rawBytes.subarray(Math.min(13, rawBytes.byteLength)),
      ]),
      contentType: "application/json",
      contentEncoding: null,
      schemaVersion: null,
      recordCount: null,
      expiresAt: null,
    });
    const normalizedIngested = await ingestion.ingest({
      identity: {
        tenantId: owner.tenantId,
        runId: ids.runId,
        attemptId: ids.attemptId,
        kind: "normalized",
        artifactVersion: 1,
      },
      bytes: Readable.from([
        bytes.subarray(0, Math.min(11, bytes.byteLength)),
        bytes.subarray(Math.min(11, bytes.byteLength)),
      ]),
      contentType: "application/json",
      contentEncoding: null,
      schemaVersion: "pattern3-fixture-v1",
      recordCount: 0,
      expiresAt: null,
    });

    return {
      version: PATTERN3_FIXTURE_VERSION,
      createdAt: new Date().toISOString(),
      databaseName: "dhumi_test",
      baseUrl: baseUrl.replace(/\/$/, ""),
      owner,
      otherTenant,
      ids,
      result: {
        artifactId: normalizedIngested.artifactId,
        objectKey: normalizedIngested.receipt.objectKey,
        contentType: "application/json",
        expectedBody,
        byteCount: bytes.byteLength,
        checksumHex: normalizedIngested.receipt.checksumHex,
      },
      rawResult: {
        artifactId: rawIngested.artifactId,
        objectKey: rawIngested.receipt.objectKey,
        contentType: "application/json",
        expectedBody: rawExpectedBody,
        byteCount: rawBytes.byteLength,
        checksumHex: rawIngested.receipt.checksumHex,
      },
    };
  } catch (error) {
    await cleanupPattern3Fixture(privilegedPool, config, {
      version: PATTERN3_FIXTURE_VERSION,
      createdAt: new Date().toISOString(),
      databaseName: "dhumi_test",
      baseUrl,
      owner,
      otherTenant,
      ids,
      result: {
        artifactId: randomUUID(),
        objectKey: `tenants/${owner.tenantId}/runs/${ids.runId}/attempts/${ids.attemptId}/normalized/v1/result`,
        contentType: "application/json",
        expectedBody: "",
        byteCount: 0,
        checksumHex: sha256("").toString("hex"),
      },
      rawResult: {
        artifactId: randomUUID(),
        objectKey: `tenants/${owner.tenantId}/runs/${ids.runId}/attempts/${ids.attemptId}/raw/v1/result`,
        contentType: "application/json",
        expectedBody: "",
        byteCount: 0,
        checksumHex: sha256("").toString("hex"),
      },
    }).catch(() => undefined);
    throw error;
  } finally {
    await resultRecorder.end();
  }
}

export async function inspectPattern3Fixture(
  privilegedPool: Pool,
  config: RuntimeConfig,
  manifest: Pattern3FixtureManifest,
  representation: "normalized" | "raw" = "normalized",
): Promise<Pattern3Inspection> {
  await verifyPrivilegedFixturePool(privilegedPool);
  const expected = representation === "raw" ? manifest.rawResult : manifest.result;
  const artifactResult = await privilegedPool.query<{
    readonly id: string;
    readonly object_key: string;
    readonly state: string;
    readonly byte_count: string;
    readonly checksum_hex: string;
  }>(
    `
      SELECT id, object_key, state, byte_count::text,
             encode(checksum, 'hex') AS checksum_hex
      FROM app.artifacts
      WHERE id = $1 AND tenant_id = $2 AND run_id = $3
    `,
    [expected.artifactId, manifest.owner.tenantId, manifest.ids.runId],
  );
  const artifact = artifactResult.rows[0];
  if (artifact === undefined) throw new Error("Pattern 3 Artifact is missing");

  if (config.resultStorage.connectionString === null) {
    throw new Error("Azurite connection string is unavailable");
  }
  const blob = BlobServiceClient.fromConnectionString(config.resultStorage.connectionString)
    .getContainerClient(config.resultStorage.containerName)
    .getBlobClient(expected.objectKey);
  const [properties, downloaded, auditResult] = await Promise.all([
    blob.getProperties(),
    blob.downloadToBuffer(),
    privilegedPool.query<{ readonly count: string }>(
      `
        SELECT count(*)::text AS count
        FROM app.audit_events
        WHERE tenant_id = $1
          AND action = 'artifacts.download_authorize'
          AND target_type = 'artifact'
          AND target_id = $2
          AND outcome = 'authorized'
          AND safe_diff ->> 'representation' = $3
      `,
      [manifest.owner.tenantId, expected.artifactId, representation],
    ),
  ]);
  const objectChecksumHex = sha256(downloaded).toString("hex");
  const inspection: Pattern3Inspection = {
    artifact: {
      id: artifact.id,
      objectKey: artifact.object_key,
      state: artifact.state,
      byteCount: Number(artifact.byte_count),
      checksumHex: artifact.checksum_hex,
    },
    object: {
      byteCount: downloaded.byteLength,
      checksumHex: objectChecksumHex,
      exactBytes: downloaded.equals(Buffer.from(expected.expectedBody, "utf8")),
    },
    downloadAuthorizationAudits: Number(auditResult.rows[0]?.count ?? "0"),
  };

  if (
    inspection.artifact.id !== expected.artifactId ||
    inspection.artifact.objectKey !== expected.objectKey ||
    inspection.artifact.state !==
      (representation === "normalized" ? "validated" : "durable") ||
    inspection.artifact.byteCount !== expected.byteCount ||
    inspection.artifact.checksumHex !== expected.checksumHex ||
    properties.contentLength !== expected.byteCount ||
    properties.metadata?.dhumi_sha256 !== expected.checksumHex ||
    inspection.object.byteCount !== expected.byteCount ||
    inspection.object.checksumHex !== expected.checksumHex ||
    !inspection.object.exactBytes
  ) {
    throw new Error("Pattern 3 database, object, checksum, or byte evidence did not match");
  }
  return inspection;
}

export async function cleanupPattern3Fixture(
  privilegedPool: Pool,
  config: RuntimeConfig,
  manifest: Pattern3FixtureManifest,
): Promise<void> {
  await verifyPrivilegedFixturePool(privilegedPool);
  if (config.resultStorage.connectionString !== null) {
    const container = BlobServiceClient.fromConnectionString(
      config.resultStorage.connectionString,
    ).getContainerClient(config.resultStorage.containerName);
    await Promise.all(
      [manifest.result.objectKey, manifest.rawResult.objectKey].map((objectKey) =>
        container
          .deleteBlob(objectKey, { deleteSnapshots: "include" })
          .catch((error: unknown) => {
            const statusCode =
              typeof error === "object" && error !== null && "statusCode" in error
                ? (error as { readonly statusCode?: unknown }).statusCode
                : undefined;
            if (statusCode !== 404) throw error;
          }),
      ),
    );
  }

  await inTransaction(privilegedPool, async (database) => {
    await database.query("SET LOCAL session_replication_role = replica");
    await database.query(
      `DELETE FROM app.auth_refresh_tokens
       WHERE session_id IN (SELECT id FROM app.auth_sessions WHERE user_id = ANY($1::uuid[]))`,
      [[manifest.owner.userId, manifest.otherTenant.userId]],
    );
    await database.query(
      "DELETE FROM app.auth_sessions WHERE user_id = ANY($1::uuid[])",
      [[manifest.owner.userId, manifest.otherTenant.userId]],
    );
    await database.query(
      "DELETE FROM app.audit_events WHERE tenant_id = ANY($1::uuid[]) OR actor_user_id = ANY($2::uuid[])",
      [
        [manifest.owner.tenantId, manifest.otherTenant.tenantId],
        [manifest.owner.userId, manifest.otherTenant.userId],
      ],
    );
    await database.query(
      "DELETE FROM app.artifacts WHERE tenant_id = $1 AND run_id = $2",
      [manifest.owner.tenantId, manifest.ids.runId],
    );
    await database.query("DELETE FROM app.run_events WHERE run_id = $1", [manifest.ids.runId]);
    await database.query("DELETE FROM app.usage_events WHERE run_id = $1", [manifest.ids.runId]);
    await database.query("DELETE FROM app.run_attempts WHERE id = $1", [manifest.ids.attemptId]);
    await database.query("DELETE FROM app.provider_cost_holds WHERE run_id = $1", [manifest.ids.runId]);
    await database.query("DELETE FROM app.outbox_events WHERE aggregate_id = $1", [manifest.ids.runId]);
    await database.query("DELETE FROM app.idempotency_records WHERE tenant_id = $1", [manifest.owner.tenantId]);
    await database.query("DELETE FROM app.runs WHERE id = $1", [manifest.ids.runId]);
    await database.query("DELETE FROM app.service_versions WHERE id = $1", [manifest.ids.serviceVersionId]);
    await database.query("DELETE FROM app.services WHERE id = $1", [manifest.ids.serviceId]);
    await database.query("DELETE FROM app.provider_mappings WHERE id = $1", [manifest.ids.providerMappingId]);
    await database.query("DELETE FROM app.provider_credentials WHERE id = $1", [manifest.ids.providerCredentialId]);
    await database.query("DELETE FROM app.service_template_versions WHERE id = $1", [manifest.ids.templateVersionId]);
    await database.query("DELETE FROM app.service_templates WHERE id = $1", [manifest.ids.templateId]);
    await database.query("DELETE FROM app.adapter_versions WHERE id = $1", [manifest.ids.adapterVersionId]);
    await database.query("DELETE FROM app.adapter_definitions WHERE id = $1", [manifest.ids.adapterDefinitionId]);
    await database.query("DELETE FROM app.feature_flags WHERE id = $1", [manifest.ids.featureFlagId]);
    await database.query(
      "DELETE FROM app.launch_evidence WHERE id = ANY($1::uuid[])",
      [[
        manifest.ids.templateEvidenceId,
        manifest.ids.mappingEvidenceId,
        manifest.ids.featureEvidenceId,
      ]],
    );
    await database.query(
      "DELETE FROM app.tenant_user_access WHERE tenant_id = ANY($1::uuid[])",
      [[manifest.owner.tenantId, manifest.otherTenant.tenantId]],
    );
    await database.query(
      "DELETE FROM app.tenants WHERE id = ANY($1::uuid[])",
      [[manifest.owner.tenantId, manifest.otherTenant.tenantId]],
    );
    await database.query(
      "DELETE FROM app.users WHERE id = ANY($1::uuid[])",
      [[manifest.owner.userId, manifest.otherTenant.userId]],
    );
  });
}
