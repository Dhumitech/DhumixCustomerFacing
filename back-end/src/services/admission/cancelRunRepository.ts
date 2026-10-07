import { RUN_PUBLIC_STATUS_SQL } from "../../helpers/runPublicStatus.js";
import type { Pool } from "pg";
import type { DatabaseExecutor } from "../../types/database.js";
import { ApplicationError } from "../../utils/applicationError.js";
import { withAdmissionOrganizationTransaction } from "../database/transactions.js";
import type { Run } from "../runQuery/listRunsService.js";

export interface CancelRunPersistenceInput {
  readonly idempotencyRecordId: string;
  readonly runEventId: string;
  readonly outboxEventId: string;
  readonly tenantId: string;
  readonly actor: { readonly kind: "browser"; readonly userId: string };
  readonly actorFingerprint: Buffer;
  readonly requestHash: Buffer;
  readonly idempotencyKey: string;
  readonly runId: string;
  readonly requestId: string | null;
  readonly ipFingerprint: Buffer | null;
}

export type CancelRunPersistenceOutcome =
  | { readonly kind: "accepted"; readonly run: Run }
  | { readonly kind: "accepted_existing"; readonly run: Run }
  | { readonly kind: "replay"; readonly run: Run }
  | { readonly kind: "conflict" };

export interface CancelRunRepository {
  persist(input: CancelRunPersistenceInput): Promise<CancelRunPersistenceOutcome>;
}

export class RunCancellationNotFoundError extends Error {
  public constructor() {
    super("The selected Run was not found");
    this.name = "RunCancellationNotFoundError";
  }
}

export class RunCancellationStateConflictError extends Error {
  public constructor() {
    super("The selected Run cannot be cancelled in its current state");
    this.name = "RunCancellationStateConflictError";
  }
}

export class RunCancellationUnavailableError extends Error {
  public constructor(cause?: unknown) {
    super("Run cancellation is unavailable", { cause });
    this.name = "RunCancellationUnavailableError";
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

interface LockedRunRow {
  readonly run_id: string;
  readonly service_id: string;
  readonly public_status: string;
  readonly internal_status: string;
  readonly customer_error_code: string | null;
  readonly retryable: boolean;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly completed_at: Date | null;
  readonly next_event_sequence: string | number;
  readonly cancellation_requested: boolean;
}

interface ResponseBodyRow {
  readonly response_body: unknown;
}

function internalFailure(cause: unknown): ApplicationError {
  return new ApplicationError({
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Internal server error",
    cause,
  });
}

function isPublicRun(value: unknown): value is Run {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const run = value as Record<string, unknown>;
  return (
    Object.keys(run).length === 8 &&
    typeof run.id === "string" &&
    typeof run.service_id === "string" &&
    (run.status === "queued" || run.status === "running") &&
    run.error_code === null &&
    run.retryable === false &&
    typeof run.created_at === "string" &&
    typeof run.updated_at === "string" &&
    run.completed_at === null
  );
}

function eventSequence(value: string | number): string {
  const normalized = String(value);
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new RunCancellationUnavailableError(
      new Error("The cancellation lock returned an invalid event sequence"),
    );
  }
  return normalized;
}

async function insertClaim(
  database: DatabaseExecutor,
  input: CancelRunPersistenceInput,
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
        $1, $2, $3, 'runs.cancel', $4, $5, 'in_progress',
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
  input: CancelRunPersistenceInput,
): Promise<CancelRunPersistenceOutcome> {
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
      WHERE organization_id = $1
        AND operation_code = 'runs.cancel'
        AND idempotency_key = $2
      FOR UPDATE
    `,
    [input.tenantId, input.idempotencyKey],
  );
  const existing = result.rows[0];
  if (existing === undefined) {
    throw new RunCancellationUnavailableError(
      new Error("A conflicting cancellation claim was not visible"),
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
    existing.resource_id !== input.runId ||
    existing.response_body_reference !== "inline_json_v1" ||
    !isPublicRun(existing.response_body) ||
    existing.response_body.id !== existing.resource_id
  ) {
    throw new RunCancellationUnavailableError(
      new Error("The cancellation claim is not replayable"),
    );
  }
  return { kind: "replay", run: existing.response_body };
}

async function lockRun(
  database: DatabaseExecutor,
  input: CancelRunPersistenceInput,
): Promise<LockedRunRow> {
  const result=await database.query<LockedRunRow>(`
    SELECT run.id AS run_id,run.service_id,${RUN_PUBLIC_STATUS_SQL} AS public_status,run.internal_status,
      run.customer_error_code,run.retryable,run.created_at,run.updated_at,run.completed_at
    FROM app.runs run WHERE run.organization_id=$1 AND run.id=$2 FOR UPDATE OF run`,[input.tenantId,input.runId]);
  const row = result.rows[0];
  if (row === undefined) throw new RunCancellationNotFoundError();
  if (!['QUEUED','SUBMITTED'].includes(row.internal_status) || !['queued','running'].includes(row.public_status)) {
    throw new RunCancellationStateConflictError();
  }
  const events=await database.query<{next_event_sequence:string;cancellation_requested:boolean}>(`SELECT (coalesce(max(sequence),0)+1)::text next_event_sequence,
    coalesce(bool_or(event_type='cancellation_requested'),false) cancellation_requested FROM app.run_events WHERE organization_id=$1 AND run_id=$2`,[input.tenantId,input.runId]);
  if(!events.rows[0])throw new RunCancellationUnavailableError();
  return {...row,...events.rows[0]};
}

function publicRun(run: LockedRunRow, serviceId: string): Run {
  if (run.customer_error_code !== null || run.retryable || run.completed_at !== null) {
    throw new RunCancellationUnavailableError(
      new Error("The queued Run projection is internally inconsistent"),
    );
  }
  return {
    id: run.run_id,
    service_id: serviceId,
    status: run.public_status as 'queued'|'running',
    error_code: null,
    retryable: false,
    created_at: run.created_at.toISOString(),
    updated_at: run.updated_at.toISOString(),
    completed_at: null,
  };
}

async function recordFirstRequest(
  database: DatabaseExecutor,
  input: CancelRunPersistenceInput,
  run: LockedRunRow,
): Promise<boolean> {
  if (run.cancellation_requested) return false;

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
      ) VALUES (
        $1, $2, $3, $4::bigint, 'cancellation_requested',
        $5, $6::jsonb
      )
    `,
    [
      input.runEventId,
      input.tenantId,
      input.runId,
      eventSequence(run.next_event_sequence),
      `cancel.requested.v1:${input.idempotencyRecordId}`,
      { status: run.public_status, initiated_by_user_id: input.actor.userId },
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
        'jobs.cancel',
        ($2::uuid)::text,
        $4::jsonb,
        1
      )
    `,
    [input.outboxEventId, input.runId, input.tenantId, { run_id: input.runId,initiated_by_user_id:input.actor.userId,...(input.requestId?{trace_id:input.requestId}:{}) }],
  );

  return true;
}

async function recordAudit(
  database: DatabaseExecutor,
  input: CancelRunPersistenceInput,
  commandCreated: boolean,
): Promise<void> {
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
        $1, $2, 'run.cancel', 'run', $3, $4, $5::uuid, $6,
        jsonb_build_object(
          'operation', 'runs.cancel',
          'status', 'queued',
          'command_created', $7::boolean
        )
      )
    `,
    [
      input.tenantId,
      input.actor.userId,
      input.runId,
      commandCreated ? "accepted" : "accepted_existing",
      input.requestId,
      input.ipFingerprint,
      commandCreated,
    ],
  );
}

