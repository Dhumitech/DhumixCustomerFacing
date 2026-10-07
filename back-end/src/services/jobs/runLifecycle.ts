import type { DatabaseExecutor } from '../../types/database.js';
import { runPublicStatus } from '../../helpers/runPublicStatus.js';

export const RUN_TRANSITIONS: Readonly<Record<string,readonly string[]>> = Object.freeze({
  QUEUED:['CANCELLED','SUBMITTED','UPSTREAM_REJECTED'], SUBMITTED:['CANCELLED','RESULT_RECEIVED','UPSTREAM_FAILED'],
  RESULT_RECEIVED:['PROCESSING'], PROCESSING:['COMPLETED','PROCESSING_FAILED'], COMPLETED:['EXPIRED'],
});
export const TERMINAL_RUN_STATES=['UPSTREAM_REJECTED','UPSTREAM_FAILED','CANCELLED','COMPLETED','PROCESSING_FAILED','EXPIRED'] as const;
export function runDatabaseError(code:string,message:string):never { throw Object.assign(new Error(message),{code}); }
export function requireLeaseTtl(value:number):void {
  if(!Number.isSafeInteger(value)||value<5000||value>300000)runDatabaseError('22023','RUN_ATTEMPT_LEASE_TTL_OUT_OF_RANGE');
}
export function requireOutcome(value:string):void {
  if(!/^[a-z][a-z0-9_]{0,63}$/.test(value))runDatabaseError('22023','RUN_ATTEMPT_OUTCOME_INVALID');
}
export interface LifecycleRun {
  readonly id:string;readonly organization_id:string;readonly service_id:string;readonly template_version_id:string;
  readonly internal_status:string;readonly state_version:string;readonly cost_state:string;
}
export async function lockLifecycleRun(db:DatabaseExecutor,tenantId:string,runId:string):Promise<LifecycleRun> {
  const r=await db.query<LifecycleRun>(`SELECT id,organization_id,service_id,template_version_id,internal_status,state_version::text,cost_state
    FROM app.runs WHERE organization_id=$1 AND id=$2 FOR UPDATE`,[tenantId,runId]);
  if(!r.rows[0])runDatabaseError('P0002','RUN_NOT_FOUND');return r.rows[0];
}
export interface LiveAttempt {
  readonly id:string;readonly kind:string;readonly state:string;readonly fence_token:string;
  readonly live:boolean;readonly attempt_number:number;readonly worker_lease_expires_at:Date|null;
}
export async function requireLiveAttempt(db:DatabaseExecutor,input:{tenantId:string;runId:string;attemptId:string;fenceToken:string}):Promise<LiveAttempt> {
  const r=await db.query<LiveAttempt>(`SELECT id,kind,state,fence_token,attempt_number,worker_lease_expires_at,
    worker_lease_expires_at>clock_timestamp() AS live FROM app.run_attempts
    WHERE organization_id=$1 AND run_id=$2 AND id=$3 FOR UPDATE`,[input.tenantId,input.runId,input.attemptId]);
  const a=r.rows[0];if(!a||a.state!=='claimed'||a.fence_token!==input.fenceToken||a.live!==true)runDatabaseError('40001','RUN_ATTEMPT_FENCE_REJECTED');return a;
}
export interface LifecycleTransitionInput {
  readonly tenantId:string;readonly runId:string;readonly expectedStateVersion:number;readonly toInternalStatus:string;
  readonly eventType:string;readonly eventIdempotencyKey:string;readonly attemptId:string;readonly fenceToken:string;
  readonly customerErrorCode?:string|null;readonly retryable?:boolean;readonly safePayload:Readonly<Record<string,unknown>>;
}
export function lifecycleProjection(run:Pick<LifecycleRun,'state_version'|'internal_status'>) {
  const stateVersion=Number(run.state_version);
  if(!Number.isSafeInteger(stateVersion)||stateVersion<0)runDatabaseError('23514','RUN_STATE_VERSION_INVALID');
  return {stateVersion,internalStatus:run.internal_status,publicStatus:runPublicStatus(run.internal_status)};
}
export async function appendRunEvent(db:DatabaseExecutor,input:{tenantId:string;runId:string;eventType:string;eventIdempotencyKey:string;safePayload:Readonly<Record<string,unknown>>}):Promise<void> {
  await db.query(`INSERT INTO app.run_events (organization_id,run_id,sequence,event_type,event_idempotency_key,safe_payload)
    VALUES ($1,$2,(SELECT coalesce(max(sequence),0)+1 FROM app.run_events WHERE organization_id=$1 AND run_id=$2),$3,$4,$5::jsonb)`,
    [input.tenantId,input.runId,input.eventType,input.eventIdempotencyKey,input.safePayload]);
}
/** Run-before-Attempt locks, a live fence and exact affected-row checks remain authoritative. */
export async function transitionLifecycle(db:DatabaseExecutor,input:LifecycleTransitionInput) {
  const run=await lockLifecycleRun(db,input.tenantId,input.runId);
  await requireLiveAttempt(db,input);
  const replay=await db.query(`SELECT id FROM app.run_events WHERE organization_id=$1 AND run_id=$2 AND event_idempotency_key=$3`,[input.tenantId,input.runId,input.eventIdempotencyKey]);
  if(replay.rows.length)return lifecycleProjection(run);
  if(Number(run.state_version)!==input.expectedStateVersion)runDatabaseError('40001','STATE_CONFLICT');
  if(!RUN_TRANSITIONS[run.internal_status]?.includes(input.toInternalStatus))runDatabaseError('23514','ILLEGAL_RUN_TRANSITION');
  if(input.toInternalStatus==='RESULT_RECEIVED'){
    const raw=await db.query(`SELECT id FROM app.artifacts WHERE organization_id=$1 AND run_id=$2 AND kind='raw' AND state IN ('durable','validated') LIMIT 1`,[input.tenantId,input.runId]);
    if(!raw.rows.length)runDatabaseError('23514','DURABLE_RAW_ARTIFACT_REQUIRED');
  }
  if(input.toInternalStatus==='SUBMITTED') {
    const cancel=await db.query(`SELECT id FROM app.run_events WHERE organization_id=$1 AND run_id=$2 AND event_type='cancellation_requested' LIMIT 1`,[input.tenantId,input.runId]);
    if(cancel.rows.length)runDatabaseError('P0001','RUN_CANCELLATION_REQUESTED');
  }
  const terminal=TERMINAL_RUN_STATES.includes(input.toInternalStatus as typeof TERMINAL_RUN_STATES[number]);
  const updated=await db.query<LifecycleRun>(`UPDATE app.runs SET internal_status=$1,state_version=state_version+1,
    customer_error_code=$2,retryable=$3,completed_at=CASE WHEN $4::boolean THEN coalesce(completed_at,clock_timestamp()) ELSE completed_at END
    WHERE organization_id=$5 AND id=$6 AND state_version=$7 AND EXISTS (
      SELECT 1 FROM app.run_attempts WHERE organization_id=$5 AND run_id=$6 AND id=$8 AND fence_token=$9 AND state='claimed' AND worker_lease_expires_at>clock_timestamp())
    RETURNING internal_status,state_version::text`,[input.toInternalStatus,input.customerErrorCode??null,input.retryable??false,terminal,
      input.tenantId,input.runId,input.expectedStateVersion,input.attemptId,input.fenceToken]);
  if(updated.rows.length!==1)runDatabaseError('40001','STATE_CONFLICT');
  await appendRunEvent(db,input);
  // Unknown supplier cost stays held. Only observed USD cost or proven no-send can settle it.
  if(terminal) await db.query(`UPDATE app.runs SET
    cost_state=CASE WHEN observed.total IS NOT NULL THEN 'finalized' WHEN $3::boolean AND NOT EXISTS (
      SELECT 1 FROM app.provider_calls WHERE organization_id=$1 AND run_id=$2 AND state<>'not_sent') THEN 'released' ELSE cost_state END,
    final_cost_micros=CASE WHEN observed.total IS NOT NULL THEN observed.total ELSE final_cost_micros END
    FROM (SELECT CASE WHEN count(*) FILTER (WHERE provider_cost_micros IS NULL)=0 THEN sum(provider_cost_micros)::bigint END total
      FROM app.run_attempts WHERE organization_id=$1 AND run_id=$2 AND kind='submission') observed
    WHERE organization_id=$1 AND id=$2 AND cost_state='held'`,[input.tenantId,input.runId,run.internal_status==='QUEUED']);
  return lifecycleProjection(updated.rows[0]!);
}

