import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { describe,it,expect,vi } from 'vitest';
import { customerContextFixture } from '../helpers/customerContextFixture.js';
import { createRunRepository,RunAdmissionUnavailableError,RunInputRejectedError,type CreateRunPersistenceInput } from '../../src/services/admission/createRunRepository.js';
import { createRetryRunRepository,RunRetryInputRejectedError,RunRetryUnavailableError } from '../../src/services/admission/retryRunRepository.js';
import { templateExecutionDefinitionHash,type TemplateExecutionDefinition } from '../../src/services/catalogue/templateExecutionDefinition.js';
import { scraperContractHash,type ScraperOperationContract } from '../../src/services/scrapers/scraperProcessing.js';
const packet=JSON.parse(readFileSync(new URL('../fixtures/scraper-operations/target.json',import.meta.url),'utf8')) as {contract:ScraperOperationContract;input:Record<string,unknown>};
packet.contract = { ...packet.contract, processing: { ...packet.contract.processing, request: { ...packet.contract.processing.request, limitPerInput: 10 } } };
const definition:TemplateExecutionDefinition={
  capability_metadata:{},request_schema:packet.contract.inputSchema,result_schema:packet.contract.outputSchema,error_schema:{},
  operation_code:packet.contract.operationCode,config_version:'fixture',commercial_config_version:'fixture',
  output_policy:{scraper_processing:packet.contract.processing,scraper_contract_sha256:scraperContractHash(packet.contract),
    scraper_spending:{version:'fixture',evidenceId:randomUUID(),maxInputsPerRun:20,maxRecordsPerInput:1000,maxRunsPerDay:1000,maxConcurrentRuns:100,
      upperBoundMicrosPerRecord:1,fixedUpperBoundMicros:0,maximumHoldMicros:100000,currencyCode:'USD'}}
};
function fixture(options:{row?:Record<string,unknown>;input?:Record<string,unknown>;pending?:string;stale?:boolean;recent?:string;missing?:boolean;ambiguous?:boolean;trace?:string|null}={}) {
  const trace=randomUUID(),tenant=randomUUID(),service=randomUUID(),template=randomUUID();
  const accepted={run_id:randomUUID(),status:'queued',accepted_at:'2026-10-07T00:00:00.000Z'};
  const row={service_id:service,service_state:'active',template_version_id:template,template_state:'published',product_family:'scraper_library',
    input_schema:packet.contract.inputSchema,template_version_available:true,engine:'scraper.v1',execution_definition:definition,definition_sha256:templateExecutionDefinitionHash(definition),
    dataset_bound:true,publication_approved:true,is_internal:false,...options.row};
  const query=vi.fn(async(sql:string,values:readonly unknown[]=[])=>{
    const context=customerContextFixture(sql,values);if(context!==undefined)return context;
    let rows:Record<string,unknown>[]=[];
    if(sql.includes('INSERT INTO app.idempotency_records'))rows=[{id:'claim'}];
    else if(sql.includes('FROM app.services AS service'))rows=[row];
    else if(sql.includes('FROM app.runs run'))rows=[{run_id:'source',service_id:service,validated_input:options.input??packet.input,public_status:'failed',internal_status:'UPSTREAM_FAILED',retryable:true,completed_at:new Date()}];
    else if(sql.includes('SELECT state FROM app.run_attempts'))rows=options.ambiguous?[{state:'ambiguous'}]:[];
    else if(sql.includes('FROM app.admission_queue_health'))rows=options.missing?[]:[{pending_jobs:options.pending??'0',stale:options.stale??false}];
    else if(sql.includes('count(*)::text n'))rows=[{n:options.recent??'0'}];
    else if(sql.includes('::text daily'))rows=[{daily:'0',active:'0'}];
    else if(sql.includes('INSERT INTO app.runs'))rows=[{created_at:new Date(accepted.accepted_at)}];
    else if(sql.includes('UPDATE app.idempotency_records'))rows=[{response_body:accepted}];
    return {rows,rowCount:rows.length};
  });
  const release=vi.fn(),pool={connect:vi.fn(async()=>({query,release}))} as unknown as Pool;
  const validateInput=vi.fn(()=>({valid:true as const}));
  const input:CreateRunPersistenceInput={idempotencyRecordId:randomUUID(),runId:accepted.run_id,runEventId:randomUUID(),outboxEventId:randomUUID(),
    tenantId:tenant,actor:{kind:'browser',userId:randomUUID()},actorFingerprint:Buffer.alloc(32),requestHash:Buffer.alloc(32),idempotencyKey:'fixture-key-00001',
    serviceId:service,input:options.input??packet.input,providerEnvironment:'test',requestId:options.trace===undefined?trace:options.trace,ipFingerprint:null,validateInput};
  const run=(operation:'create'|'retry')=>operation==='create'?createRunRepository(pool).persist(input):createRetryRunRepository(pool).persist({...input,sourceRunId:'source'});
  return {input,query,release,run,validateInput};
}
describe('0073 direct admission',()=>{
  it.each(['create','retry'] as const)('attributes %s and writes only admitted Run columns atomically',async operation=>{
    const f=fixture();await expect(f.run(operation)).resolves.toMatchObject({kind:'created'});
    const calls=f.query.mock.calls,insert=calls.find(([sql])=>sql.includes('INSERT INTO app.runs'))!;
    expect(insert[0]).not.toMatch(/adapter_version_id|provider_mapping_id|internal_status|state_version|retryable|cost_state|created_at,/);
    expect(insert[1]![4]).toBe(f.input.actor.userId);expect(insert[1]![5]).toBe(f.input.requestId);
    if(operation==='retry')expect(insert[1]!.at(-1)).toBe('source');
    expect(calls.filter(([sql])=>sql.includes('INSERT INTO app.outbox_events'))).toHaveLength(1);
    expect(calls.some(([sql])=>/provider_cost_holds|app\.require_.*capacity/.test(sql))).toBe(false);
    expect(calls.findIndex(([sql])=>sql.includes('phase5_mock_admission_v1:'))).toBeLessThan(calls.findIndex(([sql])=>sql.includes('FROM app.admission_queue_health')));
    expect(calls.at(-1)?.[0]).toBe('COMMIT');expect(f.release).toHaveBeenCalledOnce();expect(f.validateInput).not.toHaveBeenCalled();
  });
  for(const operation of ['create','retry'] as const){
    it('rejects invalid shared URLs before '+operation,async()=>{const f=fixture({input:{targets:[{url:'https://attacker.example/p/product',zipcode:'01011'}]}});await expect(f.run(operation)).rejects.toBeInstanceOf(operation==='create'?RunInputRejectedError:RunRetryInputRejectedError);expect(f.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO app.runs'))).toBe(false);expect(f.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');});
    it.each([{engine:'unknown.v1'},{dataset_bound:false},{definition_sha256:Buffer.alloc(32,255)},{publication_approved:false},{execution_definition:null},{product_family:'marketplace_dataset'}])('fails closed for incomplete '+operation+' %j',async row=>{const f=fixture({row});await expect(f.run(operation)).rejects.toBeInstanceOf(operation==='create'?RunAdmissionUnavailableError:RunRetryUnavailableError);expect(f.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO app.runs'))).toBe(false);});
    it.each([{pending:'100'},{stale:true},{recent:'30'},{missing:true}])('refuses capacity '+operation+' %j',async values=>{const f=fixture(values);await expect(f.run(operation)).rejects.toBeDefined();expect(f.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO app.runs'))).toBe(false);expect(f.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');});
    it('requires a server trace after checking membership for '+operation,async()=>{const f=fixture({trace:null});await expect(f.run(operation)).rejects.toBeInstanceOf(operation==='create'?RunAdmissionUnavailableError:RunRetryUnavailableError);expect(f.query.mock.calls.some(([sql])=>sql.includes('FROM app.organization_members'))).toBe(true);expect(f.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO app.idempotency_records'))).toBe(false);expect(f.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');});
  }
  it('keeps Amazon input validation and the original zero-cost test profile',async()=>{const f=fixture({row:{engine:'amazon.v1'}});await f.run('create');expect(f.validateInput).toHaveBeenCalledOnce();expect(f.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO app.runs'))?.[1]?.[8]).toBe('0');});
  it('refuses to retry an ambiguous source',async()=>{const f=fixture({ambiguous:true});await expect(f.run('retry')).rejects.toBeDefined();expect(f.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO app.runs'))).toBe(false);});
});
