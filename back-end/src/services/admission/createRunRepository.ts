import type { Pool } from "pg";
import type { DatabaseExecutor } from "../../types/database.js";
import { ApplicationError } from "../../utils/applicationError.js";
import { withAdmissionTenantTransaction } from "../database/transactions.js";
import type { ProviderEnvironment } from "../customerServices/createServiceRepository.js";
import { validateSharedScraperAdmission } from "./sharedScraperAdmission.js";
import { selectRunCapacity } from "./runCapacity.js";
import { ScraperContractError } from "../scrapers/scraperProcessing.js";
import { SHARED_SCRAPER_ADAPTER_CODE, SHARED_SCRAPER_ADAPTER_VERSION } from "../scrapers/sharedScraperVersion.js";
import {
  isRunAdmissionReleaseAvailable,
  selectRunAdmissionEligibility,
  type RunAdmissionEligibility,
} from "./runAdmissionEligibility.js";

export interface RunAccepted {
  readonly run_id: string;
  readonly status: "queued";
  readonly accepted_at: string;
}

export interface RunInputValidationInput {
  readonly templateVersionId: string;
  readonly schema: unknown;
  readonly input: Readonly<Record<string, unknown>>;
}

export type RunInputValidationOutcome =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly issues: readonly { readonly field: string; readonly message: string }[];
    };

export interface CreateRunPersistenceInput {
  readonly idempotencyRecordId: string;
  readonly runId: string;
  readonly runEventId: string;
  readonly providerCostHoldId: string;
  readonly outboxEventId: string;
  readonly tenantId: string;
  readonly actor:
    | { readonly kind: "browser"; readonly userId: string }
    | { readonly kind: "api_key"; readonly apiKeyId: string };
  readonly actorFingerprint: Buffer;
  readonly requestHash: Buffer;
  readonly idempotencyKey: string;
  readonly serviceId: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly providerEnvironment: ProviderEnvironment;
  readonly requestId: string | null;
  readonly ipFingerprint: Buffer | null;
  readonly validateInput: (input: RunInputValidationInput) => RunInputValidationOutcome;
}

export type CreateRunPersistenceOutcome =
  | { readonly kind: "created"; readonly run: RunAccepted }
  | { readonly kind: "replay"; readonly run: RunAccepted }
  | { readonly kind: "conflict" };

export interface CreateRunRepository {
  persist(input: CreateRunPersistenceInput): Promise<CreateRunPersistenceOutcome>;
}

export class RunServiceNotFoundError extends Error {
  public constructor() {
    super("The selected Service was not found");
    this.name = "RunServiceNotFoundError";
  }
}

export class RunServiceStateConflictError extends Error {
  public constructor() {
    super("The selected Service cannot accept Runs");
    this.name = "RunServiceStateConflictError";
  }
}

export class RunInputRejectedError extends Error {
  public readonly issues: readonly { readonly field: string; readonly message: string }[];

  public constructor(issues: readonly { readonly field: string; readonly message: string }[]) {
    super("The Run input was rejected");
    this.name = "RunInputRejectedError";
    this.issues = issues;
  }
}

export class RunCapacityExceededError extends Error {
  public constructor(cause?: unknown) {
    super("Run admission capacity is exhausted", { cause });
    this.name = "RunCapacityExceededError";
  }
}

export class RunAdmissionUnavailableError extends Error {
  public constructor(cause?: unknown) {
    super("Run admission is unavailable", { cause });
    this.name = "RunAdmissionUnavailableError";
  }
}

interface ClaimRow {
  readonly id: string;
}

interface ExistingClaimRow {
  readonly actor_fingerprint: Buffer;
  readonly request_hash: Buffer;
  readonly state: "in_progress" | "completed" | "failed";
  readonly response_status: number | null;
  readonly resource_id: string | null;
  readonly response_body_reference: string | null;
  readonly response_body: unknown;
}

interface AcceptedAtRow {
  readonly accepted_at: Date;
}

interface ResponseBodyRow {
  readonly response_body: unknown;
}

