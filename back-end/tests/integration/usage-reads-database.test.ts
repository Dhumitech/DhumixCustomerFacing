import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import { createDatabasePools } from "../../src/services/database/pools.js";
import { withIdentityTransaction } from "../../src/services/database/transactions.js";
import { createGetUsageSummaryRepository } from "../../src/services/usage/getUsageSummaryRepository.js";
import { createGetUsageSummaryService } from "../../src/services/usage/getUsageSummaryService.js";
import { createListUsageEventsRepository } from "../../src/services/usage/listUsageEventsRepository.js";
import { createListUsageEventsService } from "../../src/services/usage/listUsageEventsService.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const config = enabled ? loadRuntimeConfig() : undefined;

if (enabled && config?.database.database !== "dhumi_test") {
  throw new Error("Usage-read database tests may run only against dhumi_test");
}

const pools =
  enabled && config ? createDatabasePools(config.database, () => {}) : undefined;

afterAll(async () => {
  await pools?.close();
});

function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("database integration configuration is unavailable");
  }
  return value;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

interface SignupRow {
  readonly user_id: string | null;
  readonly tenant_id: string | null;
}

async function tenantFixture() {
  const nonce = randomUUID();
  const row = await withIdentityTransaction(
    must(pools).identity,
    async (database) => {
      const result = await database.query<SignupRow>(
        `
          SELECT user_id, tenant_id
          FROM app.create_signup($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
        `,
        [
          `usage-reads-${nonce}@example.test`,
          "$argon2id$usage-reads-fixture-not-a-real-password",
          `Usage reads ${nonce.slice(0, 8)}`,
          JSON.stringify([
            {
              document_type: "terms",
              document_version: "usage-reads-v1",
              document_hash_hex: sha256(`usage-reads-legal-${nonce}`).toString(
                "hex",
              ),
              disclosure_version: "usage-reads-v1",
              locale: "en",
            },
          ]),
          `usage-reads-${nonce}`,
          sha256(`usage-reads-request-${nonce}`),
          sha256(`usage-reads-actor-${nonce}`),
          randomUUID(),
        ],
      );
      return result.rows[0];
    },
  );
  if (row?.user_id === null || row?.tenant_id === null || row === undefined) {
    throw new Error("Could not establish a usage-read Tenant fixture");
  }
  return {
    kind: "browser" as const,
    userId: row.user_id,
    tenantId: row.tenant_id,
    sessionId: randomUUID(),
  };
}

describe.skipIf(!enabled)("usage reads against PostgreSQL", () => {
  it("returns honest empty projections for a new Tenant", async () => {
    const principal = await tenantFixture();
    const request = {
      principal,
      from: "2026-08-01T00:00:00Z",
      to: "2026-09-01T00:00:00Z",
      schemaErrors: [],
    } as const;

    const summary = await createGetUsageSummaryService({
      repository: createGetUsageSummaryRepository(must(pools).customerApi),
    }).get(request);
    expect(summary).toMatchObject({
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-09-01T00:00:00.000Z",
      items: [],
      state: "observed",
    });
    expect(Number.isNaN(new Date(summary.updated_at).getTime())).toBe(false);

    const events = await createListUsageEventsService({
      repository: createListUsageEventsRepository(must(pools).customerApi),
    }).list({
      ...request,
      cursor: undefined,
      limit: undefined,
    });
    expect(events).toEqual({
      data: [],
      page: { next_cursor: null, has_more: false },
    });
  });

  it("denies direct usage table access and fails closed without Tenant context", async () => {
    const client = await must(pools).customerApi.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE dhumi_customer_api");
      await expect(client.query("SELECT id FROM app.usage_events")).rejects.toThrow();
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE dhumi_customer_api");
      await expect(
        client.query(
          "SELECT * FROM app.get_usage_summary($1::timestamptz, $2::timestamptz)",
          ["2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z"],
        ),
      ).rejects.toThrow(/TENANT_CONTEXT_REQUIRED/);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
