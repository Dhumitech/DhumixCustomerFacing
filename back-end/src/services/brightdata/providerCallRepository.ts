import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { withJobManagerTenantTransaction } from "../database/transactions.js";

export type ProviderCallPurpose = "run_submit" | "run_poll" | "run_download" | "run_cancel";
export const PROVIDER_CALL_ENDPOINTS = {
  run_submit: ["/datasets/v3/scrape", "/datasets/v3/trigger"],
  run_poll: ["/datasets/v3/progress/:snapshot"],
  run_download: ["/datasets/v3/snapshot/:snapshot", "/datasets/v3/snapshot/:snapshot/parts"],
  run_cancel: ["/datasets/v3/snapshot/:snapshot/cancel"],
} as const;

export interface ProviderCallFence {
  readonly tenantId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly fenceToken: string;
  readonly cancellationRequesterUserId?: string;
}
export type ProviderCallObservation = {
  readonly state: "responded";
  readonly httpStatus: number;
  /** NULL when the complete body wasn't observed, never an invented zero. */
  readonly responseBytes: number | null;
  readonly safeErrorCode: string | null;
} | {
  readonly state: "not_sent" | "uncertain";
  readonly safeErrorCode: string;
};
export interface ProviderCallRecorder {
  prepare(purpose: ProviderCallPurpose, endpoint: string): Promise<string>;
  finish(callId: string, observation: ProviderCallObservation): Promise<void>;
}

