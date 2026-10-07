import { RUN_PUBLIC_STATUS_SQL } from "../../helpers/runPublicStatus.js";
import type { Pool } from "pg";
import { validateSharedScraperAdmission } from "./sharedScraperAdmission.js";
import { selectRunCapacity } from "./runCapacity.js";
import { ScraperContractError } from "../scrapers/scraperProcessing.js";
import type { DatabaseExecutor } from "../../types/database.js";
import { ApplicationError } from "../../utils/applicationError.js";
import { withAdmissionOrganizationTransaction } from "../database/transactions.js";
import type { ProviderEnvironment } from "../customerServices/createServiceRepository.js";
import type {
  RunAccepted,
  RunInputValidationInput,
  RunInputValidationOutcome,
} from "./createRunRepository.js";
import {
  isRunAdmissionReleaseAvailable,
  selectRunAdmissionEligibility,
  type RunAdmissionEligibility,
} from "./runAdmissionEligibility.js";

export interface RetryRunPersistenceInput {
  readonly idempotencyRecordId: string;
  readonly runId: string;
  readonly runEventId: string;
  readonly outboxEventId: string;
  readonly tenantId: string;
  readonly actor: { readonly kind: "browser"; readonly userId: string };
  readonly actorFingerprint: Buffer;
  readonly requestHash: Buffer;
  readonly idempotencyKey: string;
  readonly sourceRunId: string;
  readonly providerEnvironment: ProviderEnvironment;
  readonly requestId: string | null;
  readonly ipFingerprint: Buffer | null;
  readonly validateInput: (input: RunInputValidationInput) => RunInputValidationOutcome;
}

export type RetryRunPersistenceOutcome =
  | { readonly kind: "created"; readonly run: RunAccepted }
  | { readonly kind: "replay"; readonly run: RunAccepted }
  | { readonly kind: "conflict" };

export interface RetryRunRepository {
  persist(input: RetryRunPersistenceInput): Promise<RetryRunPersistenceOutcome>;
}

export class RunRetryNotFoundError extends Error {
  public constructor() {
    super("The selected Run was not found");
    this.name = "RunRetryNotFoundError";
  }
}

export class RunRetryStateConflictError extends Error {
  public constructor(cause?: unknown) {
    super("The selected Run cannot be retried in its current state", { cause });
    this.name = "RunRetryStateConflictError";
  }
}

export class RunRetryInputRejectedError extends Error {
  public readonly issues: readonly { readonly field: string; readonly message: string }[];

  public constructor(issues: readonly { readonly field: string; readonly message: string }[]) {
    super("The retry input was rejected");
    this.name = "RunRetryInputRejectedError";
    this.issues = issues;
  }
}

export class RunRetryCapacityExceededError extends Error {
  public constructor(cause?: unknown) {
    super("Run retry capacity is exhausted", { cause });
    this.name = "RunRetryCapacityExceededError";
  }
}

