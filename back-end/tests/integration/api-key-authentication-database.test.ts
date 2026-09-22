import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import { createApiKeyMaterial, type ApiKeyMaterial } from "../../src/helpers/apiKeyMaterial.js";
import {
  createApiKeyAuthenticationRepository,
  type ApiKeyAuthenticationRepository,
} from "../../src/services/apiKeys/apiKeyAuthenticationRepository.js";
import { createApiKeyAuthenticationService } from "../../src/services/apiKeys/apiKeyAuthenticationService.js";
import { createDatabasePools } from "../../src/services/database/pools.js";
import { withIdentityTransaction } from "../../src/services/database/transactions.js";
import { createWorkspaceRepository } from "../../src/services/workspace/workspaceRepository.js";
import { createWorkspaceService } from "../../src/services/workspace/workspaceService.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const config = enabled ? loadRuntimeConfig() : undefined;

if (enabled && config?.database.database !== "dhumi_test") {
  throw new Error("API-key authentication database tests may run only against dhumi_test");
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

interface SeedOptions {
  readonly state?: "active" | "revoked" | "expired";
  readonly expiresAt?: Date | null;
}

interface SeededKey {
  readonly id: string;
  readonly material: ApiKeyMaterial;
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
        `api-key-auth-${nonce}@example.test`,
        "$argon2id$api-key-auth-fixture-not-a-real-password",
        `API key auth ${label} ${nonce.slice(0, 8)}`,
        JSON.stringify([
          {
            document_type: "terms",
            document_version: "api-key-auth-v1",
            document_hash_hex: sha256(`api-key-auth-legal-${nonce}`).toString("hex"),
            disclosure_version: "api-key-auth-v1",
            locale: "en",
          },
        ]),
        `api-key-auth-${nonce}`,
        sha256(`api-key-auth-request-${nonce}`),
        sha256(`api-key-auth-actor-${nonce}`),
        randomUUID(),
      ],
    );
    return result.rows[0];
  });
  if (row?.user_id == null || row.tenant_id == null) {
    throw new Error("Could not establish an API-key authentication fixture");
  }
  return { userId: row.user_id, tenantId: row.tenant_id };
}

async function seedKey(current: Fixture, options: SeedOptions = {}): Promise<SeededKey> {
  const id = randomUUID();
  const material = createApiKeyMaterial();
  const createdAt = new Date(Date.now() - 60_000);
  const state = options.state ?? "active";
  await withIdentityTransaction(must(pools).identity, async (database) => {
    await database.query(
      `
        INSERT INTO app.platform_api_keys (
          id, tenant_id, creator_user_id, name, key_prefix, key_hash, scopes,
          state, created_at, expires_at, revoked_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, ARRAY['catalog:read', 'runs:read']::text[],
          $7, $8, $9, $10, $8
        )
      `,
      [
        id,
        current.tenantId,
        current.userId,
        `Auth ${id.slice(0, 8)}`,
        material.prefix,
        material.hash,
        state,
        createdAt,
        options.expiresAt ?? null,
        state === "revoked" ? new Date() : null,
      ],
    );
  });
  return { id, material };
}

function repository(): ApiKeyAuthenticationRepository {
  return createApiKeyAuthenticationRepository(must(pools).identity);
}

function authentication() {
  return createApiKeyAuthenticationService({ repository: repository() });
}