export async function recordNormalizedUsage(db:DatabaseExecutor,input:{tenantId:string;runId:string;sourceAttemptId:string;normalizedArtifactId:string;
  usage:{meterCode:string;unit:string}|null}):Promise<void> {
  const artifact=await db.query<{record_count:string;created_at:Date}>(`SELECT record_count::text,created_at FROM app.artifacts
    WHERE organization_id=$1 AND run_id=$2 AND attempt_id=$3 AND id=$4 AND kind='normalized' AND state='validated' AND record_count IS NOT NULL`,
    [input.tenantId,input.runId,input.sourceAttemptId,input.normalizedArtifactId]);
  if(!artifact.rows[0])runDatabaseError('23514','VALIDATED_NORMALIZED_ARTIFACT_REQUIRED');
  if(!input.usage)return;
  if(!/^[a-z][a-z0-9_.]{0,127}$/.test(input.usage.meterCode)||!/^[a-z][a-z0-9_]{0,31}$/.test(input.usage.unit))runDatabaseError('22023','USAGE_OBSERVATION_INPUT_INVALID');
  await db.query(`INSERT INTO app.usage_events (organization_id,run_id,attempt_id,meter_code,quantity,unit,outcome,source,reconciliation_state,observed_at)
    VALUES ($1,$2,$3,$4,$5::bigint,$6,'succeeded','artifact','observed',$7)
    ON CONFLICT (organization_id,attempt_id,meter_code) WHERE attempt_id IS NOT NULL AND source='artifact' AND outcome='succeeded' DO NOTHING`,
    [input.tenantId,input.runId,input.sourceAttemptId,input.usage.meterCode,artifact.rows[0].record_count,input.usage.unit,artifact.rows[0].created_at]);
  const replay=await db.query<{run_id:string;quantity_matches:boolean;unit:string;reconciliation_state:string}>(`SELECT run_id,quantity=$4::numeric AS quantity_matches,unit,reconciliation_state FROM app.usage_events
    WHERE organization_id=$1 AND attempt_id=$2 AND meter_code=$3 AND source='artifact' AND outcome='succeeded'`,[input.tenantId,input.sourceAttemptId,input.usage.meterCode,artifact.rows[0].record_count]);
  const row=replay.rows[0];
  if(!row||row.run_id!==input.runId||!row.quantity_matches||row.unit!==input.usage.unit||row.reconciliation_state!=='observed')runDatabaseError('23505','USAGE_FINALIZATION_CONFLICT');
}
