import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import { createDatabasePools } from "../../src/services/database/pools.js";
import {
  withIdentityTransaction,
  withTenantTransaction,
} from "../../src/services/database/transactions.js";
import { createListApiKeysRepository } from "../../src/services/apiKeys/listApiKeysRepository.js";
import { createListApiKeysService } from "../../src/services/apiKeys/listApiKeysService.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const config = enabled ? loadRuntimeConfig() : undefined;

if (enabled && config?.database.database !== "dhumi_test") {
  throw new Error("List-API-keys database tests may run only against dhumi_test");
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
  readonly name: string;
  readonly createdAt: Date;
  readonly state?: "active" | "revoked" | "expired";
  readonly lastUsedAt?: Date | null;
  readonly expiresAt?: Date | null;
  readonly revokedAt?: Date | null;
}

interface SeededKey {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
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
        `api-key-list-${nonce}@example.test`,
        "$argon2id$api-key-list-fixture-not-a-real-password",
        `API key list ${label} ${nonce.slice(0, 8)}`,
        JSON.stringify([
          {
            document_type: "terms",
            document_version: "api-key-list-v1",
            document_hash_hex: sha256(`api-key-list-legal-${nonce}`).toString("hex"),
            disclosure_version: "api-key-list-v1",
            locale: "en",
          },
        ]),
        `api-key-list-${nonce}`,
        sha256(`api-key-list-request-${nonce}`),
        sha256(`api-key-list-actor-${nonce}`),
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
    throw new Error("Could not establish a list-API-keys database fixture");
  }
  return { userId: row.user_id, tenantId: row.tenant_id };
}