function observedFinalizationPool(pool: Pool, onQueryStarted: () => void): Pool {
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property === "connect") {
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(clientTarget, clientProperty, clientReceiver) {
              if (clientProperty === "query") {
                return (...args: readonly unknown[]) => {
                  if (
                    typeof args[0] === "string" &&
                    args[0].includes("FOR UPDATE OF api_key")
                  ) {
                    onQueryStarted();
                  }
                  return Reflect.apply(clientTarget.query, clientTarget, args);
                };
              }
              const value = Reflect.get(clientTarget, clientProperty, clientReceiver);
              return typeof value === "function" ? value.bind(clientTarget) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function lastUsedAt(keyId: string): Promise<Date | null> {
  return withIdentityTransaction(must(pools).identity, async (database) => {
    const result = await database.query<{ last_used_at: Date | null }>(
      "SELECT last_used_at FROM app.platform_api_keys WHERE id = $1",
      [keyId],
    );
    return result.rows[0]?.last_used_at ?? null;
  });
}

describe.skipIf(!enabled)("Dhumi API-key authentication against PostgreSQL", () => {
  it("authenticates from PostgreSQL, records use, and reads the Tenant workspace", async () => {
    const current = await fixture("happy");
    const key = await seedKey(current);

    const principal = await authentication().authenticate(`Bearer ${key.material.secret}`);
    expect(principal).toEqual({
      kind: "api_key",
      apiKeyId: key.id,
      tenantId: current.tenantId,
      scopes: ["catalog:read", "runs:read"],
    });
    expect(await lastUsedAt(key.id)).toBeInstanceOf(Date);
    await expect(
      createWorkspaceService({
        repository: createWorkspaceRepository(must(pools).customerApi),
      }).getWorkspace(principal),
    ).resolves.toMatchObject({ id: current.tenantId, state: "active" });
  });

  it("rejects a canonical wrong secret sharing a real prefix without recording use", async () => {
    const current = await fixture("wrong-secret");
    const key = await seedKey(current);
    const wrongSecretPart = Buffer.alloc(32, 71).toString("base64url");

    await expect(
      authentication().authenticate(`Bearer ${key.material.prefix}.${wrongSecretPart}`),
    ).rejects.toMatchObject({ status: 401, code: "AUTHENTICATION_REQUIRED" });
    expect(await lastUsedAt(key.id)).toBeNull();
  });

  it("rejects revoked, stored-expired, and time-expired keys through one 401 surface", async () => {
    const current = await fixture("inactive");
    const keys = [
      await seedKey(current, { state: "revoked" }),
      await seedKey(current, { state: "expired" }),
      await seedKey(current, { expiresAt: new Date(Date.now() - 1_000) }),
    ];

    for (const key of keys) {
      await expect(
        authentication().authenticate(`Bearer ${key.material.secret}`),
      ).rejects.toMatchObject({ status: 401, code: "AUTHENTICATION_REQUIRED" });
      expect(await lastUsedAt(key.id)).toBeNull();
    }
  });

  it("returns generic access denial for a verified key whose Tenant is suspended", async () => {
    const current = await fixture("suspended-tenant");
    const key = await seedKey(current);
    await withIdentityTransaction(must(pools).identity, async (database) => {
      await database.query(
        `
          UPDATE app.tenants
          SET state = 'suspended', suspension_reason_code = 'test', suspension_reference = 'test'
          WHERE id = $1
        `,
        [current.tenantId],
      );
    });

    await expect(
      authentication().authenticate(`Bearer ${key.material.secret}`),
    ).rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });
    expect(await lastUsedAt(key.id)).toBeNull();
  });

  it("rechecks lifecycle after verifier lookup so revocation wins before finalization", async () => {
    const current = await fixture("revocation-race");
    const key = await seedKey(current);
    const store = repository();
    const candidate = await store.findVerifierCandidate(key.material.prefix);
    expect(candidate?.keyId).toBe(key.id);

    await withIdentityTransaction(must(pools).identity, async (database) => {
      await database.query(
        "UPDATE app.platform_api_keys SET state = 'revoked', revoked_at = clock_timestamp() WHERE id = $1",
        [key.id],
      );
    });

    await expect(
      store.finalizeAuthentication({
        keyId: key.id,
        prefix: key.material.prefix,
        presentedHash: key.material.hash,
      }),
    ).resolves.toEqual({
      status: "credential_unavailable",
    });
    expect(await lastUsedAt(key.id)).toBeNull();
  });

  it("waits on the key-row lock and denies when a concurrent revocation commits first", async () => {
    const current = await fixture("revocation-lock-order");
    const key = await seedKey(current);
    const holder = await must(pools).customerApi.connect();
    let queryStartedResolve: (() => void) | undefined;
    const queryStarted = new Promise<void>((resolve) => {
      queryStartedResolve = resolve;
    });

    try {
      await holder.query("BEGIN");
      await holder.query("SET LOCAL ROLE dhumi_customer_api");
      await holder.query("SELECT set_config('app.tenant_id', $1, true)", [current.tenantId]);
      await holder.query(
        "SELECT id FROM app.platform_api_keys WHERE id = $1 FOR UPDATE",
        [key.id],
      );

      const store = createApiKeyAuthenticationRepository(
        observedFinalizationPool(must(pools).identity, () => queryStartedResolve?.()),
      );
      const finalization = store.finalizeAuthentication({
        keyId: key.id,
        prefix: key.material.prefix,
        presentedHash: key.material.hash,
      });
      await queryStarted;

      await holder.query(
        "UPDATE app.platform_api_keys SET state = 'revoked', revoked_at = clock_timestamp() WHERE id = $1",
        [key.id],
      );
      await holder.query("COMMIT");

      await expect(finalization).resolves.toEqual({ status: "credential_unavailable" });
      expect(await lastUsedAt(key.id)).toBeNull();
    } catch (error) {
      await holder.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      holder.release();
    }
  });

  it("waits on the Tenant-row lock and denies when a concurrent suspension commits first", async () => {
    const current = await fixture("tenant-suspension-lock-order");
    const key = await seedKey(current);
    const holder = await must(pools).identity.connect();
    let queryStartedResolve: (() => void) | undefined;
    const queryStarted = new Promise<void>((resolve) => {
      queryStartedResolve = resolve;
    });

    try {
      await holder.query("BEGIN");
      await holder.query("SET LOCAL ROLE dhumi_identity");
      await holder.query(
        `
          UPDATE app.tenants
          SET
            state = 'suspended',
            suspension_reason_code = 'test',
            suspension_reference = 'test'
          WHERE id = $1
        `,
        [current.tenantId],
      );

      const store = createApiKeyAuthenticationRepository(
        observedFinalizationPool(must(pools).identity, () => queryStartedResolve?.()),
      );
      const finalization = store.finalizeAuthentication({
        keyId: key.id,
        prefix: key.material.prefix,
        presentedHash: key.material.hash,
      });
      await queryStarted;

      await holder.query("COMMIT");

      await expect(finalization).resolves.toEqual({ status: "access_denied" });
      expect(await lastUsedAt(key.id)).toBeNull();
    } catch (error) {
      await holder.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      holder.release();
    }
  });

  it("rejects finalization when verifier material changes after lookup", async () => {
    const current = await fixture("verifier-rebinding");
    const key = await seedKey(current);
    const replacement = createApiKeyMaterial();
    const store = repository();
    const candidate = await store.findVerifierCandidate(key.material.prefix);
    expect(candidate?.keyId).toBe(key.id);

    await withIdentityTransaction(must(pools).identity, async (database) => {
      await database.query(
        `
          UPDATE app.platform_api_keys
          SET key_prefix = $2, key_hash = $3
          WHERE id = $1
        `,
        [key.id, replacement.prefix, replacement.hash],
      );
    });

    await expect(
      store.finalizeAuthentication({
        keyId: key.id,
        prefix: key.material.prefix,
        presentedHash: key.material.hash,
      }),
    ).resolves.toEqual({ status: "credential_unavailable" });
    expect(await lastUsedAt(key.id)).toBeNull();
  });
});
