import type { DatabaseExecutor } from '../../types/database.js';
import { lockLifecycleRun,requireLiveAttempt,runDatabaseError } from '../jobs/runLifecycle.js';
import { requireExecutableTemplate,type TemplateExecutionDefinition,type TemplateEngine } from '../catalogue/templateExecutionDefinition.js';

export interface FencedTemplateExecution {
  readonly templateVersionId:string;readonly engine:TemplateEngine;readonly definition:TemplateExecutionDefinition;
  readonly input:Readonly<Record<string,unknown>>;readonly datasetCiphertext:Buffer;readonly datasetFingerprint:Buffer;
  readonly sourceAttemptId:string;readonly sourceReferenceCiphertext:Buffer|null;readonly sourceReferenceFingerprint:Buffer|null;
}
interface TemplateRow {
  readonly template_version_id:string;readonly product_family:string;readonly engine:string|null;readonly execution_definition:unknown;
  readonly definition_sha256:Buffer|null;readonly provider_dataset_ciphertext:Buffer|null;readonly provider_dataset_fingerprint:Buffer|null;
  readonly validated_input:Readonly<Record<string,unknown>>;readonly submission_allowed:boolean;
}
export async function resolveFencedTemplate(db:DatabaseExecutor,input:{tenantId:string;runId:string;attemptId:string;fenceToken:string},
  phase:'submission'|'normalization'|'reconciliation',sourceAttemptId?:string):Promise<FencedTemplateExecution> {
  const run=await lockLifecycleRun(db,input.tenantId,input.runId);
  const owner=await requireLiveAttempt(db,input);
  if(phase==='submission'&&(owner.kind!=='submission'||run.internal_status!=='SUBMITTED') ||
    phase==='normalization'&&run.internal_status!=='PROCESSING' ||
    phase==='reconciliation'&&(owner.kind!=='reconciliation'||!['SUBMITTED','RESULT_RECEIVED','PROCESSING'].includes(run.internal_status)))runDatabaseError('P0002','RUN_PROVIDER_EXECUTION_PLAN_NOT_AVAILABLE');
  const result=await db.query<TemplateRow>(`SELECT v.id template_version_id,t.product_family,v.engine,v.execution_definition,v.definition_sha256,
    v.provider_dataset_ciphertext,v.provider_dataset_fingerprint,r.validated_input,
    (s.state='active' AND o.state='active' AND (v.availability_state='available' OR t.state='draft' AND o.is_internal AND v.availability_state='coming_soon') AND
     (t.state='published' AND v.published_at IS NOT NULL AND v.published_at<=statement_timestamp() AND v.published_by IS NOT NULL AND v.evidence_ref IS NOT NULL OR t.state='draft' AND o.is_internal)
     AND (t.access='all' OR EXISTS(SELECT 1 FROM app.organization_templates a WHERE a.organization_id=$1 AND a.service_template_id=t.id))) submission_allowed
    FROM app.runs r JOIN app.services s ON s.organization_id=r.organization_id AND s.id=r.service_id AND s.template_version_id=r.template_version_id
    JOIN app.organizations o ON o.id=s.organization_id JOIN app.service_template_versions v ON v.id=r.template_version_id
    JOIN app.service_templates t ON t.id=v.service_template_id WHERE r.organization_id=$1 AND r.id=$2 FOR SHARE OF s,t`,[input.tenantId,input.runId]);
  const row=result.rows[0];if(!row || phase==='submission'&&!row.submission_allowed)runDatabaseError('P0002','RUN_PROVIDER_EXECUTION_PLAN_NOT_AVAILABLE');
  const executable=requireExecutableTemplate({productFamily:row.product_family,engine:row.engine,definition:row.execution_definition,
    definitionSha256:row.definition_sha256,datasetCiphertext:row.provider_dataset_ciphertext,datasetFingerprint:row.provider_dataset_fingerprint});
  let source;
  if(phase==='reconciliation'){
    const r=await db.query<{id:string;provider_reference_ciphertext:Buffer|null;provider_reference_fingerprint:Buffer|null}>(`SELECT id,provider_reference_ciphertext,provider_reference_fingerprint
      FROM app.run_attempts WHERE organization_id=$1 AND run_id=$2 AND kind='submission' AND state='ambiguous' ORDER BY attempt_number DESC LIMIT 1 FOR UPDATE`,[input.tenantId,input.runId]);
    source=r.rows[0];
    if(!source || !source.provider_reference_ciphertext || !source.provider_reference_fingerprint)runDatabaseError('P0002','RUN_PROVIDER_RECONCILIATION_PLAN_NOT_AVAILABLE');
  }else{
    const r=await db.query<{id:string;provider_reference_ciphertext:Buffer|null;provider_reference_fingerprint:Buffer|null}>(`SELECT id,provider_reference_ciphertext,provider_reference_fingerprint
      FROM app.run_attempts WHERE organization_id=$1 AND run_id=$2 AND id=$3 AND kind='submission'`,[input.tenantId,input.runId,sourceAttemptId??input.attemptId]);
    source=r.rows[0];if(!source)runDatabaseError('P0002','RUN_PROVIDER_SOURCE_NOT_AVAILABLE');
    if(phase==='normalization'){
      const raw=await db.query(`SELECT id FROM app.artifacts WHERE organization_id=$1 AND run_id=$2 AND attempt_id=$3 AND kind='raw' AND state='durable' LIMIT 1`,[input.tenantId,input.runId,source.id]);
      if(!raw.rows.length)runDatabaseError('P0002','RUN_PROVIDER_NORMALIZATION_PLAN_NOT_AVAILABLE');
    }
  }
  return {templateVersionId:row.template_version_id,engine:executable.engine,definition:executable.definition,input:row.validated_input,
    datasetCiphertext:row.provider_dataset_ciphertext!,datasetFingerprint:row.provider_dataset_fingerprint!,sourceAttemptId:source.id,
    sourceReferenceCiphertext:source.provider_reference_ciphertext,sourceReferenceFingerprint:source.provider_reference_fingerprint};
}
