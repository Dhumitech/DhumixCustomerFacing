import type { Pool } from "pg";
import type { DatabaseExecutor } from "../../types/database.js";
import { appendRunEvent, lockLifecycleRun, requireLiveAttempt, requireLeaseTtl, requireOutcome, runDatabaseError, transitionLifecycle, lifecycleProjection, recordNormalizedUsage, TERMINAL_RUN_STATES } from "./runLifecycle.js";
import { withJobManagerTenantTransaction } from "../database/transactions.js";
import type { NormalizedUsageObservation } from "./controlledRunExecutor.js";

export type AttemptClaimDisposition =
  | "claimed"
  | "recovered"
  | "busy"
  | "terminal"
  | "reconciliation_required"
  | "not_claimable";

export interface RunAttemptClaim {
  readonly disposition: AttemptClaimDisposition;
  readonly attemptId: string | null;
  readonly attemptNumber: number | null;
  readonly fenceToken: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly runStateVersion: number;
  readonly runInternalStatus: string;
  readonly executionEnabled: boolean;
  readonly cancellationRequested: boolean;
}

export interface RunReconciliationEvidence {
  readonly sourceAttemptId: string;
  readonly hasRawArtifact: boolean;
  readonly hasNormalizedArtifact: boolean;
}

export interface RunExecutionRepository {
  claimSubmission(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly leaseTtlMs: number;
  }): Promise<RunAttemptClaim>;
  claimReconciliation(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly leaseTtlMs: number;
  }): Promise<RunAttemptClaim>;
  scheduleReconciliation(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly reasonCode: "submission_outcome_uncertain" | "cancellation_requested";
  }): Promise<{ readonly commandEventId: string; readonly scheduled: boolean }>;
  inspectReconciliation(input: {
    readonly tenantId: string;
    readonly runId: string;
  }): Promise<RunReconciliationEvidence>;
  renew(input: {
    readonly tenantId: string;
    readonly attemptId: string;
    readonly fenceToken: string;
    readonly leaseTtlMs: number;
  }): Promise<Date | null>;
  transition(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly expectedStateVersion: number;
    readonly toInternalStatus: string;
    readonly eventType: string;
    readonly eventIdempotencyKey: string;
    readonly attemptId: string;
    readonly fenceToken: string;
    readonly customerErrorCode?: string | null;
    readonly retryable?: boolean;
    readonly safePayload: Readonly<Record<string, unknown>>;
  }): Promise<{ readonly stateVersion: number; readonly internalStatus: string; readonly publicStatus: string }>;
  finish(input: {
    readonly tenantId: string;
    readonly attemptId: string;
    readonly fenceToken: string;
    readonly state: "rejected" | "ambiguous" | "completed" | "failed";
    readonly outcomeClass: string;
  }): Promise<boolean>;
  completeSuccess(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly expectedStateVersion: number;
    readonly eventIdempotencyKey: string;
    readonly attemptId: string;
    readonly fenceToken: string;
    readonly outcomeClass: string;
    readonly normalizedArtifactId: string;
    readonly usage: NormalizedUsageObservation | null;
    readonly safePayload: Readonly<Record<string, unknown>>;
  }): Promise<{ readonly stateVersion: number; readonly internalStatus: string; readonly publicStatus: string }>;
  completeReconciliation(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly expectedStateVersion: number;
    readonly toInternalStatus: "UPSTREAM_FAILED" | "PROCESSING_FAILED" | "CANCELLED" | "COMPLETED";
    readonly eventType: "failed" | "cancelled" | "completed";
    readonly eventIdempotencyKey: string;
    readonly reconciliationAttemptId: string;
    readonly reconciliationFenceToken: string;
    readonly sourceAttemptId: string;
    readonly sourceAttemptState: "completed" | "failed";
    readonly sourceOutcomeClass: string;
    readonly reconciliationOutcomeClass: string;
    readonly customerErrorCode?: string | null;
    readonly retryable?: boolean;
    readonly safePayload: Readonly<Record<string, unknown>>;
  }): Promise<{ readonly stateVersion: number; readonly internalStatus: string; readonly publicStatus: string }>;
  completeReconciliationSuccess(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly expectedStateVersion: number;
    readonly eventIdempotencyKey: string;
    readonly reconciliationAttemptId: string;
    readonly reconciliationFenceToken: string;
    readonly sourceAttemptId: string;
    readonly reconciliationOutcomeClass: string;
    readonly normalizedArtifactId: string;
    readonly usage: NormalizedUsageObservation | null;
    readonly safePayload: Readonly<Record<string, unknown>>;
  }): Promise<{ readonly stateVersion: number; readonly internalStatus: string; readonly publicStatus: string }>;
}


