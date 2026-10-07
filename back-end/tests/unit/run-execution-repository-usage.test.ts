import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createRunExecutionRepository } from '../../src/services/jobs/runExecutionRepository.js';
const tenantId='11111111-1111-4111-8111-111111111111',runId='22222222-2222-4222-8222-222222222222';
const attemptId='33333333-3333-4333-8333-333333333333',fenceToken='44444444-4444-4444-8444-444444444444';
const input={tenantId,runId,attemptId,fenceToken,expectedStateVersion:3,eventIdempotencyKey:'job.completed.v1:attempt',
  outcomeClass:'provider_execution_completed',normalizedArtifactId:'55555555-5555-4555-8555-555555555555',
  usage:{meterCode:'amazon.result_records.observed',unit:'records'},safePayload:{status:'ready'}};
function pool(options:{records?:string;missingArtifact?:boolean;live?:boolean}={}) {
 const query=vi.fn(async(sql:string,_values?:readonly unknown[])=>{
  let rows:unknown[]=[];
  if(sql.includes('AS organization_id'))rows=[{organization_id:tenantId}];
  if(sql.includes('FROM app.runs')&&sql.includes('FOR UPDATE'))rows=[{id:runId,organization_id:tenantId,internal_status:'PROCESSING',state_version:'3',cost_state:'held'}];
  if(sql.includes('FROM app.run_attempts')&&sql.includes('FOR UPDATE'))rows=[{id:attemptId,kind:'submission',state:'claimed',fence_token:fenceToken,live:options.live??true}];
  if(sql.includes('FROM app.artifacts'))rows=options.missingArtifact?[]:[{record_count:options.records??'0',created_at:new Date('2026-10-07T00:00:00Z')}];
  if(sql.includes('quantity_matches'))rows=[{run_id:runId,quantity_matches:true,unit:'records',reconciliation_state:'observed'}];
  if(sql.includes('UPDATE app.runs SET internal_status'))rows=[{internal_status:'COMPLETED',state_version:'4'}];
  if(sql.includes('UPDATE app.run_attempts SET state='))rows=[{id:attemptId}];
  return {rows,rowCount:rows.length};
 });
 return {instance:{connect:vi.fn(async()=>({query,release:vi.fn()}))} as unknown as Pool,query};
}
describe('Run completion derives usage from validated artifacts',()=>{
 it('records zero records without inventing quantity and completes in one transaction',async()=>{
  const fake=pool();
  await expect(createRunExecutionRepository(fake.instance).completeSuccess(input)).resolves.toEqual({stateVersion:4,internalStatus:'COMPLETED',publicStatus:'ready'});
  const usage=fake.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO app.usage_events'));
  expect(usage?.[1]).toEqual([tenantId,runId,attemptId,'amazon.result_records.observed','0','records',new Date('2026-10-07T00:00:00Z')]);
  expect(fake.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
 });
 it('refuses missing artifact evidence before any lifecycle mutation',async()=>{
  const fake=pool({missingArtifact:true});
  await expect(createRunExecutionRepository(fake.instance).completeSuccess(input)).rejects.toMatchObject({code:'23514'});
  expect(fake.query.mock.calls.some(([sql])=>sql.includes('UPDATE app.runs SET internal_status'))).toBe(false);
  expect(fake.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
 });
 it('refuses an expired worker fence before reading artifacts or recording usage',async()=>{
  const fake=pool({live:false});
  await expect(createRunExecutionRepository(fake.instance).completeSuccess(input)).rejects.toMatchObject({code:'40001'});
  expect(fake.query.mock.calls.some(([sql])=>sql.includes('FROM app.artifacts'))).toBe(false);
  expect(fake.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
 });
});
