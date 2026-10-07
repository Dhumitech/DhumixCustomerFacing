import { customerContextFixture } from "../helpers/customerContextFixture.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { templateExecutionDefinitionHash } from '../../src/services/catalogue/templateExecutionDefinition.js';
import {
  createServiceRepository,
  type CreateServicePersistenceInput,
} from "../../src/services/customerServices/createServiceRepository.js";
import { createMarketplaceSampleDownloadRepository } from "../../src/services/marketplaceSampleDownload/marketplaceSampleDownloadRepository.js";
import { createMarketplaceExpertEnquiryRepository } from "../../src/services/marketplaceExpertEnquiry/marketplaceExpertEnquiryRepository.js";

const tenantId = randomUUID();
const userId = randomUUID();
const templateId = randomUUID();
const templateVersionId = randomUUID();
const createdAt = new Date("2026-10-06T00:00:00.000Z");
const hash = Buffer.alloc(32, 1);
const definition={capability_metadata:{},request_schema:{},result_schema:{},error_schema:{},operation_code:'fixture.run',output_policy:{},commercial_config_version:'fixture',config_version:'fixture'};
type Call = { readonly sql: string; readonly values: readonly unknown[] };

function fakePool(reply: (call: Call) => readonly Record<string, unknown>[]) {
  const calls: Call[] = [];
  const release = vi.fn();
  const query = async (sql: string, values: readonly unknown[] = []) => {
    calls.push({ sql, values });
    const placeholders = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
    expect(Math.max(0, ...placeholders), "SQL parameter count").toBe(values.length);
    const context = customerContextFixture(sql, values);
    if (context !== undefined) return context;
    if (sql.includes("set_config")) return { rows: [{ organization_id: tenantId }], rowCount: 1 };
    const rows = reply({ sql, values });
    return { rows, rowCount: rows.length || 1 };
  };
  return { calls, release, pool: { connect: async () => ({ query, release }) } as unknown as Pool };
}

function serviceInput(): CreateServicePersistenceInput {
  return {
    idempotencyRecordId: randomUUID(),
    serviceId: randomUUID(),
    tenantId,
    actor: { kind: "browser", userId },
    idempotencyKey: "browser-service-key-0001",
    actorFingerprint: hash,
    requestHash: hash,
    templateSlug: "fixture-scraper",
    name: "Saved scraper",
    configuration: {},
    providerEnvironment: "test",
    requestId: randomUUID(),
    ipFingerprint: hash,
    validateConfiguration: () => ({ valid: true, schemaHash: hash }),
  };
}

function storedService(input: CreateServicePersistenceInput) {
  return {
    id: input.serviceId,
    name: input.name,
    template_slug: input.templateSlug,
    template_version: 1,
    version: 1,
    family: "scraper_library",
    state: "active",
    configuration: input.configuration,
    created_at: createdAt.toISOString(),
  };
}

function serviceReply(
  input: CreateServicePersistenceInput,
  options: { replay?: boolean; failAudit?: boolean } = {},
) {
  return (call: Call): readonly Record<string, unknown>[] => {
    if (call.sql.includes("INSERT INTO app.idempotency_records"))
      return options.replay ? [] : [{ id: input.idempotencyRecordId }];
    if (call.sql.includes("FROM app.idempotency_records"))
      return [
        {
          actor_fingerprint: hash,
          request_hash: hash,
          state: "completed",
          response_status: 201,
          resource_id: input.serviceId,
          response_body_reference: "inline_json_v1",
          response_body: storedService(input),
        },
      ];
    if (call.sql.includes("FROM app.service_templates template"))
      return [
        {
          template_id: templateId,
          template_state: "published",
          current_public_version_id: templateVersionId,
          product_family: "scraper_library",
          template_version_id: templateVersionId,
          template_version: 1,
          configuration_schema: {},
          availability_state: "available",
          published_at:createdAt,publication_approved:true,published_by:'fixture',evidence_ref:'restricted:fixture',engine:'amazon.v1',execution_definition:definition,
          definition_sha256:templateExecutionDefinitionHash(definition),dataset_bound:true,is_internal:false,
        },
      ];
    if (call.sql.includes("INSERT INTO app.services")) return [{ created_at: createdAt }];
    if (call.sql.includes("INSERT INTO app.audit_events") && options.failAudit)
      throw new Error("audit rejected");
    if (call.sql.includes("UPDATE app.idempotency_records"))
      return [{ response_body: call.values[2] }];
    return [];
  };
}

