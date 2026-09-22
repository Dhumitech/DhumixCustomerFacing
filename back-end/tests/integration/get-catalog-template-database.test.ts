import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import { createDatabasePools } from "../../src/services/database/pools.js";
import {
  withIdentityTransaction,
  withTenantTransaction,
} from "../../src/services/database/transactions.js";
import { createGetCatalogTemplateRepository } from "../../src/services/catalogue/getCatalogTemplateRepository.js";
import { createGetCatalogTemplateService } from "../../src/services/catalogue/getCatalogTemplateService.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const config = enabled ? loadRuntimeConfig() : undefined;

if (enabled && config?.database.database !== "dhumi_test") {
  throw new Error("Get-catalogue-Template database tests may run only against dhumi_test");
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

async function fixture(): Promise<Fixture> {
  const nonce = randomUUID();
  const row = await withIdentityTransaction(must(pools).identity, async (database) => {
    const result = await database.query<SignupRow>(
      `
        SELECT user_id, tenant_id
        FROM app.create_signup($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
      `,
      [
        `catalogue-detail-${nonce}@example.test`,
        "$argon2id$catalogue-detail-fixture-not-a-real-password",
        `Catalogue detail ${nonce.slice(0, 8)}`,
        JSON.stringify([
          {
            document_type: "terms",
            document_version: "catalogue-detail-v1",
            document_hash_hex: sha256(`catalogue-detail-legal-${nonce}`).toString("hex"),
            disclosure_version: "catalogue-detail-v1",
            locale: "en",
          },
        ]),
        `catalogue-detail-${nonce}`,
        sha256(`catalogue-detail-request-${nonce}`),
        sha256(`catalogue-detail-actor-${nonce}`),
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
    throw new Error("Could not establish a catalogue-detail database fixture");
  }
  return { userId: row.user_id, tenantId: row.tenant_id };
}

async function evidenceCounts(tenantId: string) {
  return withIdentityTransaction(must(pools).identity, async (database) => {
    const result = await database.query<{
      readonly idempotency: string;
      readonly audit: string;
      readonly outbox: string;
    }>(
      `
        SELECT
          (SELECT count(*) FROM app.idempotency_records WHERE tenant_id = $1)::text AS idempotency,
          (SELECT count(*) FROM app.audit_events WHERE tenant_id = $1)::text AS audit,
          (SELECT count(*) FROM app.outbox_events WHERE tenant_id = $1)::text AS outbox
      `,
      [tenantId],
    );
    return result.rows[0];
  });
}

describe.skipIf(!enabled)("get catalogue Template against PostgreSQL", () => {
  it("enforces migration 0014's exact public slug grammar and existing unique lookup", async () => {
    const current = await fixture();
    const evidence = await withTenantTransaction(
      must(pools).customerApi,
      current.tenantId,
      async (database) => {
        const constraint = await database.query<{ readonly definition: string }>(
          `
            SELECT pg_get_constraintdef(constraint_row.oid) AS definition
            FROM pg_constraint AS constraint_row
            INNER JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
            INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'app'
              AND relation.relname = 'service_templates'
              AND constraint_row.conname = 'service_templates_slug_check'
          `,
        );
        const index = await database.query<{ readonly indexdef: string }>(
          `
            SELECT indexdef
            FROM pg_indexes
            WHERE schemaname = 'app'
              AND tablename = 'service_templates'
              AND indexname = 'service_templates_slug_key'
          `,
        );
        return { constraint: constraint.rows[0], index: index.rows[0] };
      },
    );

    expect(evidence.constraint?.definition).toMatch(/length\(slug\).*(3).*(100)/i);
    expect(evidence.constraint?.definition).toContain("(-[a-z0-9]+)*");
    expect(evidence.constraint?.definition).not.toContain("[a-z0-9-]{1,98}");
    expect(evidence.index?.indexdef).toMatch(/UNIQUE INDEX.*\(slug\)/i);
  });

  it("returns generic not-found without persistence side effects", async () => {
    const current = await fixture();
    const before = await evidenceCounts(current.tenantId);
    const service = createGetCatalogTemplateService({
      repository: createGetCatalogTemplateRepository(must(pools).customerApi),
    });

    await expect(
      service.get({
        principal: { kind: "browser", ...current, sessionId: randomUUID() },
        slug: `missing-template-${randomUUID().slice(0, 8)}`,
        schemaErrors: [],
      }),
    ).rejects.toMatchObject({ status: 404, code: "RESOURCE_NOT_FOUND" });
    expect(await evidenceCounts(current.tenantId)).toEqual(before);
  });

  it("fails closed without Tenant context and preserves private-column denials", async () => {
    const current = await fixture();
    const client = await must(pools).customerApi.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE dhumi_customer_api");
      expect((await client.query("SELECT id, slug FROM app.service_templates")).rows).toEqual([]);
      expect(
        (await client.query("SELECT id, service_template_id FROM app.service_template_versions"))
          .rows,
      ).toEqual([]);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    const forbiddenQueries = [
      "SELECT adapter_version_id FROM app.service_template_versions LIMIT 1",
      "SELECT output_schema FROM app.service_template_versions LIMIT 1",
      "SELECT restricted_reference FROM app.launch_evidence LIMIT 1",
      "SELECT * FROM app.provider_mappings LIMIT 1",
    ];
    for (const query of forbiddenQueries) {
      await expect(
        withTenantTransaction(must(pools).customerApi, current.tenantId, async (database) =>
          database.query(query),
        ),
      ).rejects.toThrow();
    }
  });
});