function databaseErrorField(error: unknown, field: "code" | "constraint"): string | undefined {
  if (typeof error !== "object" || error === null || !(field in error)) return undefined;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function internalFailure(cause: unknown): ApplicationError {
  return new ApplicationError({
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Internal server error",
    cause,
  });
}

function isRunAccepted(value: unknown): value is RunAccepted {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const run = value as Record<string, unknown>;
  return (
    Object.keys(run).length === 3 &&
    typeof run.run_id === "string" &&
    run.status === "queued" &&
    typeof run.accepted_at === "string"
  );
}

async function insertClaim(
  database: DatabaseExecutor,
  input: CreateRunPersistenceInput,
): Promise<boolean> {
  const result = await database.query<ClaimRow>(
    `
      INSERT INTO app.idempotency_records (
        id,
        tenant_id,
        scope_kind,
        actor_fingerprint,
        operation_code,
        idempotency_key,
        request_hash,
        state,
        expires_at
      ) VALUES (
        $1, $2, 'tenant', $3, 'runs.create', $4, $5, 'in_progress',
        clock_timestamp() + interval '24 hours'
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `,
    [
      input.idempotencyRecordId,
      input.tenantId,
      input.actorFingerprint,
      input.idempotencyKey,
      input.requestHash,
    ],
  );
  return result.rows[0] !== undefined;
}

async function replayExistingClaim(
  database: DatabaseExecutor,
  input: CreateRunPersistenceInput,
): Promise<CreateRunPersistenceOutcome> {
  const result = await database.query<ExistingClaimRow>(
    `
      SELECT
        actor_fingerprint,
        request_hash,
        state,
        response_status,
        resource_id,
        response_body_reference,
        response_body
      FROM app.idempotency_records
      WHERE tenant_id = $1
        AND operation_code = 'runs.create'
        AND idempotency_key = $2
      FOR UPDATE
    `,
    [input.tenantId, input.idempotencyKey],
  );
  const existing = result.rows[0];
  if (existing === undefined) {
    throw new RunAdmissionUnavailableError(
      new Error("A conflicting Run idempotency claim was not visible"),
    );
  }
  if (
    !existing.actor_fingerprint.equals(input.actorFingerprint) ||
    !existing.request_hash.equals(input.requestHash)
  ) {
    return { kind: "conflict" };
  }
  if (
    existing.state !== "completed" ||
    existing.response_status !== 202 ||
    existing.resource_id === null ||
    existing.response_body_reference !== "inline_json_v1" ||
    !isRunAccepted(existing.response_body) ||
    existing.response_body.run_id !== existing.resource_id
  ) {
    throw new RunAdmissionUnavailableError(
      new Error("The Run idempotency claim is not replayable"),
    );
  }
  return { kind: "replay", run: existing.response_body };
}

async function selectEligibility(
  database: DatabaseExecutor,
  input: CreateRunPersistenceInput,
): Promise<RunAdmissionEligibility> {
  const row = await selectRunAdmissionEligibility(
    database,
    input.tenantId,
    input.serviceId,
    input.providerEnvironment,
  );
  if (row === undefined) throw new RunServiceNotFoundError();
  return row;
}

function requireEligible(row: RunAdmissionEligibility): void {
  if (row.service_state !== "active") throw new RunServiceStateConflictError();
  if (!isRunAdmissionReleaseAvailable(row)) throw new RunAdmissionUnavailableError();
}

async function createAndComplete(
  database: DatabaseExecutor,
  input: CreateRunPersistenceInput,
): Promise<RunAccepted> {
  const eligible = await selectEligibility(database, input);
  requireEligible(eligible);
  const isSharedScraper = eligible.adapter_code === SHARED_SCRAPER_ADAPTER_CODE;
  if (isSharedScraper &&
    eligible.adapter_semantic_version !== SHARED_SCRAPER_ADAPTER_VERSION) {
    throw new RunAdmissionUnavailableError(new Error("The shared scraper adapter version is not supported"));
  }
  if (!isSharedScraper) {
    const validation = input.validateInput({
      templateVersionId: eligible.service_template_version_id as string,
      schema: eligible.input_schema,
      input: input.input,
    });
    if (!validation.valid) throw new RunInputRejectedError(validation.issues);
  }

  try {
    const sharedValidation = await validateSharedScraperAdmission(database, {
      adapterCode: eligible.adapter_code,
      adapterVersion: eligible.adapter_semantic_version,
      templateVersionId: eligible.service_template_version_id as string,
      mappingId: eligible.provider_mapping_id as string,
      value: input.input,
    });
    if (!sharedValidation.valid) throw new RunInputRejectedError(sharedValidation.issues);
  } catch (error) {
    if (error instanceof ScraperContractError) throw new RunAdmissionUnavailableError(error);
    throw error;
  }

  let capacity;
  try {
    capacity = await selectRunCapacity(database, {
      adapterCode: eligible.adapter_code,
      adapterVersion: eligible.adapter_semantic_version,
      providerEnvironment: input.providerEnvironment,
      templateVersionId: eligible.service_template_version_id as string,
      mappingId: eligible.provider_mapping_id as string,
      validatedInput: input.input,
    });
  } catch (error) {
    if (error instanceof ScraperContractError) throw new RunAdmissionUnavailableError(error);
    throw error;
  }
  if (capacity === undefined) {
    throw new RunAdmissionUnavailableError(
      new Error("The Run capacity profile returned no hold metadata"),
    );
  }

  const runInsert = await database.query<AcceptedAtRow>(
    `
      INSERT INTO app.runs (
        id,
        tenant_id,
        service_version_id,
        service_template_version_id,
        adapter_version_id,
        provider_mapping_id,
        commercial_config_version,
        validated_input,
        template_launch_evidence_id,
        mapping_launch_evidence_id,
        feature_flag_id,
        feature_launch_evidence_id,
        public_status,
        internal_status,
        state_version,
        retryable
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12,
        'queued', 'QUEUED', 1, false
      )
      RETURNING accepted_at
    `,
    [
      input.runId,
      input.tenantId,
      eligible.service_version_id,
      eligible.service_template_version_id,
      eligible.adapter_version_id,
      eligible.provider_mapping_id,
      eligible.commercial_config_version,
      input.input,
      eligible.template_launch_evidence_id,
      eligible.mapping_launch_evidence_id,
      eligible.feature_flag_id,
      eligible.feature_launch_evidence_id,
    ],
  );
  const acceptedAt = runInsert.rows[0]?.accepted_at;
  if (acceptedAt === undefined) throw new Error("The Run insert returned no timestamp");

  await database.query(
    `
      INSERT INTO app.provider_cost_holds (
        id,
        tenant_id,
        run_id,
        provider_code,
        product_family,
        commercial_config_version,
        evidence_reference,
        estimated_amount_micros,
        currency_code,
        unit,
        state
      ) VALUES ($1, $2, $3, 'bright_data', $4, $5, $6, $7, $8, $9, 'held')
    `,
    [
      input.providerCostHoldId,
      input.tenantId,
      input.runId,
      eligible.product_family,
      eligible.commercial_config_version,
      capacity.evidence_reference,
      capacity.estimated_amount_micros,
      capacity.currency_code,
      capacity.unit,
    ],
  );

  await database.query(
    `
      INSERT INTO app.run_events (
        id,
        tenant_id,
        run_id,
        sequence,
        event_type,
        source,
        event_idempotency_key,
        safe_payload
      ) VALUES ($1, $2, $3, 1, 'accepted', 'admission', 'admission.accepted.v1', $4::jsonb)
    `,
    [input.runEventId, input.tenantId, input.runId, { status: "queued" }],
  );

  await database.query(
    `
      INSERT INTO app.audit_events (
        tenant_id,
        actor_user_id,
        actor_api_key_id,
        action,
        target_type,
        target_id,
        outcome,
        request_id,
        ip_fingerprint,
        safe_diff
      ) VALUES (
        $1, $2, $3, 'run.create', 'run', $4, 'accepted', $5, $6,
        jsonb_build_object(
          'operation', 'runs.create',
          'status', 'queued',
          'product_family', $7::text
        )
      )
    `,
    [
      input.tenantId,
      input.actor.kind === "browser" ? input.actor.userId : null,
      input.actor.kind === "api_key" ? input.actor.apiKeyId : null,
      input.runId,
      input.requestId,
      input.ipFingerprint,
      eligible.product_family,
    ],
  );

  await database.query(
    `
      INSERT INTO app.outbox_events (
        id,
        aggregate_type,
        aggregate_id,
        tenant_id,
        topic,
        ordering_key,
        payload,
        schema_version
      ) VALUES (
        $1::uuid,
        'run',
        $2::uuid,
        $3::uuid,
        'jobs.execute',
        ($2::uuid)::text,
        $4::jsonb,
        1
      )
    `,
    [input.outboxEventId, input.runId, input.tenantId, { run_id: input.runId }],
  );

  const response: RunAccepted = {
    run_id: input.runId,
    status: "queued",
    accepted_at: acceptedAt.toISOString(),
  };
  const completion = await database.query<ResponseBodyRow>(
    `
      UPDATE app.idempotency_records
      SET
        state = 'completed',
        response_status = 202,
        resource_type = 'run',
        resource_id = $2,
        response_body_reference = 'inline_json_v1',
        response_body = $3::jsonb,
        completed_at = clock_timestamp(),
        updated_at = clock_timestamp()
      WHERE id = $1
      RETURNING response_body
    `,
    [input.idempotencyRecordId, input.runId, response],
  );
  const stored = completion.rows[0]?.response_body;
  if (!isRunAccepted(stored) || stored.run_id !== input.runId) {
    throw new Error("The Run replay body could not be completed");
  }
  return stored;
}

export function createRunRepository(pool: Pool): CreateRunRepository {
  return {
    async persist(input): Promise<CreateRunPersistenceOutcome> {
      try {
        return await withAdmissionTenantTransaction(pool, input.tenantId, async (database) => {
          if (!(await insertClaim(database, input))) {
            return replayExistingClaim(database, input);
          }
          const run = await createAndComplete(database, input);
          return { kind: "created", run };
        });
      } catch (error) {
        if (
          error instanceof ApplicationError ||
          error instanceof RunServiceNotFoundError ||
          error instanceof RunServiceStateConflictError ||
          error instanceof RunInputRejectedError ||
          error instanceof RunCapacityExceededError ||
          error instanceof RunAdmissionUnavailableError
        ) {
          throw error;
        }
        const code = databaseErrorField(error, "code");
        if (code === "P5101" || code === "P5102") {
          throw new RunCapacityExceededError(error);
        }
        if (code === "P5103" || code === "P5104") {
          throw new RunAdmissionUnavailableError(error);
        }
        throw internalFailure(error);
      }
    },
  };
}
