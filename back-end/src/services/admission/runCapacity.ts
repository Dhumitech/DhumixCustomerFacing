import type { DatabaseExecutor } from '../../types/database.js';
import type { ProviderEnvironment } from '../customerServices/createServiceRepository.js';
import type { TemplateEngine, TemplateExecutionDefinition } from '../catalogue/templateExecutionDefinition.js';

export interface RunCapacityRow {
  readonly estimated_amount_micros: string;
  readonly currency_code: 'USD';
  readonly unit: string;
  readonly evidence_reference: string;
}
export class RunCapacityPolicyError extends Error {
  public constructor(public readonly code: 'P5101'|'P5102'|'P5103'|'P5104') { super('Run admission capacity is unavailable'); }
}
const fail=(code:'P5101'|'P5102'|'P5103'|'P5104'):never=>{throw new RunCapacityPolicyError(code);};
function integer(policy:Record<string,unknown>,field:string,max:bigint,zero=false):bigint {
  const value=policy[field];
  if(typeof value!=='number' || !Number.isSafeInteger(value) || value<(zero?0:1) || BigInt(value)>max) return fail('P5104');
  return BigInt(value);
}

/** Locks span capacity checks and the caller's Run/audit/outbox commit. No egress. */
export async function selectRunCapacity(database:DatabaseExecutor,input:{
  readonly engine:TemplateEngine;readonly definition:TemplateExecutionDefinition;
  readonly providerEnvironment:ProviderEnvironment;readonly tenantId:string;readonly templateVersionId:string;
  readonly validatedInput:Readonly<Record<string,unknown>>;
}):Promise<RunCapacityRow> {
  if(!['local','test'].includes(input.providerEnvironment))return fail('P5104');
  await database.query(`SELECT pg_advisory_xact_lock(hashtextextended('phase5_mock_admission_v1:' || $1,0))`,[input.providerEnvironment]);
  const health=await database.query<{pending_jobs:string;stale:boolean}>(`
    SELECT pending_jobs::text,(oldest_due_job<statement_timestamp()-interval '300 seconds') AS stale FROM app.admission_queue_health`);
  if(!health.rows[0] || !/^\d+$/.test(health.rows[0].pending_jobs))return fail('P5104');
  if(health.rows[0].stale)return fail('P5103');
  if(BigInt(health.rows[0].pending_jobs)>=100n)return fail('P5102');
  const recent=await database.query<{n:string}>(`SELECT count(*)::text n FROM app.runs WHERE organization_id=$1 AND created_at>=statement_timestamp()-interval '60 seconds'`,[input.tenantId]);
  if(!recent.rows[0])return fail('P5104');
  if(BigInt(recent.rows[0].n)>=30n)return fail('P5101');
  if(input.engine==='amazon.v1')return {estimated_amount_micros:'0',currency_code:'USD',unit:'mock_run',evidence_reference:'phase5_mock_admission_v1'};
  const value=input.definition.output_policy.scraper_spending;
  if(!value || typeof value!=='object' || Array.isArray(value))return fail('P5104');
  const policy=value as Record<string,unknown>;
  const keys=['version','evidenceId','maxInputsPerRun','maxRecordsPerInput','maxRunsPerDay','maxConcurrentRuns','upperBoundMicrosPerRecord','fixedUpperBoundMicros','maximumHoldMicros','currencyCode'];
  if(Object.keys(policy).length!==keys.length || keys.some(k=>!(k in policy)) || policy.version!==input.definition.commercial_config_version ||
    policy.currencyCode!=='USD' || typeof policy.evidenceId!=='string' || !/^[0-9a-f-]{36}$/i.test(policy.evidenceId))return fail('P5104');
  const maxInputs=integer(policy,'maxInputsPerRun',999n),maxRecords=integer(policy,'maxRecordsPerInput',999999n),
    maxDaily=integer(policy,'maxRunsPerDay',99999n),maxConcurrent=integer(policy,'maxConcurrentRuns',9999n),
    perRecord=integer(policy,'upperBoundMicrosPerRecord',9999999999999n),fixed=integer(policy,'fixedUpperBoundMicros',9999999999999n,true),
    maximum=integer(policy,'maximumHoldMicros',99999999999999n);
  const rules=input.definition.output_policy.scraper_processing as {request?:Record<string,unknown>}|undefined;
  if(!rules?.request)return fail('P5104');
  const limit=integer(rules.request,'limitPerInput',999999n);
  const targets=input.validatedInput.targets;
  if(!Array.isArray(targets) || !targets.length || targets.length>20)return fail('P5104');
  if(maxInputs>20n || maxRecords>1000n || maxDaily>1000n || maxConcurrent>100n || limit>maxRecords || BigInt(targets.length)>maxInputs)return fail('P5101');
  const estimate=fixed+BigInt(targets.length)*limit*perRecord;
  if(estimate>maximum || estimate>9223372036854775807n)return fail('P5101');
  // One source mapping per version is a contraction precondition. Version replaces its former mapping scope.
  await database.query(`SELECT pg_advisory_xact_lock(hashtextextended('shared-scraper-capacity:' || $1 || ':' || $2,0))`,[input.tenantId,input.templateVersionId]);
  const totals=await database.query<{daily:string;active:string}>(`
    SELECT count(*) FILTER (WHERE created_at>=clock_timestamp()-interval '24 hours')::text daily,
      count(*) FILTER (WHERE internal_status IN ('QUEUED','SUBMITTED','RESULT_RECEIVED','PROCESSING'))::text active
    FROM app.runs WHERE organization_id=$1 AND template_version_id=$2`,[input.tenantId,input.templateVersionId]);
  if(!totals.rows[0])return fail('P5104');
  if(BigInt(totals.rows[0].daily)>=maxDaily || BigInt(totals.rows[0].active)>=maxConcurrent)return fail('P5101');
  return {estimated_amount_micros:estimate.toString(),currency_code:'USD',unit:'provider_records_upper_bound',evidence_reference:policy.evidenceId};
}