async function completeClaim(
  database: DatabaseExecutor,
  input: CancelRunPersistenceInput,
  response: Run,
): Promise<Run> {
  const result = await database.query<ResponseBodyRow>(
    `
      UPDATE app.idempotency_records
      SET
        state = 'completed',
        response_status = 202,
        resource_type = 'run',
        resource_id = $2,
        response_body_reference = 'inline_json_v1',
        response_body = $3::jsonb,
        completed_at = clock_timestamp()
      WHERE id = $1
      RETURNING response_body
    `,
    [input.idempotencyRecordId, input.runId, response],
  );
  const stored = result.rows[0]?.response_body;
  if (!isPublicRun(stored) || stored.id !== input.runId) {
    throw new RunCancellationUnavailableError(
      new Error("The cancellation replay body could not be completed"),
    );
  }
  return stored;
}

async function acceptNewClaim(
  database: DatabaseExecutor,
  input: CancelRunPersistenceInput,
): Promise<CancelRunPersistenceOutcome> {
  const locked = await lockRun(database, input);
  const serviceId = locked.service_id;
  const response = publicRun(locked, serviceId);
  const commandCreated = await recordFirstRequest(database, input, locked);
  await recordAudit(database, input, commandCreated);
  const stored = await completeClaim(database, input, response);
  return {
    kind: commandCreated ? "accepted" : "accepted_existing",
    run: stored,
  };
}

export function createCancelRunRepository(pool: Pool): CancelRunRepository {
  return {
    async persist(input): Promise<CancelRunPersistenceOutcome> {
      try {
        return await withAdmissionOrganizationTransaction(
          pool,
          { tenantId: input.tenantId, userId: input.actor.userId },
          async (database) => {
            if (!(await insertClaim(database, input))) {
              return replayExistingClaim(database, input);
            }
            return acceptNewClaim(database, input);
          },
        );
      } catch (error) {
        if (
          error instanceof ApplicationError ||
          error instanceof RunCancellationNotFoundError ||
          error instanceof RunCancellationStateConflictError ||
          error instanceof RunCancellationUnavailableError
        ) {
          throw error;
        }
        throw internalFailure(error);
      }
    },
  };
}
