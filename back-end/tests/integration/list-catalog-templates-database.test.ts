import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import { createDatabasePools } from "../../src/services/database/pools.js";
import {
  withIdentityTransaction,
  withTenantTransaction,
} from "../../src/services/database/transactions.js";
import { createListCatalogTemplatesRepository } from "../../src/services/catalogue/listCatalogTemplatesRepository.js";
import { createListCatalogTemplatesService } from "../../src/services/catalogue/listCatalogTemplatesService.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const config = enabled ? loadRuntimeConfig() : undefined;

if (enabled && config?.database.database !== "dhumi_test") {
  throw new Error("List-catalogue-Templates database tests may run only against dhumi_test");
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
        `catalogue-list-${nonce}@example.test`,
        "$argon2id$catalogue-list-fixture-not-a-real-password",
        `Catalogue list ${nonce.slice(0, 8)}`,
        JSON.stringify([
          {
            document_type: "terms",
            document_version: "catalogue-list-v1",
            document_hash_hex: sha256(`catalogue-list-legal-${nonce}`).toString("hex"),
            disclosure_version: "catalogue-list-v1",
            locale: "en",
          },
        ]),
        `catalogue-list-${nonce}`,
        sha256(`catalogue-list-request-${nonce}`),
        sha256(`catalogue-list-actor-${nonce}`),
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
    throw new Error("Could not establish a catalogue-list database fixture");
  }
  return { userId: row.user_id, tenantId: row.tenant_id };
}

function service() {
  return createListCatalogTemplatesService({
    repository: createListCatalogTemplatesRepository(must(pools).customerApi),
  });
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

describe.skipIf(!enabled)("list catalogue Templates against PostgreSQL", () => {
  it("enforces migration 0013 constraints, policies, index, and column-scoped privileges", async () => {
    const current = await fixture();
    const evidence = await withTenantTransaction(
      must(pools).customerApi,
      current.tenantId,
      async (database) => {
        const privileges = await database.query<{
          readonly template_table_select: boolean;
          readonly slug_select: boolean;
          readonly pointer_select: boolean;
          readonly version_table_select: boolean;
          readonly input_select: boolean;
          readonly adapter_select: boolean;
          readonly output_select: boolean;
          readonly evidence_table_select: boolean;
          readonly evidence_state_select: boolean;
          readonly restricted_reference_select: boolean;
          readonly provider_mapping_select: boolean;
        }>(
          `
            SELECT
              has_table_privilege(current_user, 'app.service_templates', 'SELECT') AS template_table_select,
              has_column_privilege(current_user, 'app.service_templates', 'slug', 'SELECT') AS slug_select,
              has_column_privilege(current_user, 'app.service_templates', 'current_public_version_id', 'SELECT') AS pointer_select,
              has_table_privilege(current_user, 'app.service_template_versions', 'SELECT') AS version_table_select,
              has_column_privilege(current_user, 'app.service_template_versions', 'input_schema', 'SELECT') AS input_select,
              has_column_privilege(current_user, 'app.service_template_versions', 'adapter_version_id', 'SELECT') AS adapter_select,
              has_column_privilege(current_user, 'app.service_template_versions', 'output_schema', 'SELECT') AS output_select,
              has_table_privilege(current_user, 'app.launch_evidence', 'SELECT') AS evidence_table_select,
              has_column_privilege(current_user, 'app.launch_evidence', 'state', 'SELECT') AS evidence_state_select,
              has_column_privilege(current_user, 'app.launch_evidence', 'restricted_reference', 'SELECT') AS restricted_reference_select,
              has_table_privilege(current_user, 'app.provider_mappings', 'SELECT') AS provider_mapping_select
          `,
        );
        const constraints = await database.query<{ readonly conname: string }>(
          `
            SELECT conname
            FROM pg_constraint
            WHERE connamespace = 'app'::regnamespace
              AND conname IN (
                'service_templates_current_public_version_fk',
                'service_templates_public_pointer_check',
                'service_template_versions_availability_state_check',
                'service_template_versions_template_id_id_key'
              )
            ORDER BY conname
          `,
        );
        const policies = await database.query<{
          readonly policyname: string;
          readonly qual: string;
        }>(
          `
            SELECT policyname, qual
            FROM pg_policies
            WHERE schemaname = 'app'
              AND tablename IN ('service_templates', 'service_template_versions')
              AND policyname IN (
                'service_templates_customer_read',
                'service_template_versions_customer_read'
              )
            ORDER BY policyname
          `,
        );
        const index = await database.query<{ readonly indexdef: string }>(
          `
            SELECT indexdef
            FROM pg_indexes
            WHERE schemaname = 'app'
              AND tablename = 'service_templates'
              AND indexname = 'service_templates_public_list_idx'
          `,
        );
        return {
          privileges: privileges.rows[0],
          constraints: constraints.rows,
          policies: policies.rows,
          index: index.rows[0],
        };
      },
    );

    expect(evidence.privileges).toEqual({
      template_table_select: false,
      slug_select: true,
      pointer_select: true,
      version_table_select: false,
      input_select: true,
      adapter_select: false,
      output_select: false,
      evidence_table_select: false,
      evidence_state_select: true,
      restricted_reference_select: false,
      provider_mapping_select: false,
    });
    expect(evidence.constraints.map((row) => row.conname)).toEqual([
      "service_template_versions_availability_state_check",
      "service_template_versions_template_id_id_key",
      "service_templates_current_public_version_fk",
      "service_templates_public_pointer_check",
    ]);
    expect(evidence.policies).toHaveLength(2);
    expect(evidence.policies.every((policy) => policy.qual.includes("current_tenant_id"))).toBe(
      true,
    );
    expect(evidence.policies.find((policy) => policy.policyname.includes("versions"))?.qual).toMatch(
      /launch_evidence|approved|effective_at|current_public_version_id/,
    );
    expect(evidence.index?.indexdef).toMatch(/product_family, slug, id/);
  });

  it("reads the safe projection without persistence side effects and fails closed without Tenant context", async () => {
    const current = await fixture();
    const before = await evidenceCounts(current.tenantId);
    const result = await service().list({
      principal: { kind: "browser", ...current, sessionId: randomUUID() },
      family: undefined,
      cursor: undefined,
      limit: "100",
      schemaErrors: [],
    });

    expect(
      result.data.every(
        (template) =>
          JSON.stringify(Object.keys(template).sort()) ===
          JSON.stringify([
            "availability",
            "configuration_schema",
            "description",
            "family",
            "input_schema",
            "name",
            "presentation",
            "slug",
            "version",
          ]),
      ),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(
      /adapter|evidence|provider|dataset_id|snapshot_id|restricted_reference/i,
    );
    expect(await evidenceCounts(current.tenantId)).toEqual(before);

    const client = await must(pools).customerApi.connect();
    let withoutContextTemplates: readonly unknown[] = [];
    let withoutContextVersions: readonly unknown[] = [];
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE dhumi_customer_api");
      withoutContextTemplates = (
        await client.query("SELECT id, slug FROM app.service_templates")
      ).rows;
      withoutContextVersions = (
        await client.query(
          "SELECT id, service_template_id FROM app.service_template_versions",
        )
      ).rows;
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(withoutContextTemplates).toEqual([]);
    expect(withoutContextVersions).toEqual([]);
  });

  it("cannot read adapter, output-schema, restricted-evidence, or provider-mapping data", async () => {
    const current = await fixture();
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
