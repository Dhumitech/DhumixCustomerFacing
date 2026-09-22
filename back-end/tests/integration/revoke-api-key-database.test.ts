import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import { createDatabasePools } from "../../src/services/database/pools.js";
import {
  withIdentityTransaction,
  withTenantTransaction,
} from "../../src/services/database/transactions.js";
import {
  createRevokeApiKeyRepository,
  type RevokeApiKeyRepository,
} from "../../src/services/apiKeys/revokeApiKeyRepository.js";
import { createListApiKeysRepository } from "../../src/services/apiKeys/listApiKeysRepository.js";
import { createListApiKeysService } from "../../src/services/apiKeys/listApiKeysService.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const config = enabled ? loadRuntimeConfig() : undefined;

if (enabled && config?.database.database !== "dhumi_test") {
  throw new Error("Revoke-API-key database tests may run only against dhumi_test");
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

interface SeedKeyOptions {
  readonly state?: "active" | "revoked" | "expired";
  readonly expiresAt?: Date | null;
  readonly revokedAt?: Date | null;
}

interface SeededKey {
  readonly id: string;
  readonly prefix: string;
  readonly createdAt: Date;
}

interface KeyEvidenceRow {
  readonly state: "active" | "revoked" | "expired";
  readonly created_at: Date;
  readonly expires_at: Date | null;
  readonly revoked_at: Date | null;
  readonly updated_at: Date;
}

interface EvidenceCounts {
  readonly audit: string;
  readonly outbox: string;
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
        `api-key-revoke-${nonce}@example.test`,
        "$argon2id$api-key-revoke-fixture-not-a-real-password",
        `API key revoke ${label} ${nonce.slice(0, 8)}`,
        JSON.stringify([
          {
            document_type: "terms",
            document_version: "api-key-revoke-v1",
            document_hash_hex: sha256(`api-key-revoke-legal-${nonce}`).toString("hex"),
            disclosure_version: "api-key-revoke-v1",
            locale: "en",
          },
        ]),
        `api-key-revoke-${nonce}`,
        sha256(`api-key-revoke-request-${nonce}`),
        sha256(`api-key-revoke-actor-${nonce}`),
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
    throw new Error("Could not establish a revoke-API-key database fixture");
  }
  return { userId: row.user_id, tenantId: row.tenant_id };
}

async function seedKey(
  current: Fixture,
  options: SeedKeyOptions = {},
): Promise<SeededKey> {
  const id = randomUUID();
  const nonce = randomUUID();
  const prefix = `dhk_v1_${nonce.replaceAll("-", "").slice(0, 16)}`;
  const createdAt = new Date(Date.now() - 60_000);
  await withIdentityTransaction(must(pools).identity, async (database) => {
    await database.query(
      `
        INSERT INTO app.platform_api_keys (
          id,
          tenant_id,
          creator_user_id,
          name,
          key_prefix,
          key_hash,
          scopes,
          state,
          created_at,
          expires_at,
          revoked_at,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, ARRAY['runs:read']::text[], $7, $8, $9, $10, $8
        )
      `,
      [
        id,
        current.tenantId,
        current.userId,
        `Revoke ${nonce.slice(0, 8)}`,
        prefix,
        sha256(`api-key-revoke-verifier-${nonce}`),
        options.state ?? "active",
        createdAt,
        options.expiresAt ?? null,
        options.revokedAt ?? null,
      ],
    );
  });
  return { id, prefix, createdAt };
}

function repository(): RevokeApiKeyRepository {
  return createRevokeApiKeyRepository(must(pools).customerApi);
}

function revokeInput(current: Fixture, keyId: string, requestId: string | null = randomUUID()) {
  return {
    tenantId: current.tenantId,
    userId: current.userId,
    keyId,
    requestId,
    ipFingerprint: sha256(`api-key-revoke-ip-${keyId}`),
  } as const;
}

