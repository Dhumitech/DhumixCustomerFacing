import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  loadEnvelopeJanitorConfig,
  loadRuntimeConfig,
} from "../../src/config/environment.js";
import { createLocalResponseEnvelope } from "../../src/helpers/responseEnvelope.js";
import {
  createDatabasePools,
  createEnvelopeJanitorPool,
} from "../../src/services/database/pools.js";
import {
  withIdentityTransaction,
  withTenantTransaction,
} from "../../src/services/database/transactions.js";
import { createEnvelopeJanitorRepository } from "../../src/services/envelopeJanitor/envelopeJanitorRepository.js";
import { createApiKeyRepository } from "../../src/services/apiKeys/createApiKeyRepository.js";
import { createApiKeyService } from "../../src/services/apiKeys/createApiKeyService.js";
import { createCsrfService } from "../../src/helpers/csrf.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const janitorEnabled =
  enabled &&
  typeof process.env.DATABASE_ENVELOPE_JANITOR_USER === "string" &&
  typeof process.env.DATABASE_ENVELOPE_JANITOR_PASSWORD === "string";
const config = enabled ? loadRuntimeConfig() : undefined;
const janitorConfig = janitorEnabled ? loadEnvelopeJanitorConfig() : undefined;

if (
  enabled &&
  (config?.database.database !== "dhumi_test" ||
    (janitorEnabled && janitorConfig?.database.database !== "dhumi_test"))
) {
  throw new Error("Create-API-key database tests may run only against dhumi_test");
}

const pools = enabled && config ? createDatabasePools(config.database, () => {}) : undefined;
const janitorPool =
  enabled && janitorConfig ? createEnvelopeJanitorPool(janitorConfig.database, () => {}) : undefined;