export class RunRetryUnavailableError extends Error {
  public constructor(cause?: unknown) {
    super("Run retry is unavailable", { cause });
    this.name = "RunRetryUnavailableError";
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
  readonly related_resource_id: string | null;
  readonly response_body_reference: string | null;
  readonly response_body: unknown;
}

interface LockedSourceRow {
  readonly run_id: string;
  readonly service_id: string;
  readonly validated_input: unknown;
  readonly public_status: string;
  readonly internal_status: string;
  readonly retryable: boolean;
  readonly completed_at: Date | null;
  readonly has_ambiguous_attempt: boolean;
}

interface AcceptedAtRow {
  readonly created_at: Date;
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

function isInputObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function insertClaim(
  database: DatabaseExecutor,
  input: RetryRunPersistenceInput,
): Promise<boolean> {
  const result = await database.query<ClaimRow>(
    `
      INSERT INTO app.idempotency_records (
        id,
        organization_id,
        actor_fingerprint,
        operation_code,
        idempotency_key,
        request_hash,
        state,
        expires_at
      ) VALUES (
        $1, $2, $3, 'runs.retry', $4, $5, 'in_progress',
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
  input: RetryRunPersistenceInput,
): Promise<RetryRunPersistenceOutcome> {
  const result = await database.query<ExistingClaimRow>(
    `
      SELECT
        actor_fingerprint,
        request_hash,
        state,
        response_status,
        resource_id,
        related_resource_id,
        response_body_reference,
        response_body
      FROM app.idempotency_records
      WHERE organization_id = $1
        AND operation_code = 'runs.retry'
        AND idempotency_key = $2
      FOR UPDATE
    `,
    [input.tenantId, input.idempotencyKey],
  );
  const existing = result.rows[0];
  if (existing === undefined) {
    throw new RunRetryUnavailableError(
      new Error("A conflicting retry idempotency claim was not visible"),
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
    existing.related_resource_id !== input.sourceRunId ||
    existing.response_body_reference !== "inline_json_v1" ||
    !isRunAccepted(existing.response_body) ||
    existing.response_body.run_id !== existing.resource_id
  ) {
    throw new RunRetryUnavailableError(new Error("The retry idempotency claim is not replayable"));
  }
  return { kind: "replay", run: existing.response_body };
}

async function lockSource(
  database: DatabaseExecutor,
  input: RetryRunPersistenceInput,
): Promise<LockedSourceRow> {
  const result=await database.query<LockedSourceRow>(`
    SELECT run.id AS run_id,run.service_id,run.validated_input,${RUN_PUBLIC_STATUS_SQL} AS public_status,
      run.internal_status,run.retryable,run.completed_at,false AS has_ambiguous_attempt
    FROM app.runs run WHERE run.organization_id=$1 AND run.id=$2 FOR UPDATE OF run`,[input.tenantId,input.sourceRunId]);
  const attempts=await database.query<{state:string}>(`SELECT state FROM app.run_attempts WHERE organization_id=$1 AND run_id=$2 ORDER BY id FOR UPDATE`,[input.tenantId,input.sourceRunId]);
  const source = result.rows[0];
  if (source === undefined) throw new RunRetryNotFoundError();
  if (
    source.public_status !== "failed" ||
    !["UPSTREAM_REJECTED", "UPSTREAM_FAILED", "PROCESSING_FAILED"].includes(
      source.internal_status,
    ) ||
    source.retryable !== true ||
    source.completed_at === null ||
    attempts.rows.some(attempt=>attempt.state==='ambiguous')
  ) {
    throw new RunRetryStateConflictError();
  }
  if (!isInputObject(source.validated_input)) {
    throw new RunRetryUnavailableError(new Error("The source Run input is not an object"));
  }
  return source;
}

function requireCurrentRelease(row: RunAdmissionEligibility | undefined): RunAdmissionEligibility {
  if (row === undefined) {
    throw new RunRetryUnavailableError(new Error("The source Run Service could not be resolved"));
  }
  if (row.service_state !== "active") throw new RunRetryStateConflictError();
  if (!isRunAdmissionReleaseAvailable(row)) throw new RunRetryUnavailableError();
  return row;
}

async function createAndComplete(
  database: DatabaseExecutor,
  input: RetryRunPersistenceInput,
): Promise<RunAccepted> {
  const source = await lockSource(database, input);
  const eligible = requireCurrentRelease(
    await selectRunAdmissionEligibility(
      database,
      input.tenantId,
      source.service_id,
      input.providerEnvironment,
    ),
  );
  const sourceInput = source.validated_input as Readonly<Record<string, unknown>>;
  if (eligible.engine !== 'scraper.v1') {
    const validation=input.validateInput({templateVersionId:eligible.template_version_id,schema:eligible.input_schema,input:sourceInput});
    if(!validation.valid)throw new RunRetryInputRejectedError(validation.issues);
  }
  try {
    const validation=validateSharedScraperAdmission({engine:eligible.engine,definition:eligible.execution_definition,value:sourceInput});
    if(!validation.valid)throw new RunRetryInputRejectedError(validation.issues);
  } catch(error) { if(error instanceof ScraperContractError)throw new RunRetryUnavailableError(error);throw error; }
  const capacity=await selectRunCapacity(database,{engine:eligible.engine,definition:eligible.execution_definition,
    providerEnvironment:input.providerEnvironment,tenantId:input.tenantId,templateVersionId:eligible.template_version_id,validatedInput:sourceInput});

  const runInsert=await database.query<AcceptedAtRow>(`
    INSERT INTO app.runs (id,organization_id,service_id,template_version_id,created_by_user_id,trace_id,
      commercial_config_version,validated_input,estimated_cost_micros,retry_of_run_id)
    VALUES ($1,$2,$3,$4,$5,$6::uuid,$7,$8::jsonb,$9,$10) RETURNING created_at`,
    [input.runId,input.tenantId,source.service_id,eligible.template_version_id,input.actor.userId,input.requestId,
      eligible.execution_definition.commercial_config_version,sourceInput,capacity.estimated_amount_micros,input.sourceRunId]);
  const acceptedAt=runInsert.rows[0]?.created_at;
  if(!acceptedAt)throw new Error('Run admission returned no timestamp');

  await database.query(
    `
      INSERT INTO app.run_events (
        id,
        organization_id,
        run_id,
        sequence,
        event_type,
        event_idempotency_key,
        safe_payload
      ) VALUES ($1, $2, $3, 1, 'accepted', 'admission.accepted.v1', $4::jsonb)
    `,
    [input.runEventId, input.tenantId, input.runId, { status: "queued" }],
  );

  await database.query(
    `
      INSERT INTO app.audit_events (
        organization_id,
        actor_user_id,
        action,
        target_type,
        target_id,
        outcome,
        trace_id,
        ip_fingerprint,
        safe_diff
      ) VALUES (
        $1, $2, 'run.retry', 'run', $3, 'accepted', $4::uuid, $5,
        jsonb_build_object(
          'operation', 'runs.retry',
          'retry_of_run_id', $6::uuid,
          'status', 'queued',
          'product_family', $7::text
        )
      )
    `,
    [
      input.tenantId,
      input.actor.userId,
      input.runId,
      input.requestId,
      input.ipFingerprint,
      input.sourceRunId,
      eligible.product_family,
    ],
  );

  await database.query(
    `
      INSERT INTO app.outbox_events (
        id,
        aggregate_type,
        aggregate_id,
        organization_id,
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
    [input.outboxEventId, input.runId, input.tenantId, { run_id: input.runId,trace_id:input.requestId }],
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
        related_resource_id = $3,
        response_body_reference = 'inline_json_v1',
        response_body = $4::jsonb,
        completed_at = clock_timestamp()
      WHERE id = $1
      RETURNING response_body
    `,
    [input.idempotencyRecordId, input.runId, input.sourceRunId, response],
  );
  const stored = completion.rows[0]?.response_body;
  if (!isRunAccepted(stored) || stored.run_id !== input.runId) {
    throw new Error("The retry replay body could not be completed");
  }
  return stored;
}

export function createRetryRunRepository(pool: Pool): RetryRunRepository {
  return {
    async persist(input): Promise<RetryRunPersistenceOutcome> {
      try {
        return await withAdmissionOrganizationTransaction(
          pool,
          { tenantId: input.tenantId, userId: input.actor.userId },
          async (database) => {
            if(!input.requestId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId))throw new RunRetryUnavailableError();
            if (!(await insertClaim(database, input))) {
              return replayExistingClaim(database, input);
            }
            const run = await createAndComplete(database, input);
            return { kind: "created", run };
          },
        );
      } catch (error) {
        if (
          error instanceof ApplicationError ||
          error instanceof RunRetryNotFoundError ||
          error instanceof RunRetryStateConflictError ||
          error instanceof RunRetryInputRejectedError ||
          error instanceof RunRetryCapacityExceededError ||
          error instanceof RunRetryUnavailableError
        ) {
          throw error;
        }
        const code = databaseErrorField(error, "code");
        if (code === "P5101" || code === "P5102") {
          throw new RunRetryCapacityExceededError(error);
        }
        if (code === "P5201") throw new RunRetryStateConflictError(error);
        if (code === "P5103" || code === "P5104" || code === "P5202") {
          throw new RunRetryUnavailableError(error);
        }
        throw internalFailure(error);
      }
    },
  };
}
