import type { Pool } from "pg";
import { lockLifecycleRun,requireLiveAttempt,runDatabaseError } from "../jobs/runLifecycle.js";
import { resolveFencedTemplate,type FencedTemplateExecution } from "./fencedTemplateExecution.js";
export { providerMappingAad,providerDatasetAad,providerSnapshotAad } from "./providerReferenceContexts.js";
import { withJobManagerTenantTransaction } from "../database/transactions.js";

export interface ProviderExecutionPlan {
  readonly templateVersionId: string;
  readonly validatedInput: Readonly<Record<string, unknown>>;
  readonly operationCode: string;
  readonly datasetCiphertext: Buffer;
  readonly datasetFingerprint: Buffer;
  readonly outputPolicy: Readonly<Record<string, unknown>>;
  readonly definitionConfigVersion: string;
  readonly providerCode: string;
  readonly providerEnvironment: string;
  readonly secretReference: string;
}

export interface ProviderReconciliationPlan extends ProviderExecutionPlan {
  readonly sourceAttemptId: string;
  readonly sourceProviderReferenceCiphertext: Buffer;
  readonly sourceProviderReferenceFingerprint: Buffer;
}

export interface ProviderNormalizationPlan {
  readonly operationCode: string;
  readonly outputPolicy: Readonly<Record<string, unknown>>;
}

export interface ProviderExecutionPlanRepository {
  resolveExecutorKind(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly attemptId: string;
    readonly fenceToken: string;
  }): Promise<"amazon" | "marketplace">;
  checkpointPoll(input: {
    readonly tenantId: string; readonly runId: string; readonly attemptId: string;
    readonly fenceToken: string; readonly sourceAttemptId: string;
    readonly maxElapsedMs: number; readonly status?: string;
    readonly failure?: boolean; readonly delayMs?: number;
  }): Promise<{ readonly remainingMs: number; readonly waitMs: number; readonly consecutiveFailures: number }>;
  resolveSubmission(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly attemptId: string;
    readonly fenceToken: string;
  }): Promise<ProviderExecutionPlan>;
  recordProviderReference(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly attemptId: string;
    readonly fenceToken: string;
    readonly ciphertext: Buffer;
    readonly fingerprint: Buffer;
  }): Promise<void>;
  resolveReconciliation(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly attemptId: string;
    readonly fenceToken: string;
  }): Promise<ProviderReconciliationPlan>;
  resolveNormalization(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly attemptId: string;
    readonly fenceToken: string;
    readonly sourceAttemptId: string;
  }): Promise<ProviderNormalizationPlan>;
  isCancellationRequested(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly attemptId: string;
    readonly fenceToken: string;
  }): Promise<boolean>;
}


