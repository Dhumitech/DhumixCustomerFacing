import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import { projectDeploymentEnvironment } from '../../dist/deployment/environment.js';
import { loadRuntimeConfig } from '../../dist/config/environment.js';
import { loadOutboxDispatcherConfig, loadJobManagerConfig } from '../../dist/config/pattern4Environment.js';
import { loadOrganizationWorkflowConfig, loadOrganizationCollaborationEnabled } from '../../dist/config/organizationEnvironment.js';

const backend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const entries={api:'dist/server.js',outbox:'dist/worker/outboxDispatcher.js',jobs:'dist/worker/jobManager.js'};
try {
  const mode=process.argv[2];
  if(!['check',...Object.keys(entries)].includes(mode))throw new Error('Choose check, api, outbox or jobs');
  const args=process.argv.slice(3);
  if(args.length>1||args.some(a=>!a.startsWith('--env=')))throw new Error('Only --env=/private/file is supported');
  const profile=path.resolve(backend,args[0]?.slice(6)||'.env.azure');
  const source=parseEnv(fs.readFileSync(profile,'utf8'));
  const loaders={api:loadRuntimeConfig,outbox:loadOutboxDispatcherConfig,jobs:loadJobManagerConfig};
  const validate=role=>{
    const env=projectDeploymentEnvironment(role,source);
    const config=loaders[role](env);
    if(role==='api'){loadOrganizationWorkflowConfig(env);loadOrganizationCollaborationEnabled(env);}
    return {env,config};
  };
  if(mode==='check') {
    const api=validate('api'),outbox=validate('outbox'),jobs=validate('jobs');
    console.log(JSON.stringify({status:'passed',profile,configurationOnly:true,
      mode:api.env.DEMO_DISABLE_OTP==='true'?'demo without OTP':'normal authentication',
      database:api.config.database.database,tls:api.env.DATABASE_SSL_MODE,
      blob:api.config.resultStorage.driver,queue:outbox.config.serviceBus.driver,
      executor:jobs.config.executor.driver,processProfiles:3,
      databaseConnections:0,providerCalls:0,emailCalls:0},null,2));
  } else {
    const {env}=validate(mode);
    const child=spawn(process.execPath,[path.join(backend,entries[mode])],{cwd:backend,env,windowsHide:true,stdio:'inherit'});
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>child.kill(signal));
    child.once('error',()=>{console.error('Backend process launch failed.');process.exitCode=1;});
    child.once('exit',code=>{process.exitCode=code??1;});
  }
} catch {
  // Neither env values nor raw configuration/SDK errors belong in output.
  console.error('Deployment configuration is missing or rejected. Use the documented private profile and build first.');
  process.exitCode=1;
}