async function seedKey(current: Fixture, options: SeedKeyOptions): Promise<SeededKey> {
  const id = randomUUID();
  const nonce = randomUUID();
  const state = options.state ?? "active";
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
          last_used_at,
          expires_at,
          revoked_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, ARRAY['runs:read']::text[], $7, $8, $9, $10, $11, $8)
      `,
      [
        id,
        current.tenantId,
        current.userId,
        options.name,
        `dhk_v1_${nonce.replaceAll("-", "").slice(0, 16)}`,
        sha256(`api-key-list-verifier-${nonce}`),
        state,
        options.createdAt,
        options.lastUsedAt ?? null,
        options.expiresAt ?? null,
        options.revokedAt ?? null,
      ],
    );
  });
  return { id, name: options.name, createdAt: options.createdAt };
}

function service() {
  return createListApiKeysService({
    repository: createListApiKeysRepository(must(pools).customerApi),
  });
}

function request(current: Fixture, limit: string, cursor?: string) {
  return {
    identity: {
      userId: current.userId,
      sessionId: randomUUID(),
      tenantId: current.tenantId,
    },
    cursor,
    limit,
    schemaErrors: [],
  } as const;
}

async function counts(tenantId: string) {
  return withIdentityTransaction(must(pools).identity, async (database) => {
    const result = await database.query<{
      readonly keys: string;
      readonly idempotency: string;
      readonly audit: string;
    }>(
      `
        SELECT
          (SELECT count(*) FROM app.platform_api_keys WHERE tenant_id = $1)::text AS keys,
          (SELECT count(*) FROM app.idempotency_records WHERE tenant_id = $1)::text AS idempotency,
          (SELECT count(*) FROM app.audit_events WHERE tenant_id = $1)::text AS audit
      `,
      [tenantId],
    );
    return result.rows[0];
  });
}

describe.skipIf(!enabled)("list API keys against PostgreSQL", () => {
  it("enforces migration 0010 index and metadata-only Customer API privileges", async () => {
    const current = await fixture("least-privilege");
    await seedKey(current, { name: "Least privilege", createdAt: new Date("2026-08-20T00:00:00.000Z") });

    const evidence = await withTenantTransaction(
      must(pools).customerApi,
      current.tenantId,
      async (database) => {
        const privileges = await database.query<{
          readonly table_select: boolean;
          readonly safe_select: boolean;
          readonly hash_select: boolean;
          readonly creator_select: boolean;
          readonly updated_select: boolean;
        }>(
          `
            SELECT
              has_table_privilege(current_user, 'app.platform_api_keys', 'SELECT') AS table_select,
              has_column_privilege(current_user, 'app.platform_api_keys', 'name', 'SELECT') AS safe_select,
              has_column_privilege(current_user, 'app.platform_api_keys', 'key_hash', 'SELECT') AS hash_select,
              has_column_privilege(current_user, 'app.platform_api_keys', 'creator_user_id', 'SELECT') AS creator_select,
              has_column_privilege(current_user, 'app.platform_api_keys', 'updated_at', 'SELECT') AS updated_select
          `,
        );
        const index = await database.query<{ readonly indexdef: string }>(
          `
            SELECT indexdef
            FROM pg_indexes
            WHERE schemaname = 'app'
              AND tablename = 'platform_api_keys'
              AND indexname = 'platform_api_keys_by_tenant_created_id_idx'
          `,
        );
        return { privileges: privileges.rows[0], index: index.rows[0] };
      },
    );

    expect(evidence.privileges).toEqual({
      table_select: false,
      safe_select: true,
      hash_select: false,
      creator_select: false,
      updated_select: false,
    });
    expect(evidence.index?.indexdef).toContain("tenant_id, created_at DESC, id DESC");
    await expect(
      withTenantTransaction(must(pools).customerApi, current.tenantId, async (database) =>
        database.query("SELECT key_hash FROM app.platform_api_keys LIMIT 1"),
      ),
    ).rejects.toThrow();
  });

  it("returns only the trusted Tenant and derives expired and revoked state at database time", async () => {
    const tenantA = await fixture("tenant-a");
    const tenantB = await fixture("tenant-b");
    const active = await seedKey(tenantA, {
      name: "A active",
      createdAt: new Date("2026-08-20T00:00:00.000Z"),
    });
    const expired = await seedKey(tenantA, {
      name: "A expired",
      createdAt: new Date("2026-08-18T00:00:00.000Z"),
      expiresAt: new Date("2026-08-19T00:00:00.000Z"),
    });
    const revoked = await seedKey(tenantA, {
      name: "A revoked",
      state: "revoked",
      createdAt: new Date("2026-08-17T00:00:00.000Z"),
      expiresAt: new Date("2026-08-18T00:00:00.000Z"),
      revokedAt: new Date("2026-08-19T00:00:00.000Z"),
    });
    const other = await seedKey(tenantB, {
      name: "B private",
      createdAt: new Date("2026-08-21T00:00:00.000Z"),
    });

    const result = await service().list(request(tenantA, "100"));

    expect(result.data.map((key) => key.id)).toEqual([active.id, expired.id, revoked.id]);
    expect(result.data.find((key) => key.id === expired.id)?.state).toBe("expired");
    expect(result.data.find((key) => key.id === revoked.id)?.state).toBe("revoked");
    expect(result.data.map((key) => key.id)).not.toContain(other.id);
    expect(JSON.stringify(result)).not.toMatch(/key_hash|creator_user_id|tenant_id|secret/i);
  });

  it("paginates equal timestamps deterministically across inserts and mutable state changes", async () => {
    const current = await fixture("stable-pagination");
    const sharedTime = new Date("2026-08-20T00:00:00.000Z");
    const seeded = await Promise.all([
      seedKey(current, { name: "Equal A", createdAt: sharedTime }),
      seedKey(current, { name: "Equal B", createdAt: sharedTime }),
      seedKey(current, { name: "Equal C", createdAt: sharedTime }),
    ]);
    const expected = [...seeded].sort((left, right) => right.id.localeCompare(left.id));

    const first = await service().list(request(current, "1"));
    expect(first.data.map((key) => key.id)).toEqual([expected[0]!.id]);
    expect(first.page.has_more).toBe(true);

    await seedKey(current, {
      name: "Inserted before cursor",
      createdAt: new Date("2026-08-21T00:00:00.000Z"),
    });
    await withIdentityTransaction(must(pools).identity, async (database) => {
      await database.query(
        `
          UPDATE app.platform_api_keys
          SET state = 'revoked', revoked_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE id = $1
        `,
        [expected[1]!.id],
      );
    });

    const second = await service().list(request(current, "1", first.page.next_cursor!));
    const third = await service().list(request(current, "1", second.page.next_cursor!));
    expect([...first.data, ...second.data, ...third.data].map((key) => key.id)).toEqual(
      expected.map((key) => key.id),
    );
    expect(second.data[0]?.state).toBe("revoked");
    expect(third.page).toEqual({ next_cursor: null, has_more: false });
  });

  it("returns an empty page without Tenant context and performs no persistent writes", async () => {
    const current = await fixture("read-only");
    await seedKey(current, { name: "Read only", createdAt: new Date("2026-08-20T00:00:00.000Z") });
    const before = await counts(current.tenantId);

    const result = await service().list(request(current, "20"));
    const client = await must(pools).customerApi.connect();
    let withoutContext: readonly unknown[] = [];
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE dhumi_customer_api");
      withoutContext = (
        await client.query("SELECT id, name FROM app.platform_api_keys ORDER BY created_at DESC")
      ).rows;
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    expect(result.data).toHaveLength(1);
    expect(withoutContext).toEqual([]);
    expect(await counts(current.tenantId)).toEqual(before);
  });
});