afterAll(async () => {
  await Promise.all([pools?.close(), janitorPool?.end()]);
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
  readonly sessionId: string;
}

interface SignupRow {
  readonly user_id: string | null;
  readonly tenant_id: string | null;
}

async function fixture(label: string): Promise<Fixture> {
  const nonce = randomUUID();
  const row = await withIdentityTransaction(must(pools).identity, async (database) => {
    const result = await database.query<SignupRow>(
      `
        SELECT user_id, tenant_id
        FROM app.create_signup($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
      `,
      [
        `api-key-int-${nonce}@example.test`,
        "$argon2id$api-key-integration-fixture-not-a-real-password",
        `API key ${label} ${nonce.slice(0, 8)}`,
        JSON.stringify([
          {
            document_type: "terms",
            document_version: "api-key-int-v1",
            document_hash_hex: sha256(`api-key-legal-${nonce}`).toString("hex"),
            disclosure_version: "api-key-int-v1",
            locale: "en",
          },
        ]),
        `api-key-int-${nonce}`,
        sha256(`api-key-request-${nonce}`),
        sha256(`api-key-actor-${nonce}`),
        randomUUID(),
      ],
    );
    return result.rows[0];
  });
  if (row?.user_id === null || row?.user_id === undefined || row.tenant_id === null || row.tenant_id === undefined) {
    throw new Error("Could not establish an API-key database fixture");
  }
  return { userId: row.user_id, tenantId: row.tenant_id, sessionId: randomUUID() };
}

function service() {
  const currentConfig = must(config);
  return createApiKeyService({
    repository: createApiKeyRepository(must(pools).customerApi),
    csrf: createCsrfService(currentConfig.session.accessToken.secret),
    responseEnvelope: createLocalResponseEnvelope(
      currentConfig.nodeEnv,
      currentConfig.responseEnvelope.localKeyBase64Url,
    ),
  });
}

function createRequest(fixtureValue: Fixture, idempotencyKey: string, name = "Integration key") {
  const csrf = createCsrfService(must(config).session.accessToken.secret);
  return {
    identity: {
      userId: fixtureValue.userId,
      sessionId: fixtureValue.sessionId,
      tenantId: fixtureValue.tenantId,
    },
    csrfToken: csrf.issue(fixtureValue.sessionId),
    idempotencyKey,
    body: { name, scopes: ["runs:write", "runs:read"] },
    schemaErrors: [],
    requestId: randomUUID(),
    ipFingerprint: null,
  } as const;
}

async function tenantEvidence(tenantId: string, idempotencyKey: string) {
  return withTenantTransaction(must(pools).customerApi, tenantId, async (database) => {
    const keys = await database.query<{
      id: string;
      key_prefix: string;
      state: string;
    }>(
      `
        SELECT id, key_prefix, state
        FROM app.platform_api_keys
        WHERE tenant_id = $1
      `,
      [tenantId],
    );
    const claims = await database.query<{
      id: string;
      state: string;
      resource_id: string | null;
      has_ciphertext: boolean;
      response_envelope_key_reference: string | null;
      response_envelope_destroyed_at: Date | null;
    }>(
      `
        SELECT
          id,
          state,
          resource_id,
          response_envelope_ciphertext IS NOT NULL AS has_ciphertext,
          response_envelope_key_reference,
          response_envelope_destroyed_at
        FROM app.idempotency_records
        WHERE tenant_id = $1
          AND operation_code = 'api_keys.create'
          AND idempotency_key = $2
      `,
      [tenantId, idempotencyKey],
    );
    return { keys: keys.rows, claims: claims.rows };
  });
}

async function auditEvidence(apiKeyId: string) {
  return withIdentityTransaction(must(pools).identity, async (database) => {
    const result = await database.query<Record<string, unknown>>(
      `
        SELECT tenant_id, actor_user_id, action, target_type, target_id, outcome, safe_diff
        FROM app.audit_events
        WHERE target_id = $1
          AND action = 'api_keys.create'
      `,
      [apiKeyId],
    );
    return result.rows;
  });
}

describe.skipIf(!enabled)("create API key against PostgreSQL", () => {
  it("creates one key/audit and returns an exact encrypted replay without plaintext persistence", async () => {
    const current = await fixture("happy");
    const idempotencyKey = `api-key-create-${randomUUID()}`;
    const request = createRequest(current, idempotencyKey);
    const first = await service().create(request);
    const replay = await service().create(request);

    expect(replay).toEqual(first);
    const evidence = await tenantEvidence(current.tenantId, idempotencyKey);
    expect(evidence.keys).toHaveLength(1);
    expect(evidence.keys[0]).toMatchObject({
      id: first.id,
      key_prefix: first.prefix,
      state: "active",
    });
    expect(evidence.claims).toMatchObject([
      { state: "completed", resource_id: first.id, has_ciphertext: true },
    ]);
    const audits = await auditEvidence(first.id);
    expect(audits).toMatchObject([
      {
        tenant_id: current.tenantId,
        actor_user_id: current.userId,
        action: "api_keys.create",
        target_type: "platform_api_key",
        outcome: "created",
      },
    ]);
    expect(JSON.stringify({ evidence, audits })).not.toContain(first.secret);
  });

  it("serializes concurrent identical requests into one key and one audit", async () => {
    const current = await fixture("race");
    const idempotencyKey = `api-key-race-${randomUUID()}`;
    const request = createRequest(current, idempotencyKey);
    const [first, second] = await Promise.all([service().create(request), service().create(request)]);

    expect(second).toEqual(first);
    expect((await tenantEvidence(current.tenantId, idempotencyKey)).keys).toHaveLength(1);
    expect(await auditEvidence(first.id)).toHaveLength(1);
  });

  it("permanently rejects a changed request and never creates a second credential", async () => {
    const current = await fixture("conflict");
    const idempotencyKey = `api-key-conflict-${randomUUID()}`;
    await service().create(createRequest(current, idempotencyKey, "Original"));
    await expect(
      service().create(createRequest(current, idempotencyKey, "Changed")),
    ).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    expect((await tenantEvidence(current.tenantId, idempotencyKey)).keys).toHaveLength(1);
  });

  it("scopes the same caller key independently per Tenant without cross-Tenant visibility", async () => {
    const tenantA = await fixture("tenant-a");
    const tenantB = await fixture("tenant-b");
    const idempotencyKey = `api-key-tenant-scope-${randomUUID()}`;
    const [keyA, keyB] = await Promise.all([
      service().create(createRequest(tenantA, idempotencyKey)),
      service().create(createRequest(tenantB, idempotencyKey)),
    ]);

    expect(keyA.id).not.toBe(keyB.id);
    const evidenceA = await tenantEvidence(tenantA.tenantId, idempotencyKey);
    const evidenceB = await tenantEvidence(tenantB.tenantId, idempotencyKey);
    expect(evidenceA.keys.map((key) => key.id)).toContain(keyA.id);
    expect(evidenceA.keys.map((key) => key.id)).not.toContain(keyB.id);
    expect(evidenceB.keys.map((key) => key.id)).toContain(keyB.id);
    expect(evidenceB.keys.map((key) => key.id)).not.toContain(keyA.id);
  });

  it.skipIf(!janitorEnabled)("destroys a due envelope through the janitor role and keeps an expired tombstone", async () => {
    const current = await fixture("destroyed");
    const idempotencyKey = `api-key-destroyed-${randomUUID()}`;
    const request = createRequest(current, idempotencyKey);
    await service().create(request);

    await withTenantTransaction(must(pools).customerApi, current.tenantId, async (database) => {
      await database.query(
        `
          UPDATE app.idempotency_records
          SET response_envelope_recoverable_until = completed_at + interval '1 millisecond'
          WHERE tenant_id = $1
            AND operation_code = 'api_keys.create'
            AND idempotency_key = $2
        `,
        [current.tenantId, idempotencyKey],
      );
    });
    await createEnvelopeJanitorRepository(must(janitorPool)).destroyDue(100);

    await expect(service().create(request)).rejects.toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_REPLAY_EXPIRED",
    });
    const evidence = await tenantEvidence(current.tenantId, idempotencyKey);
    expect(evidence.keys).toHaveLength(1);
    expect(evidence.claims).toMatchObject([
      {
        state: "completed",
        has_ciphertext: false,
        response_envelope_key_reference: null,
        response_envelope_destroyed_at: expect.any(Date),
      },
    ]);
  });
});