export class ProviderCallRecordingError extends Error {
  public constructor() { super("Private provider-call evidence could not be recorded"); this.name = "ProviderCallRecordingError"; }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeCodes = new Set([
  "PROVIDER_CONFIGURATION_INVALID", "PROVIDER_CREDENTIAL_UNAVAILABLE", "PROVIDER_PAYMENT_REQUIRED", "PROVIDER_REQUEST_REJECTED",
  "PROVIDER_RATE_LIMITED", "PROVIDER_SUBMISSION_UNCERTAIN", "PROVIDER_RESPONSE_INVALID", "PROVIDER_UNAVAILABLE",
]);

/** Uses the existing worker pool and a live Attempt fence; intent commits before egress. */
export function createProviderCallRecorder(pool: Pool, fence: ProviderCallFence): ProviderCallRecorder {
  if (![fence.tenantId, fence.runId, fence.attemptId, fence.fenceToken].every(value => uuid.test(value))) throw new ProviderCallRecordingError();
  return {
    async prepare(purpose, endpoint) {
      if (!(PROVIDER_CALL_ENDPOINTS[purpose] as readonly string[] | undefined)?.includes(endpoint)) throw new ProviderCallRecordingError();
      const callId = randomUUID();
      await withJobManagerTenantTransaction(pool, fence.tenantId, async db => {
        // Lock in existing Run-before-Attempt order; commit intent before egress.
        // No source adapter/mapping/cost-hold table is read by this recorder.
        const run = await db.query<{ created_by_user_id: string | null; service_id: string; service_state: string; execution_allowed: boolean }>(`
          SELECT r.created_by_user_id,r.service_id,s.state AS service_state,
            (s.state='active' AND o.state='active' AND (v.availability_state='available' OR t.state='draft' AND o.is_internal AND v.availability_state='coming_soon') AND
             (t.state='published' AND v.published_at IS NOT NULL AND v.published_at<=statement_timestamp() OR t.state='draft' AND o.is_internal)
             AND (t.access='all' OR EXISTS(SELECT 1 FROM app.organization_templates a WHERE a.organization_id=r.organization_id AND a.service_template_id=t.id))) execution_allowed
          FROM app.runs r JOIN app.services s ON s.organization_id=r.organization_id AND s.id=r.service_id
          JOIN app.organizations o ON o.id=r.organization_id JOIN app.service_template_versions v ON v.id=r.template_version_id
          JOIN app.service_templates t ON t.id=v.service_template_id
          WHERE r.organization_id=$1 AND r.id=$2 FOR UPDATE OF r FOR SHARE OF s,t`, [fence.tenantId, fence.runId]);
        if (!run.rows[0] || (purpose === "run_submit" && !run.rows[0].execution_allowed)) throw new ProviderCallRecordingError();
        const attempt = await db.query(`SELECT id FROM app.run_attempts
          WHERE organization_id=$1 AND run_id=$2 AND id=$3 AND fence_token=$4
           AND state='claimed' AND worker_lease_expires_at>clock_timestamp() FOR UPDATE`,
          [fence.tenantId, fence.runId, fence.attemptId, fence.fenceToken]);
        if (attempt.rows.length !== 1) throw new ProviderCallRecordingError();
        if (purpose === "run_submit") {
          const existing = await db.query(`SELECT id FROM app.provider_calls
            WHERE organization_id=$1 AND run_id=$2 AND attempt_id=$3 AND purpose='run_submit'`, [fence.tenantId, fence.runId, fence.attemptId]);
          if (existing.rows.length) throw new ProviderCallRecordingError();
        }
        let initiator = run.rows[0].created_by_user_id;
        if (purpose === "run_cancel") {
          const first = await db.query<{ initiated_by_user_id: string | null }>(`
            SELECT safe_payload->>'initiated_by_user_id' AS initiated_by_user_id FROM app.run_events
            WHERE organization_id=$1 AND run_id=$2 AND event_type='cancellation_requested'
            ORDER BY sequence LIMIT 1`, [fence.tenantId, fence.runId]);
          initiator = first.rows[0]?.initiated_by_user_id ?? null;
          // An old cancellation event has no actor. Its first accepted audit fact
          // may prove one; accepted_existing/replays must never replace that actor.
          if (initiator === null) {
            const historical = await db.query<{ actor_user_id: string | null }>(`SELECT actor_user_id FROM app.audit_events
              WHERE organization_id=$1 AND target_type='run' AND target_id=$2 AND action='run.cancel' AND outcome='accepted'
              ORDER BY occurred_at,id LIMIT 1`, [fence.tenantId, fence.runId]);
            initiator = historical.rows[0]?.actor_user_id ?? null;
          }
        }
        if (initiator !== null && !uuid.test(initiator)) throw new ProviderCallRecordingError();
        if(purpose==='run_cancel'&&fence.cancellationRequesterUserId!==undefined&&fence.cancellationRequesterUserId!==initiator)throw new ProviderCallRecordingError();
        const saved = await db.query(`INSERT INTO app.provider_calls
          (id,organization_id,run_id,initiated_by_user_id,attempt_id,purpose,endpoint)
          VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [callId, fence.tenantId, fence.runId, initiator, fence.attemptId, purpose, endpoint]);
        if (saved.rows.length !== 1) throw new ProviderCallRecordingError();
      });
      return callId;
    },
    async finish(callId, observation) {
      if (!uuid.test(callId) || (observation.safeErrorCode !== null && !safeCodes.has(observation.safeErrorCode))) throw new ProviderCallRecordingError();
      if (observation.state === "responded" && (!Number.isInteger(observation.httpStatus) || observation.httpStatus < 100 || observation.httpStatus > 599 ||
        (observation.responseBytes !== null && (!Number.isSafeInteger(observation.responseBytes) || observation.responseBytes < 0)))) throw new ProviderCallRecordingError();
      if (!["responded", "not_sent", "uncertain"].includes(observation.state)) throw new ProviderCallRecordingError();
      await withJobManagerTenantTransaction(pool, fence.tenantId, async db => {
        const result = await db.query(`UPDATE app.provider_calls c SET state=$1,http_status=$2,safe_error_code=$3,response_bytes=$4,finished_at=clock_timestamp()
          WHERE c.id=$5 AND c.organization_id=$6 AND c.run_id=$7 AND c.attempt_id=$8 AND c.state='prepared'
           AND EXISTS (SELECT 1 FROM app.run_attempts a WHERE a.id=c.attempt_id AND a.organization_id=c.organization_id
            AND a.run_id=c.run_id AND a.fence_token=$9) RETURNING c.id`,
          [observation.state, observation.state === "responded" ? observation.httpStatus : null, observation.safeErrorCode,
            observation.state === "responded" ? observation.responseBytes : null, callId, fence.tenantId, fence.runId, fence.attemptId, fence.fenceToken]);
        if (result.rows.length !== 1) throw new ProviderCallRecordingError();
      });
    },
  };
}
