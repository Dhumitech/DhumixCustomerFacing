import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createRunRepository, RunAdmissionUnavailableError, RunInputRejectedError, type CreateRunPersistenceInput } from "../../src/services/admission/createRunRepository.js";
import { createRetryRunRepository, RunRetryInputRejectedError, RunRetryUnavailableError } from "../../src/services/admission/retryRunRepository.js";
import { validateSharedScraperAdmission } from "../../src/services/admission/sharedScraperAdmission.js";
import { createScraperExecutionRepository } from "../../src/services/brightdata/scrapers/scraperExecutionRepository.js";
import { scraperContractHash, type ScraperOperationContract } from "../../src/services/scrapers/scraperProcessing.js";
import { SHARED_SCRAPER_ADAPTER_CODE, SHARED_SCRAPER_ADAPTER_VERSION, SHARED_SCRAPER_ARTIFACT_DIGEST } from "../../src/services/scrapers/sharedScraperVersion.js";
import { execution } from "../helpers/sharedScraperFixture.js";

const packet = JSON.parse(readFileSync(new URL("../fixtures/scraper-operations/target.json", import.meta.url), "utf8")) as {
  contract: ScraperOperationContract; input: Record<string, unknown>;
};
const contractRow = { adapter_code: SHARED_SCRAPER_ADAPTER_CODE, adapter_digest: SHARED_SCRAPER_ARTIFACT_DIGEST,
  operation_code: packet.contract.operationCode, input_schema: packet.contract.inputSchema, output_schema: packet.contract.outputSchema,
  processing: packet.contract.processing, contract_hash: scraperContractHash(packet.contract) };
const eligible = { service_state: "active", service_version_id: "service-version", service_template_version_id: "template-version",
  template_state: "published", product_family: "scraper_library", input_schema: packet.contract.inputSchema,
  template_version_available: true, adapter_version_id: "adapter-version", adapter_enabled: true,
  adapter_code: SHARED_SCRAPER_ADAPTER_CODE,
  adapter_semantic_version: SHARED_SCRAPER_ADAPTER_VERSION,
  template_launch_evidence_id: "template-evidence", template_evidence_current: true,
  provider_mapping_id: "mapping", commercial_config_version: "fixture-only", mapping_launch_evidence_id: "mapping-evidence",
  mapping_current: true, mapping_evidence_current: true, feature_flag_id: "feature", feature_launch_evidence_id: "feature-evidence",
  feature_current: true, feature_evidence_current: true };

function database(options: { readonly value?: Readonly<Record<string, unknown>>; readonly row?: Record<string, unknown>; readonly error?: string; readonly adapterVersion?: string; readonly adapterCode?: string; readonly capacityMissing?: boolean } = {}) {
  const accepted = { run_id: execution.runId, status: "queued", accepted_at: "2026-09-18T00:00:00.000Z" };
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    let rows: readonly Record<string, unknown>[] = [];
    if (sql.includes("set_config")) rows = [{ tenant_id: values[0] }];
    else if (sql.includes("INSERT INTO app.idempotency_records")) rows = [{ id: "claim" }];
    else if (sql.includes("app.lock_run_for_retry")) rows = [{ run_id: "source", service_id: "service", validated_input: options.value ?? packet.input,
      public_status: "failed", internal_status: "UPSTREAM_FAILED", retryable: true, completed_at: new Date(), has_ambiguous_attempt: false }];
    else if (sql.includes("app.lock_service_for_run")) rows = [{ locked: true }];
    else if (sql.includes("FROM app.services AS service")) rows = [{ ...eligible,
      adapter_code: options.adapterCode ?? (options.adapterVersion === "1.1.0-pattern8-output-contracts"
        ? "bright_data.amazon.scraper_library" : SHARED_SCRAPER_ADAPTER_CODE),
      adapter_semantic_version: options.adapterVersion ?? SHARED_SCRAPER_ADAPTER_VERSION }];
    else if (sql.includes("app.resolve_shared_scraper_admission_contract")) {
      if (options.error) throw Object.assign(new Error("private database reason"), { code: options.error });
      rows = [options.row ?? contractRow];
    } else if (sql.includes("app.require_phase5_mock_run_capacity") || sql.includes("app.require_shared_scraper_run_capacity"))
      rows = options.capacityMissing ? [] : [{ estimated_amount_micros: 1, currency_code: "USD", unit: "fixture", evidence_reference: "fixture-only" }];
    else if (sql.includes("INSERT INTO app.runs")) rows = [{ accepted_at: new Date(accepted.accepted_at) }];
    else if (sql.includes("UPDATE app.idempotency_records")) rows = [{ response_body: accepted }];
    return { rows, rowCount: rows.length, fields: [], command: "", oid: 0 };
  });
  const release = vi.fn();
  const pool = { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool;
  const validateInput = vi.fn(() => ({ valid: true as const }));
  const input: CreateRunPersistenceInput = {
    ...execution, idempotencyRecordId: "claim", runEventId: "event", providerCostHoldId: "hold", outboxEventId: "outbox",
    actor: { kind: "browser", userId: "user" }, actorFingerprint: Buffer.alloc(32), requestHash: Buffer.alloc(32),
    idempotencyKey: "fixture-key", serviceId: "service", input: options.value ?? packet.input,
    providerEnvironment: "test", requestId: null, ipFingerprint: null, validateInput,
  };
  return { pool, query, release, input, validateInput };
}

