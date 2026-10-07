import type { Pool } from 'pg';
import { withJobManagerTenantTransaction } from '../../database/transactions.js';
import type { ControlledRunExecutionInput } from '../../jobs/controlledRunExecutor.js';
import { lockLifecycleRun,requireLiveAttempt,runDatabaseError } from '../../jobs/runLifecycle.js';
import type { ProviderExecutionPlanRepository } from '../providerExecutionPlanRepository.js';
import { resolveFencedTemplate } from '../fencedTemplateExecution.js';
import { TEMPLATE_ENGINE_IDENTITIES } from '../engines.js';
import { ScraperContractError } from '../../scrapers/scraperProcessing.js';
export interface ScraperAdapterIdentity {readonly code:string;readonly version:string;readonly digest:string}
export type ScraperExecutionPhase='submission'|'normalization'|'reconciliation';
export interface ScraperExecutionPlan {
  readonly identity:ScraperAdapterIdentity;readonly contract:unknown;readonly contractHash:string;
  readonly validatedInput:Readonly<Record<string,unknown>>;readonly providerEnvironment:string;readonly templateVersionId:string;
  readonly datasetCiphertext:Buffer|null;readonly datasetFingerprint:Buffer|null;readonly secretReference:string|null;
  readonly sourceAttemptId:string;readonly sourceProviderReferenceCiphertext:Buffer|null;readonly sourceProviderReferenceFingerprint:Buffer|null;
}
export interface ScraperExecutionRepository extends Pick<ProviderExecutionPlanRepository,'checkpointPoll'|'recordProviderReference'|'isCancellationRequested'> {
  resolveIdentity(input:ControlledRunExecutionInput):Promise<ScraperAdapterIdentity>;
  resolvePlan(input:ControlledRunExecutionInput,phase:ScraperExecutionPhase,sourceAttemptId?:string):Promise<ScraperExecutionPlan>;
}
function identity(engine:string|null):ScraperAdapterIdentity {
  if(engine==='amazon.v1'||engine==='scraper.v1')return TEMPLATE_ENGINE_IDENTITIES[engine];
  throw new ScraperContractError();
}
export function createScraperExecutionRepository(pool:Pool,fenced:Pick<ProviderExecutionPlanRepository,'checkpointPoll'|'recordProviderReference'|'isCancellationRequested'>,
  providerEnvironment:'local'|'test'|'production'='test'):ScraperExecutionRepository {
  return {
    ...fenced,
    resolveIdentity:input=>withJobManagerTenantTransaction(pool,input.tenantId,async db=>{
      const run=await lockLifecycleRun(db,input.tenantId,input.runId);await requireLiveAttempt(db,input);
      const result=await db.query<{engine:string|null}>(`SELECT engine FROM app.service_template_versions WHERE id=$1`,[run.template_version_id]);
      if(!result.rows[0])runDatabaseError('P0002','RUN_EXECUTOR_IDENTITY_NOT_FOUND');return identity(result.rows[0].engine);
    }),
    resolvePlan:(input,phase,sourceAttemptId)=>withJobManagerTenantTransaction(pool,input.tenantId,async db=>{
      const template=await resolveFencedTemplate(db,input,phase,sourceAttemptId);
      const policy=template.definition.output_policy;
      if(template.engine!=='scraper.v1'||typeof policy.scraper_contract_sha256!=='string'||!/^[a-f0-9]{64}$/.test(policy.scraper_contract_sha256))throw new ScraperContractError();
      return {identity:identity(template.engine),contract:{operationCode:template.definition.operation_code,inputSchema:template.definition.request_schema,
        outputSchema:template.definition.result_schema,processing:policy.scraper_processing},contractHash:policy.scraper_contract_sha256,
        validatedInput:template.input,providerEnvironment,templateVersionId:template.templateVersionId,
        datasetCiphertext:template.datasetCiphertext,datasetFingerprint:template.datasetFingerprint,secretReference:'BRIGHTDATA_API_KEY',
        sourceAttemptId:template.sourceAttemptId,sourceProviderReferenceCiphertext:template.sourceReferenceCiphertext,sourceProviderReferenceFingerprint:template.sourceReferenceFingerprint};
    }),
  };
}