function mapTemplate(template:FencedTemplateExecution,providerEnvironment:string):ProviderExecutionPlan {
  return {templateVersionId:template.templateVersionId,validatedInput:template.input,operationCode:template.definition.operation_code,
    datasetCiphertext:template.datasetCiphertext,datasetFingerprint:template.datasetFingerprint,outputPolicy:template.definition.output_policy,
    definitionConfigVersion:template.definition.config_version,providerCode:'bright_data',providerEnvironment,secretReference:'BRIGHTDATA_API_KEY'};
}
export function createProviderExecutionPlanRepository(pool:Pool,providerEnvironment:'local'|'test'|'production'='test'):ProviderExecutionPlanRepository {
  const transaction=<T>(tenantId:string,work:(db:import('../../types/database.js').DatabaseExecutor)=>Promise<T>)=>withJobManagerTenantTransaction(pool,tenantId,work);
  return {
    resolveExecutorKind:input=>transaction(input.tenantId,async db=>{
      const run=await lockLifecycleRun(db,input.tenantId,input.runId);await requireLiveAttempt(db,input);
      const r=await db.query<{engine:string}>(`SELECT engine FROM app.service_template_versions WHERE id=$1`,[run.template_version_id]);
      if(r.rows[0]?.engine!=='amazon.v1')runDatabaseError('P0002','Provider executor kind was unavailable or unsupported');return 'amazon' as const;
    }),
    resolveSubmission:input=>transaction(input.tenantId,async db=>mapTemplate(await resolveFencedTemplate(db,input,'submission'),providerEnvironment)),
    resolveReconciliation:input=>transaction(input.tenantId,async db=>{
      const t=await resolveFencedTemplate(db,input,'reconciliation');
      if(!t.sourceReferenceCiphertext||!t.sourceReferenceFingerprint)runDatabaseError('P0002','RUN_PROVIDER_RECONCILIATION_PLAN_NOT_AVAILABLE');
      return {...mapTemplate(t,providerEnvironment),sourceAttemptId:t.sourceAttemptId,sourceProviderReferenceCiphertext:t.sourceReferenceCiphertext,sourceProviderReferenceFingerprint:t.sourceReferenceFingerprint};
    }),
    resolveNormalization:input=>transaction(input.tenantId,async db=>{
      const t=await resolveFencedTemplate(db,input,'normalization',input.sourceAttemptId);return {operationCode:t.definition.operation_code,outputPolicy:t.definition.output_policy};
    }),
    recordProviderReference:input=>transaction(input.tenantId,async db=>{
      if(!Buffer.isBuffer(input.ciphertext)||input.ciphertext.length<30||input.ciphertext.length>4096||!Buffer.isBuffer(input.fingerprint)||input.fingerprint.length!==32)runDatabaseError('22023','RUN_PROVIDER_REFERENCE_INVALID');
      await lockLifecycleRun(db,input.tenantId,input.runId);const a=await requireLiveAttempt(db,input);
      if(a.kind!=='submission')runDatabaseError('P0001','RUN_ATTEMPT_FENCE_REJECTED');
      const existing=await db.query<{provider_reference_fingerprint:Buffer|null}>(`SELECT provider_reference_fingerprint FROM app.run_attempts WHERE organization_id=$1 AND id=$2`,[input.tenantId,input.attemptId]);
      const fingerprint=existing.rows[0]?.provider_reference_fingerprint;
      if(fingerprint){if(fingerprint.equals(input.fingerprint))return;runDatabaseError('23505','RUN_PROVIDER_REFERENCE_CONFLICT');}
      const r=await db.query(`UPDATE app.run_attempts SET provider_reference_ciphertext=$1,provider_reference_fingerprint=$2
        WHERE organization_id=$3 AND run_id=$4 AND id=$5 AND fence_token=$6 AND state='claimed' AND worker_lease_expires_at>clock_timestamp() RETURNING id`,
        [input.ciphertext,input.fingerprint,input.tenantId,input.runId,input.attemptId,input.fenceToken]);
      if(r.rows.length!==1)runDatabaseError('P0001','RUN_ATTEMPT_FENCE_REJECTED');
    }),
    isCancellationRequested:input=>transaction(input.tenantId,async db=>{
      const result=await db.query<{requested:boolean}>(`SELECT EXISTS(SELECT 1 FROM app.run_attempts a
        WHERE a.organization_id=$1 AND a.run_id=$2 AND a.id=$3 AND a.fence_token=$4 AND a.state='claimed' AND a.worker_lease_expires_at>clock_timestamp()
          AND EXISTS(SELECT 1 FROM app.run_events WHERE organization_id=$1 AND run_id=$2 AND event_type='cancellation_requested')) requested`,
        [input.tenantId,input.runId,input.attemptId,input.fenceToken]);return result.rows[0]?.requested===true;
    }),
    checkpointPoll:input=>transaction(input.tenantId,async db=>{
      const delay=input.delayMs??0;
      if(!Number.isSafeInteger(input.maxElapsedMs)||input.maxElapsedMs<1||input.maxElapsedMs>86400000||!Number.isSafeInteger(delay)||delay<0||
        input.status!==undefined&&!['starting','running','scheduled','building','ready','failed','canceled','not_ready','missing','unknown','read_failed','rate_limited'].includes(input.status))runDatabaseError('22023','PROVIDER_POLL_CHECKPOINT_INVALID');
      await lockLifecycleRun(db,input.tenantId,input.runId);const owner=await requireLiveAttempt(db,input);
      if(!['submission','reconciliation'].includes(owner.kind))runDatabaseError('40001','RUN_ATTEMPT_FENCE_REJECTED');
      const source=await db.query<{id:string;state:string;provider_reference_ciphertext:Buffer|null;provider_reference_fingerprint:Buffer|null}>(`SELECT id,state,provider_reference_ciphertext,provider_reference_fingerprint
        FROM app.run_attempts WHERE organization_id=$1 AND run_id=$2 AND id=$3 AND kind='submission' FOR UPDATE`,[input.tenantId,input.runId,input.sourceAttemptId]);
      const a=source.rows[0];if(!a||!a.provider_reference_ciphertext||!a.provider_reference_fingerprint||owner.kind==='submission'&&a.id!==owner.id||owner.kind==='reconciliation'&&a.state!=='ambiguous')runDatabaseError('40001','PROVIDER_POLL_SOURCE_REJECTED');
      const r=await db.query<{remaining_ms:string;wait_ms:string;provider_consecutive_failures:number}>(`UPDATE app.run_attempts SET
        provider_poll_deadline=coalesce(provider_poll_deadline,started_at+$1::bigint*interval '1 millisecond'),
        provider_last_status=coalesce($2,provider_last_status),provider_consecutive_failures=CASE WHEN $3::boolean IS TRUE THEN least(provider_consecutive_failures+1,1000000) WHEN $3::boolean IS FALSE THEN 0 ELSE provider_consecutive_failures END,
        provider_next_poll_at=CASE WHEN $2::text IS NULL THEN provider_next_poll_at ELSE clock_timestamp()+least($4::bigint,86400000)*interval '1 millisecond' END
        WHERE organization_id=$5 AND run_id=$6 AND id=$7 RETURNING floor(extract(epoch FROM (provider_poll_deadline-clock_timestamp()))*1000)::bigint::text remaining_ms,
          greatest(0,ceil(extract(epoch FROM (coalesce(provider_next_poll_at,clock_timestamp())-clock_timestamp()))*1000))::bigint::text wait_ms,provider_consecutive_failures`,
        [input.maxElapsedMs,input.status??null,input.failure??null,delay,input.tenantId,input.runId,input.sourceAttemptId]);
      const row=r.rows[0];if(!row||![Number(row.remaining_ms),Number(row.wait_ms),row.provider_consecutive_failures].every(Number.isSafeInteger))runDatabaseError('23514','PROVIDER_POLL_CHECKPOINT_INVALID');
      return {remainingMs:Number(row.remaining_ms),waitMs:Number(row.wait_ms),consecutiveFailures:row.provider_consecutive_failures};
    }),
  };
}
