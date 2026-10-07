import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool } from 'pg';
import type { ControlledRunExecutor } from '../jobs/controlledRunExecutor.js';
import { createProviderCallRecorder,type ProviderCallRecorder } from './providerCallRepository.js';

const calls=new AsyncLocalStorage<ProviderCallRecorder>();
export function currentProviderCallRecorder():ProviderCallRecorder {
  const recorder=calls.getStore();if(!recorder)throw new Error('Provider egress requires a fenced Run call context');return recorder;
}
export function withProviderCallRecording<Result>(recorder:ProviderCallRecorder,work:()=>Promise<Result>):Promise<Result> {
  return calls.run(recorder,work);
}
/** One recorder per worker operation, isolated across concurrent Runs. */
export function createRecordedRunExecutor(pool:Pool,executor:ControlledRunExecutor):ControlledRunExecutor {
  return {
    completionOutcomeClass:executor.completionOutcomeClass,
    persistRaw:input=>withProviderCallRecording(createProviderCallRecorder(pool,input),()=>executor.persistRaw(input)),
    persistNormalized:input=>withProviderCallRecording(createProviderCallRecorder(pool,input),()=>executor.persistNormalized(input)),
    ...(executor.recoverRaw?{recoverRaw:input=>withProviderCallRecording(createProviderCallRecorder(pool,input),()=>executor.recoverRaw!(input))}:{}),
  };
}