describe("shared scraper pre-admission and fenced readers", () => {
  it.each(["create", "retry"] as const)("rejects invalid URLs during %s before capacity, Run or outbox admission", async (operation) => {
    const fake = database({ value: { targets: [{ url: "https://attacker.example/p/product", zipcode: "01011" }] } });
    const persisted = operation === "create" ? createRunRepository(fake.pool).persist(fake.input)
      : createRetryRunRepository(fake.pool).persist({ ...fake.input, sourceRunId: "source" });
    await expect(persisted).rejects.toBeInstanceOf(operation === "create" ? RunInputRejectedError : RunRetryInputRejectedError);
    expect(fake.validateInput).not.toHaveBeenCalled();
    const statements = fake.query.mock.calls.map(([sql]) => sql);
    expect(statements.some((sql) => /require_(phase5_mock|shared_scraper_run)_capacity|INSERT INTO app\.(runs|provider_cost_holds|outbox_events)/.test(sql))).toBe(false);
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(fake.release).toHaveBeenCalledOnce();
  });
  it.each(["create", "retry"] as const)("fails %s closed when a contract reader has not been activated", async (operation) => {
    const fake = database({ error: "42883" });
    const persisted = operation === "create" ? createRunRepository(fake.pool).persist(fake.input)
      : createRetryRunRepository(fake.pool).persist({ ...fake.input, sourceRunId: "source" });
    await expect(persisted).rejects.toBeInstanceOf(operation === "create" ? RunAdmissionUnavailableError : RunRetryUnavailableError);
    expect(fake.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO app.runs"))).toBe(false);
    expect(fake.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });
  it("accepts valid shared input within the existing single atomic admission transaction", async () => {
    const fake = database();
    await expect(createRunRepository(fake.pool).persist(fake.input)).resolves.toMatchObject({ kind: "created" });
    expect(fake.validateInput).not.toHaveBeenCalled();
    const statements = fake.query.mock.calls.map(([sql]) => sql);
    expect(statements[0]).toBe("BEGIN");
    expect(statements[1]).toBe("SET LOCAL ROLE dhumi_admission");
    expect(statements.at(-1)).toBe("COMMIT");
    expect(statements.filter((sql) => sql.includes("resolve_shared_scraper_admission_contract"))).toHaveLength(1);
    expect(statements.filter((sql) => sql.includes("require_shared_scraper_run_capacity"))).toHaveLength(1);
    expect(statements.some((sql) => sql.includes("require_phase5_mock_run_capacity"))).toBe(false);
    expect(statements.filter((sql) => sql.includes("INSERT INTO app.outbox_events"))).toHaveLength(1);
    expect(statements.findIndex((sql) => sql.includes("resolve_shared_scraper_admission_contract")))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("require_shared_scraper_run_capacity")));
  });
  it.each(["create", "retry"] as const)("does not create %s work when approved capacity is missing", async (operation) => {
    const fake = database({ capacityMissing: true });
    const persisted = operation === "create" ? createRunRepository(fake.pool).persist(fake.input)
      : createRetryRunRepository(fake.pool).persist({ ...fake.input, sourceRunId: "source" });
    await expect(persisted).rejects.toBeInstanceOf(operation === "create" ? RunAdmissionUnavailableError : RunRetryUnavailableError);
    expect(fake.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO app.runs"))).toBe(false);
    expect(fake.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO app.outbox_events"))).toBe(false);
  });
  it.each(["create", "retry"] as const)("rejects an unknown shared-protocol %s version before the legacy zero-cost path", async (operation) => {
    const fake = database({ adapterVersion: "2.0.0-unreviewed" });
    const persisted = operation === "create" ? createRunRepository(fake.pool).persist(fake.input)
      : createRetryRunRepository(fake.pool).persist({ ...fake.input, sourceRunId: "source" });
    await expect(persisted).rejects.toBeInstanceOf(operation === "create" ? RunAdmissionUnavailableError : RunRetryUnavailableError);
    expect(fake.query.mock.calls.some(([sql]) => sql.includes("require_phase5_mock_run_capacity"))).toBe(false);
    expect(fake.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO app.runs"))).toBe(false);
  });
  it("keeps legacy validation without an additional contract query", async () => {
    const fake = database({ adapterVersion: "1.1.0-pattern8-output-contracts" });
    await createRunRepository(fake.pool).persist(fake.input);
    expect(fake.validateInput).toHaveBeenCalledOnce();
    expect(fake.query.mock.calls.some(([sql]) => sql.includes("resolve_shared_scraper_admission_contract"))).toBe(false);
    expect(fake.query.mock.calls.some(([sql]) => sql.includes("require_phase5_mock_run_capacity"))).toBe(true);
  });
  it("uses adapter code, not a coincidentally matching semantic version, for dispatch", async () => {
    const fake = database({ adapterCode: "another.provider.adapter",
      adapterVersion: SHARED_SCRAPER_ADAPTER_VERSION });
    await createRunRepository(fake.pool).persist(fake.input);
    expect(fake.validateInput).toHaveBeenCalledOnce();
    expect(fake.query.mock.calls.some(([sql]) => sql.includes("resolve_shared_scraper_admission_contract"))).toBe(false);
    expect(fake.query.mock.calls.some(([sql]) => sql.includes("require_phase5_mock_run_capacity"))).toBe(true);
  });
  it("checks the exact digest and immutable hash before accepting input", async () => {
    for (const row of [{ ...contractRow, adapter_digest: "ff".repeat(32) }, { ...contractRow, contract_hash: "ff".repeat(32) }]) {
      const fake = database({ row });
      await expect(createRunRepository(fake.pool).persist(fake.input)).rejects.toBeInstanceOf(RunAdmissionUnavailableError);
      expect(fake.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO app.runs"))).toBe(false);
    }
  });
  it("does not query the database for a legacy processing version", async () => {
    const query = vi.fn();
    await expect(validateSharedScraperAdmission({ query }, { adapterCode: "bright_data.amazon.scraper_library",
      adapterVersion: "legacy", templateVersionId: "v", mappingId: "m", value: {} }))
      .resolves.toMatchObject({ valid: true });
    expect(query).not.toHaveBeenCalled();
  });
  it("resolves identity once with Tenant-local role, Run, Attempt and exact fence", async () => {
    const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => ({ rows: sql.includes("set_config") ? [{ tenant_id: values[0] }]
      : sql.includes("resolve_provider_executor_identity") ? [{ adapter_code: SHARED_SCRAPER_ADAPTER_CODE, adapter_version: SHARED_SCRAPER_ADAPTER_VERSION, adapter_digest: "aa".repeat(32) }]
      : [], rowCount: 0 }));
    const release = vi.fn();
    const pool = { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool;
    const fenced = { checkpointPoll: vi.fn(), recordProviderReference: vi.fn(), isCancellationRequested: vi.fn() };
    await expect(createScraperExecutionRepository(pool, fenced).resolveIdentity(execution)).resolves.toMatchObject({ digest: "aa".repeat(32) });
    expect(query.mock.calls[1]?.[0]).toBe("SET LOCAL ROLE dhumi_job_manager");
    expect(query.mock.calls[2]?.[1]).toEqual([execution.tenantId]);
    expect(query.mock.calls[3]?.[1]).toEqual([execution.runId, execution.attemptId, execution.fenceToken]);
    expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });
});