interface AttemptRow {
  readonly id:string;readonly attempt_number:number;readonly fence_token:string;readonly worker_lease_expires_at:Date|null;
  readonly live:boolean;readonly state:string;readonly kind:string;
}
async function finishAttempt(db:DatabaseExecutor,input:Parameters<RunExecutionRepository['finish']>[0]):Promise<boolean> {
  requireOutcome(input.outcomeClass);
  if(!['rejected','ambiguous','completed','failed'].includes(input.state))runDatabaseError('22023','RUN_ATTEMPT_FINISH_STATE_INVALID');
  const result=await db.query(`UPDATE app.run_attempts SET state=$1,outcome_class=$2,worker_lease_expires_at=NULL,finished_at=clock_timestamp()
    WHERE organization_id=$3 AND id=$4 AND state='claimed' AND fence_token=$5 AND worker_lease_expires_at>clock_timestamp() RETURNING id`,
    [input.state,input.outcomeClass,input.tenantId,input.attemptId,input.fenceToken]);
  return result.rows.length===1;
}
async function completeReconciliation(db:DatabaseExecutor,input:Parameters<RunExecutionRepository['completeReconciliation']>[0]) {
  requireOutcome(input.sourceOutcomeClass);requireOutcome(input.reconciliationOutcomeClass);
  if(!['completed','failed'].includes(input.sourceAttemptState))runDatabaseError('22023','RUN_RECONCILIATION_SOURCE_STATE_INVALID');
  await lockLifecycleRun(db,input.tenantId,input.runId);
  const fence={tenantId:input.tenantId,runId:input.runId,attemptId:input.reconciliationAttemptId,fenceToken:input.reconciliationFenceToken};
  const owner=await requireLiveAttempt(db,fence);
  if(owner.kind!=='reconciliation')runDatabaseError('40001','RUN_RECONCILIATION_FENCE_REJECTED');
  const source=await db.query(`SELECT id FROM app.run_attempts WHERE organization_id=$1 AND run_id=$2 AND id=$3 AND kind='submission' AND state='ambiguous' FOR UPDATE`,
    [input.tenantId,input.runId,input.sourceAttemptId]);
  if(source.rows.length!==1)runDatabaseError('40001','RUN_RECONCILIATION_SOURCE_REJECTED');
  const changed=await transitionLifecycle(db,{...input,...fence});
  const finalized=await db.query(`UPDATE app.run_attempts SET state=$1,outcome_class=$2,finished_at=coalesce(finished_at,clock_timestamp())
    WHERE organization_id=$3 AND run_id=$4 AND id=$5 AND state='ambiguous' RETURNING id`,
    [input.sourceAttemptState,input.sourceOutcomeClass,input.tenantId,input.runId,input.sourceAttemptId]);
  if(finalized.rows.length!==1)runDatabaseError('40001','RUN_RECONCILIATION_SOURCE_UPDATE_REJECTED');
  if(!await finishAttempt(db,{tenantId:input.tenantId,attemptId:input.reconciliationAttemptId,fenceToken:input.reconciliationFenceToken,state:'completed',outcomeClass:input.reconciliationOutcomeClass}))runDatabaseError('40001','RUN_RECONCILIATION_FINISH_REJECTED');
  return changed;
}
export function createRunExecutionRepository(pool:Pool):RunExecutionRepository {
  const transaction=<T>(tenantId:string,work:(db:DatabaseExecutor)=>Promise<T>)=>withJobManagerTenantTransaction(pool,tenantId,work);
  async function claim(input:{tenantId:string;runId:string;leaseTtlMs:number},kind:'submission'|'reconciliation'):Promise<RunAttemptClaim> {
    requireLeaseTtl(input.leaseTtlMs);
    return transaction(input.tenantId,async db=>{
      const run=await lockLifecycleRun(db,input.tenantId,input.runId);
      const context=await db.query<{cancellation_requested:boolean;execution_enabled:boolean}>(`
        SELECT EXISTS(SELECT 1 FROM app.run_events WHERE organization_id=$1 AND run_id=$2 AND event_type='cancellation_requested') cancellation_requested,
          EXISTS(SELECT 1 FROM app.services s JOIN app.service_template_versions v ON v.id=s.template_version_id
            JOIN app.service_templates t ON t.id=v.service_template_id JOIN app.organizations o ON o.id=s.organization_id
            WHERE s.organization_id=$1 AND s.id=$3 AND s.state='active' AND o.state='active' AND t.state IN ('published','draft')
              AND (v.availability_state='available' OR t.state='draft' AND o.is_internal AND v.availability_state='coming_soon') AND (t.access='all' OR EXISTS(SELECT 1 FROM app.organization_templates a WHERE a.organization_id=$1 AND a.service_template_id=t.id))) execution_enabled`,
        [input.tenantId,input.runId,run.service_id]);
      if(!context.rows[0])runDatabaseError('P0002','RUN_EXECUTION_CONTEXT_NOT_FOUND');
      const base={runStateVersion:lifecycleProjection(run).stateVersion,runInternalStatus:run.internal_status,
        cancellationRequested:context.rows[0].cancellation_requested,executionEnabled:context.rows[0].execution_enabled};
      const result=(disposition:AttemptClaimDisposition,attempt?:AttemptRow):RunAttemptClaim=>({...base,disposition,
        attemptId:attempt?.id??null,attemptNumber:attempt?.attempt_number??null,
        fenceToken:['claimed','recovered'].includes(disposition)?attempt?.fence_token??null:null,leaseExpiresAt:attempt?.worker_lease_expires_at??null});
      if(TERMINAL_RUN_STATES.includes(run.internal_status as typeof TERMINAL_RUN_STATES[number]))return result('terminal');
      const current=await db.query<AttemptRow>(`SELECT id,attempt_number,fence_token,worker_lease_expires_at,state,kind,
        worker_lease_expires_at>clock_timestamp() live FROM app.run_attempts WHERE organization_id=$1 AND run_id=$2 AND kind=$3 AND state='claimed' FOR UPDATE`,[input.tenantId,input.runId,kind]);
      const old=current.rows[0];
      if(kind==='submission'&&['SUBMITTED','RESULT_RECEIVED','PROCESSING'].includes(run.internal_status))return old?.live?result('busy',old):result('reconciliation_required');
      if(kind==='submission'&&run.internal_status!=='QUEUED'||kind==='reconciliation'&&!['SUBMITTED','RESULT_RECEIVED','PROCESSING'].includes(run.internal_status))return result('not_claimable');
      if(old?.live)return result('busy',old);
      if(old){
        const recovered=await db.query<AttemptRow>(`UPDATE app.run_attempts SET fence_token=gen_random_uuid(),worker_lease_expires_at=clock_timestamp()+$1::bigint*interval '1 millisecond'
          WHERE organization_id=$2 AND run_id=$3 AND id=$4 AND state='claimed' AND worker_lease_expires_at<=clock_timestamp()
          RETURNING id,attempt_number,fence_token,worker_lease_expires_at,state,kind,true AS live`,[input.leaseTtlMs,input.tenantId,input.runId,old.id]);
        if(recovered.rows.length!==1)runDatabaseError('40001','RUN_ATTEMPT_CLAIM_REJECTED');return result('recovered',recovered.rows[0]);
      }
      const created=await db.query<AttemptRow>(`INSERT INTO app.run_attempts (organization_id,run_id,attempt_number,kind,state,worker_lease_expires_at)
        VALUES ($1,$2,(SELECT coalesce(max(attempt_number),0)+1 FROM app.run_attempts WHERE organization_id=$1 AND run_id=$2 AND kind=$3),$3,'claimed',clock_timestamp()+$4::bigint*interval '1 millisecond')
        RETURNING id,attempt_number,fence_token,worker_lease_expires_at,state,kind,true AS live`,[input.tenantId,input.runId,kind,input.leaseTtlMs]);
      if(created.rows.length!==1)runDatabaseError('40001','RUN_ATTEMPT_CLAIM_REJECTED');return result('claimed',created.rows[0]);
    });
  }
  return {
    claimSubmission:input=>claim(input,'submission'),claimReconciliation:input=>claim(input,'reconciliation'),
    async renew(input){
      requireLeaseTtl(input.leaseTtlMs);
      return transaction(input.tenantId,async db=>{
        const r=await db.query<{worker_lease_expires_at:Date}>(`UPDATE app.run_attempts SET worker_lease_expires_at=clock_timestamp()+$1::bigint*interval '1 millisecond'
          WHERE organization_id=$2 AND id=$3 AND fence_token=$4 AND state='claimed' AND worker_lease_expires_at>clock_timestamp() RETURNING worker_lease_expires_at`,
          [input.leaseTtlMs,input.tenantId,input.attemptId,input.fenceToken]);return r.rows[0]?.worker_lease_expires_at??null;
      });
    },
    transition:input=>transaction(input.tenantId,db=>transitionLifecycle(db,input)),
    finish:input=>transaction(input.tenantId,db=>finishAttempt(db,input)),
    async completeSuccess(input){return transaction(input.tenantId,async db=>{
      await lockLifecycleRun(db,input.tenantId,input.runId);await requireLiveAttempt(db,input);
      await recordNormalizedUsage(db,{...input,sourceAttemptId:input.attemptId});
      const changed=await transitionLifecycle(db,{...input,toInternalStatus:'COMPLETED',eventType:'completed'});
      if(!await finishAttempt(db,{...input,state:'completed'}))runDatabaseError('40001','RUN_ATTEMPT_FINISH_REJECTED');return changed;
    });},
    completeReconciliation:input=>transaction(input.tenantId,db=>completeReconciliation(db,input)),
    completeReconciliationSuccess:input=>transaction(input.tenantId,async db=>{
      await lockLifecycleRun(db,input.tenantId,input.runId);
      await requireLiveAttempt(db,{...input,attemptId:input.reconciliationAttemptId,fenceToken:input.reconciliationFenceToken});
      await recordNormalizedUsage(db,input);
      return completeReconciliation(db,{...input,toInternalStatus:'COMPLETED',eventType:'completed',sourceAttemptState:'completed',sourceOutcomeClass:'reconciled_from_durable_result'});
    }),
    inspectReconciliation:input=>transaction(input.tenantId,async db=>{
      const r=await db.query<{source_attempt_id:string;has_raw_artifact:boolean;has_normalized_artifact:boolean}>(`SELECT a.id source_attempt_id,
        EXISTS(SELECT 1 FROM app.artifacts WHERE organization_id=$1 AND run_id=$2 AND kind='raw' AND state IN ('durable','validated')) has_raw_artifact,
        EXISTS(SELECT 1 FROM app.artifacts WHERE organization_id=$1 AND run_id=$2 AND kind='normalized' AND state='validated') has_normalized_artifact
        FROM app.run_attempts a WHERE a.organization_id=$1 AND a.run_id=$2 AND a.kind='submission' AND a.state='ambiguous' ORDER BY a.attempt_number DESC LIMIT 1`,[input.tenantId,input.runId]);
      if(!r.rows[0])runDatabaseError('P0002','RUN_RECONCILIATION_EVIDENCE_NOT_FOUND');return {sourceAttemptId:r.rows[0].source_attempt_id,hasRawArtifact:r.rows[0].has_raw_artifact,hasNormalizedArtifact:r.rows[0].has_normalized_artifact};
    }),
    scheduleReconciliation:input=>transaction(input.tenantId,async db=>{
      if(!['submission_outcome_uncertain','cancellation_requested'].includes(input.reasonCode))runDatabaseError('22023','RUN_RECONCILIATION_REASON_INVALID');
      const run=await lockLifecycleRun(db,input.tenantId,input.runId);
      if(!['SUBMITTED','RESULT_RECEIVED','PROCESSING'].includes(run.internal_status))runDatabaseError('23514','RUN_RECONCILIATION_NOT_REQUIRED');
      const r=await db.query<AttemptRow>(`SELECT id,state,worker_lease_expires_at>clock_timestamp() live FROM app.run_attempts
        WHERE organization_id=$1 AND run_id=$2 AND kind='submission' ORDER BY attempt_number DESC LIMIT 1 FOR UPDATE`,[input.tenantId,input.runId]);
      const a=r.rows[0];if(!a)runDatabaseError('23514','RUN_SUBMISSION_ATTEMPT_NOT_FOUND');
      if(a.state==='claimed'){
        if(a.live)runDatabaseError('40001','RUN_SUBMISSION_ATTEMPT_STILL_ACTIVE');
        const changed=await db.query(`UPDATE app.run_attempts SET state='ambiguous',outcome_class=$1,worker_lease_expires_at=NULL,finished_at=clock_timestamp()
          WHERE organization_id=$2 AND id=$3 AND state='claimed' AND worker_lease_expires_at<=clock_timestamp() RETURNING id`,[input.reasonCode,input.tenantId,a.id]);
        if(changed.rows.length!==1)runDatabaseError('40001','RUN_SUBMISSION_ATTEMPT_STILL_ACTIVE');
      }else if(a.state!=='ambiguous')runDatabaseError('23514','RUN_SUBMISSION_ATTEMPT_NOT_AMBIGUOUS');
      // A crash after a durable intent leaves explicit uncertainty; never a repeat POST.
      await db.query(`UPDATE app.provider_calls SET state='uncertain',safe_error_code='PROVIDER_SUBMISSION_UNCERTAIN',finished_at=clock_timestamp()
        WHERE organization_id=$1 AND run_id=$2 AND attempt_id=$3 AND state='prepared'`,[input.tenantId,input.runId,a.id]);
      const command=await db.query<{id:string}>(`INSERT INTO app.outbox_events (aggregate_type,aggregate_id,organization_id,topic,ordering_key,payload,schema_version)
        VALUES ('run',$1::uuid,$2::uuid,'jobs.reconcile',$1::uuid::text,jsonb_build_object('run_id',$1::uuid::text,'trace_id',gen_random_uuid())||coalesce((
          SELECT jsonb_build_object('initiated_by_user_id',safe_payload->>'initiated_by_user_id') FROM app.run_events
          WHERE organization_id=$2::uuid AND run_id=$1::uuid AND event_type='cancellation_requested' AND safe_payload ? 'initiated_by_user_id' ORDER BY sequence LIMIT 1),'{}'::jsonb),1)
        ON CONFLICT (aggregate_id) WHERE topic='jobs.reconcile' DO NOTHING RETURNING id`,[input.runId,input.tenantId]);
      if(command.rows[0]){await appendRunEvent(db,{...input,eventType:'reconciliation_scheduled',eventIdempotencyKey:'job.reconciliation-scheduled.v1',safePayload:{reason:input.reasonCode}});return {commandEventId:command.rows[0].id,scheduled:true};}
      const existing=await db.query<{id:string}>(`SELECT id FROM app.outbox_events WHERE organization_id=$1 AND aggregate_id=$2 AND topic='jobs.reconcile'`,[input.tenantId,input.runId]);
      if(!existing.rows[0])runDatabaseError('23514','RUN_RECONCILIATION_COMMAND_NOT_FOUND');return {commandEventId:existing.rows[0].id,scheduled:false};
    }),
  };
}