describe("browser actor persistence for 0070", () => {
  it("commits Service creator, audit actor and replay body in the admission transaction", async () => {
    const input = serviceInput();
    const fake = fakePool(serviceReply(input));
    await expect(createServiceRepository(fake.pool).persist(input)).resolves.toEqual({
      kind: "created",
      service: storedService(input),
    });
    expect(fake.calls.slice(0, 3).map((c) => c.sql)).toEqual([
      "BEGIN",
      "SET LOCAL ROLE dhumi_admission",
      "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
    ]);
    expect(fake.calls.find((c) => c.sql.includes("AS user_id, set_config"))?.values).toEqual([
      userId,
      tenantId,
    ]);
    const serviceInsert = fake.calls.find((c) => c.sql.includes("INSERT INTO app.services"));
    expect(serviceInsert?.sql).not.toContain("created_by_api_key_id");
    expect(serviceInsert?.values).toEqual([
      input.serviceId,
      tenantId,
      templateVersionId,
      input.name,
      {},
      userId,
    ]);
    const audit = fake.calls.find((c) => c.sql.includes("INSERT INTO app.audit_events"));
    expect(audit?.sql).not.toContain("actor_api_key_id");
    expect(audit?.values).toEqual([
      tenantId,
      userId,
      input.serviceId,
      input.requestId,
      hash,
      input.name,
      input.templateSlug,
      1,
      "scraper_library",
    ]);
    expect(fake.calls.filter((c) => c.sql.includes("INSERT INTO app.services"))).toHaveLength(1);
    expect(fake.calls.filter((c) => c.sql.includes("UPDATE app.idempotency_records"))).toHaveLength(
      1,
    );
    expect(fake.calls.at(-1)?.sql).toBe("COMMIT");
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it("replays a completed browser Service without a duplicate aggregate or audit", async () => {
    const input = serviceInput();
    const fake = fakePool(serviceReply(input, { replay: true }));
    await expect(createServiceRepository(fake.pool).persist(input)).resolves.toEqual({
      kind: "replay",
      service: storedService(input),
    });
    expect(
      fake.calls.some((c) =>
        /INSERT INTO app\.(services|service_versions|audit_events)/.test(c.sql),
      ),
    ).toBe(false);
    expect(fake.calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("rolls back the Service and claim when mandatory user audit fails", async () => {
    const input = serviceInput();
    const fake = fakePool(serviceReply(input, { failAudit: true }));
    await expect(createServiceRepository(fake.pool).persist(input)).rejects.toMatchObject({
      status: 500,
      code: "INTERNAL_ERROR",
    });
    expect(fake.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(
      fake.calls.some(
        (c) => c.sql === "COMMIT" || c.sql.includes("UPDATE app.idempotency_records"),
      ),
    ).toBe(false);
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it("stores the browser download actor with a shared replay claim in one transaction", async () => {
    const authorizationId = randomUUID();
    const fake = fakePool((call) =>
      call.sql.startsWith("SELECT preview.*") ? [{template_id:templateId,template_version_id:templateVersionId,sample_id:randomUUID(),sample_version:1,template_version:1}] :
      call.sql.includes("count(*)::text n") ? [{n:"0"}] :
      call.sql.includes("INSERT INTO app.marketplace_sample_downloads")
        ? [
            {
              disposition: "created",
              authorization_id: authorizationId,
              stored_state: "reserved",
              stored_object_key: "sample/copy.json",
              stored_content_type: "application/json",
              stored_file_name: "sample.json",
              stored_byte_count: 2,
              stored_checksum: hash,
              stored_record_count: 0,
              stored_download_expires_at: null,
            },
          ]
        : [],
    );
    await expect(
      createMarketplaceSampleDownloadRepository(fake.pool).reserve({
        authorizationId,
        tenantId,
        actor: { kind: "browser", userId },
        actorFingerprint: hash,
        idempotencyKey: "browser-download-key-0001",
        requestHash: hash,
        templateSlug: "fixture-sample",
        expectedSampleVersion: 1,
        format: "json",
        selectedFields: ["title"],
        projectionFingerprint: hash,
        recordLimit: 10,
        recordCount: 0,
        objectKey: "sample/copy.json",
        contentType: "application/json",
        fileName: "sample.json",
        byteCount: 2,
        checksum: hash,
        rateLimitMax: 10,
        rateWindowSeconds: 3600,
      }),
    ).resolves.toMatchObject({ kind: "created", record: { authorizationId } });
    const call = fake.calls.find((c) => c.sql.includes("INSERT INTO app.marketplace_sample_downloads"));
    expect(call?.values.slice(0, 2)).toEqual([
      authorizationId,
      tenantId,
    ]);
    expect(call?.values[3]).toBe(userId);
    expect(fake.calls.find(c=>c.sql.includes("INSERT INTO app.idempotency_records"))?.values.slice(1,6)).toEqual([tenantId,hash,"marketplace.sample_download.authorize.v1","browser-download-key-0001",hash]);
    expect(fake.calls[1]?.sql).toBe("SET LOCAL ROLE dhumi_customer_api");
    expect(fake.calls.find((c) => c.sql.includes("AS user_id, set_config"))?.values).toEqual([
      userId,
      tenantId,
    ]);
    expect(fake.calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("stores the browser enquiry actor and original replay response atomically", async () => {
    const enquiryId = randomUUID();
    const requestId = randomUUID();
    const fake = fakePool((call) =>
      call.sql.startsWith("SELECT preview.*") ? [{template_id:templateId,template_version_id:templateVersionId,sample_id:randomUUID(),sample_version:1,template_version:1}] :
      call.sql.includes("INSERT INTO app.marketplace_expert_enquiries")
        ? [
            {
              disposition: "created",
              id: enquiryId,
              state: "received",
              created_at: createdAt,
            },
          ]
        : [],
    );
    await expect(
      createMarketplaceExpertEnquiryRepository(fake.pool).create({
        enquiryId,
        tenantId,
        actor: { kind: "browser", userId },
        actorFingerprint: hash,
        idempotencyKey: "browser-enquiry-key-0001",
        requestHash: hash,
        templateSlug: "fixture-sample",
        expectedTemplateVersion: 1,
        requestId,
        ipFingerprint: hash,
      }),
    ).resolves.toMatchObject({ kind: "created", record: { enquiryId } });
    const call = fake.calls.find((c) => c.sql.includes("INSERT INTO app.marketplace_expert_enquiries"));
    expect(call?.values).toEqual([
      enquiryId,
      tenantId,
      templateVersionId,
      userId,
      requestId,
    ]);
    expect(fake.calls.some(c=>c.sql.includes('INSERT INTO app.idempotency_records'))).toBe(true);
    expect(fake.calls[1]?.sql).toBe("SET LOCAL ROLE dhumi_customer_api");
    expect(fake.calls.find((c) => c.sql.includes("AS user_id, set_config"))?.values).toEqual([
      userId,
      tenantId,
    ]);
    expect(fake.calls.at(-1)?.sql).toBe("COMMIT");
  });
});