async function keyEvidence(keyId: string): Promise<KeyEvidenceRow | undefined> {
  return withIdentityTransaction(must(pools).identity, async (database) => {
    const result = await database.query<KeyEvidenceRow>(
      `
        SELECT state, created_at, expires_at, revoked_at, updated_at
        FROM app.platform_api_keys
        WHERE id = $1
      `,
      [keyId],
    );
    return result.rows[0];
  });
}

async function evidenceCounts(tenantId: string, keyId: string): Promise<EvidenceCounts> {
  return withIdentityTransaction(must(pools).identity, async (database) => {
    const result = await database.query<EvidenceCounts>(
      `
        SELECT
          (
            SELECT count(*)
            FROM app.audit_events
            WHERE tenant_id = $1
              AND target_id = $2
              AND action = 'api_keys.revoke'
          )::text AS audit,
          (
            SELECT count(*)
            FROM app.outbox_events
            WHERE tenant_id = $1
              AND aggregate_id = $2
              AND topic = 'security.api_key_revoked'
          )::text AS outbox
      `,
      [tenantId, keyId],
    );
    return result.rows[0]!;
  });
}

describe.skipIf(!enabled)("revoke API key against PostgreSQL", () => {
  it("enforces migrations 0011/0012's column-scoped producer privileges", async () => {
    const current = await fixture("least-privilege");
    const key = await seedKey(current);

    const privileges = await withTenantTransaction(
      must(pools).customerApi,
      current.tenantId,
      async (database) => {
        const result = await database.query<{
          readonly key_table_update: boolean;
          readonly state_update: boolean;
          readonly revoked_update: boolean;
          readonly updated_update: boolean;
          readonly hash_update: boolean;
          readonly tenant_update: boolean;
          readonly outbox_table_insert: boolean;
          readonly outbox_topic_insert: boolean;
          readonly outbox_payload_insert: boolean;
          readonly outbox_schema_version_insert: boolean;
          readonly outbox_claimed_insert: boolean;
          readonly outbox_select: boolean;
          readonly outbox_update: boolean;
        }>(
          `
            SELECT
              has_table_privilege(current_user, 'app.platform_api_keys', 'UPDATE') AS key_table_update,
              has_column_privilege(current_user, 'app.platform_api_keys', 'state', 'UPDATE') AS state_update,
              has_column_privilege(current_user, 'app.platform_api_keys', 'revoked_at', 'UPDATE') AS revoked_update,
              has_column_privilege(current_user, 'app.platform_api_keys', 'updated_at', 'UPDATE') AS updated_update,
              has_column_privilege(current_user, 'app.platform_api_keys', 'key_hash', 'UPDATE') AS hash_update,
              has_column_privilege(current_user, 'app.platform_api_keys', 'tenant_id', 'UPDATE') AS tenant_update,
              has_table_privilege(current_user, 'app.outbox_events', 'INSERT') AS outbox_table_insert,
              has_column_privilege(current_user, 'app.outbox_events', 'topic', 'INSERT') AS outbox_topic_insert,
              has_column_privilege(current_user, 'app.outbox_events', 'payload', 'INSERT') AS outbox_payload_insert,
              has_column_privilege(current_user, 'app.outbox_events', 'schema_version', 'INSERT') AS outbox_schema_version_insert,
              has_column_privilege(current_user, 'app.outbox_events', 'claimed_at', 'INSERT') AS outbox_claimed_insert,
              has_table_privilege(current_user, 'app.outbox_events', 'SELECT') AS outbox_select,
              has_table_privilege(current_user, 'app.outbox_events', 'UPDATE') AS outbox_update
          `,
        );
        return result.rows[0];
      },
    );

    expect(privileges).toEqual({
      key_table_update: false,
      state_update: true,
      revoked_update: true,
      updated_update: false,
      hash_update: false,
      tenant_update: false,
      outbox_table_insert: false,
      outbox_topic_insert: true,
      outbox_payload_insert: true,
      outbox_schema_version_insert: true,
      outbox_claimed_insert: false,
      outbox_select: false,
      outbox_update: false,
    });
    await expect(
      withTenantTransaction(must(pools).customerApi, current.tenantId, async (database) =>
        database.query(
          "UPDATE app.platform_api_keys SET key_hash = $2 WHERE id = $1",
          [key.id, sha256("forbidden-key-hash-change")],
        ),
      ),
    ).rejects.toThrow();
    await expect(
      withTenantTransaction(must(pools).customerApi, current.tenantId, async (database) =>
        database.query("SELECT id FROM app.outbox_events LIMIT 1"),
      ),
    ).rejects.toThrow();
  });

  it("atomically revokes an active key with one safe audit and outbox event", async () => {
    const current = await fixture("active");
    const key = await seedKey(current);
    const requestId = randomUUID();
    const input = revokeInput(current, key.id, requestId);

    await expect(repository().revoke(input)).resolves.toBe("revoked");

    const evidence = await withIdentityTransaction(must(pools).identity, async (database) => {
      const keyResult = await database.query<KeyEvidenceRow>(
        `
          SELECT state, created_at, expires_at, revoked_at, updated_at
          FROM app.platform_api_keys
          WHERE id = $1
        `,
        [key.id],
      );
      const auditResult = await database.query<{
        readonly actor_user_id: string;
        readonly outcome: string;
        readonly request_id: string;
        readonly ip_fingerprint: Buffer;
        readonly safe_diff: Record<string, unknown>;
      }>(
        `
          SELECT actor_user_id, outcome, request_id, ip_fingerprint, safe_diff
          FROM app.audit_events
          WHERE tenant_id = $1
            AND target_id = $2
            AND action = 'api_keys.revoke'
        `,
        [current.tenantId, key.id],
      );
      const outboxResult = await database.query<{
        readonly aggregate_type: string;
        readonly ordering_key: string;
        readonly payload: Record<string, unknown>;
        readonly schema_version: number;
        readonly published_at: Date | null;
      }>(
        `
          SELECT aggregate_type, ordering_key, payload, schema_version, published_at
          FROM app.outbox_events
          WHERE tenant_id = $1
            AND aggregate_id = $2
            AND topic = 'security.api_key_revoked'
        `,
        [current.tenantId, key.id],
      );
      return {
        key: keyResult.rows[0],
        audit: auditResult.rows,
        outbox: outboxResult.rows,
      };
    });

    expect(evidence.key).toMatchObject({ state: "revoked", expires_at: null });
    expect(evidence.key?.revoked_at).toBeInstanceOf(Date);
    expect(evidence.key!.revoked_at!.getTime()).toBeGreaterThanOrEqual(key.createdAt.getTime());
    expect(evidence.key!.updated_at.getTime()).toBeGreaterThanOrEqual(
      evidence.key!.revoked_at!.getTime(),
    );
    expect(evidence.audit).toEqual([
      {
        actor_user_id: current.userId,
        outcome: "revoked",
        request_id: requestId,
        ip_fingerprint: input.ipFingerprint,
        safe_diff: { state_from: "active", state_to: "revoked" },
      },
    ]);
    expect(evidence.outbox).toEqual([
      {
        aggregate_type: "platform_api_key",
        ordering_key: key.id,
        payload: { api_key_id: key.id, key_prefix: key.prefix },
        schema_version: 2,
        published_at: null,
      },
    ]);
    expect(JSON.stringify(evidence.audit)).not.toContain(key.prefix);

    await expect(repository().revoke(input)).resolves.toBe("already_inactive");
    expect(await evidenceCounts(current.tenantId, key.id)).toEqual({ audit: "1", outbox: "1" });

    const page = await createListApiKeysService({
      repository: createListApiKeysRepository(must(pools).customerApi),
    }).list({
      identity: { ...current, sessionId: randomUUID() },
      cursor: undefined,
      limit: "100",
      schemaErrors: [],
    });
    expect(page.data.find((candidate) => candidate.id === key.id)?.state).toBe("revoked");
  });

  it("treats revoked, stored-expired and time-expired visible keys as write-free no-ops", async () => {
    const current = await fixture("inactive");
    const revoked = await seedKey(current, {
      state: "revoked",
      revokedAt: new Date(Date.now() - 30_000),
    });
    const storedExpired = await seedKey(current, { state: "expired" });
    const timeExpired = await seedKey(current, {
      expiresAt: new Date(Date.now() - 30_000),
    });

    await expect(repository().revoke(revokeInput(current, revoked.id))).resolves.toBe(
      "already_inactive",
    );
    await expect(repository().revoke(revokeInput(current, storedExpired.id))).resolves.toBe(
      "already_inactive",
    );
    await expect(repository().revoke(revokeInput(current, timeExpired.id))).resolves.toBe(
      "already_inactive",
    );

    expect((await keyEvidence(revoked.id))?.state).toBe("revoked");
    expect((await keyEvidence(storedExpired.id))?.state).toBe("expired");
    expect(await keyEvidence(timeExpired.id)).toMatchObject({ state: "active", revoked_at: null });
    for (const key of [revoked, storedExpired, timeExpired]) {
      expect(await evidenceCounts(current.tenantId, key.id)).toEqual({ audit: "0", outbox: "0" });
    }
  });

  it("returns one not-found outcome for unknown and cross-Tenant identifiers", async () => {
    const tenantA = await fixture("tenant-a");
    const tenantB = await fixture("tenant-b");
    const otherKey = await seedKey(tenantB);

    await expect(repository().revoke(revokeInput(tenantA, randomUUID()))).resolves.toBe(
      "not_found",
    );
    await expect(repository().revoke(revokeInput(tenantA, otherKey.id))).resolves.toBe(
      "not_found",
    );
    expect(await keyEvidence(otherKey.id)).toMatchObject({ state: "active", revoked_at: null });
    expect(await evidenceCounts(tenantB.tenantId, otherKey.id)).toEqual({
      audit: "0",
      outbox: "0",
    });
  });

  it("serializes concurrent revocations into one transition and one evidence set", async () => {
    const current = await fixture("concurrent");
    const key = await seedKey(current);

    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () =>
        repository().revoke(revokeInput(current, key.id)),
      ),
    );

    expect(outcomes.filter((outcome) => outcome === "revoked")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "already_inactive")).toHaveLength(11);
    expect(await evidenceCounts(current.tenantId, key.id)).toEqual({ audit: "1", outbox: "1" });
  });

  it("rolls back the key transition when a later audit write fails", async () => {
    const current = await fixture("rollback");
    const key = await seedKey(current);

    await expect(
      repository().revoke(revokeInput(current, key.id, "not-a-database-uuid")),
    ).rejects.toMatchObject({ status: 500, code: "INTERNAL_ERROR" });

    expect(await keyEvidence(key.id)).toMatchObject({ state: "active", revoked_at: null });
    expect(await evidenceCounts(current.tenantId, key.id)).toEqual({ audit: "0", outbox: "0" });
  });

  it("updates zero rows when the Customer API role has no Tenant context", async () => {
    const current = await fixture("no-context");
    const key = await seedKey(current);
    const client = await must(pools).customerApi.connect();
    let rowCount: number | null = null;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE dhumi_customer_api");
      rowCount = (
        await client.query(
          `
            UPDATE app.platform_api_keys
            SET state = 'revoked', revoked_at = clock_timestamp()
            WHERE id = $1
          `,
          [key.id],
        )
      ).rowCount;
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    expect(rowCount).toBe(0);
    expect(await keyEvidence(key.id)).toMatchObject({ state: "active", revoked_at: null });
  });
});
