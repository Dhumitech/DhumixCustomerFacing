import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseEnv} from 'node:util';
import {checkServerIdentity} from 'node:tls';
import pg from 'pg';
import {loadRuntimeConfig} from '../../src/config/environment.ts';
import {loadOutboxDispatcherConfig,loadJobManagerConfig} from '../../src/config/pattern4Environment.ts';
import {projectDeploymentEnvironment} from '../../src/deployment/environment.ts';

// Authenticate each deployed SQL capability without reading customer records or
// writing application data. No operator/admin credential enters this checker.
try {
  const args=process.argv.slice(2);
  if(args.length>1||args.some(arg=>!arg.startsWith('--env=')))throw new Error('Unsupported profile argument');
  const backend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
  const source=parseEnv(fs.readFileSync(path.resolve(backend,args[0]?.slice(6)||'.env.azure'),'utf8'));
  const api=loadRuntimeConfig(projectDeploymentEnvironment('api',source)).database;
  const outbox=loadOutboxDispatcherConfig(projectDeploymentEnvironment('outbox',source)).database;
  const jobs=loadJobManagerConfig(projectDeploymentEnvironment('jobs',source));
  const connections=[
    ['identity',api,api.identity],['customerApi',api,api.customerApi],['admission',api,api.admission],
    ['outbox',outbox,outbox.credential],['jobManager',jobs.database,jobs.database.credential],
    ['resultRecorder',jobs.resultRecorderDatabase,jobs.resultRecorderDatabase.credential],
  ];
  const checks=await Promise.all(connections.map(async ([role,config,credential])=>{
    if(!config.ssl||config.ssl.rejectUnauthorized!==true)throw new Error('Verified TLS required');
    const client=new pg.Client({host:config.host,port:config.port,database:config.database,
      user:credential.user,password:credential.password,ssl:config.ssl,
      connectionTimeoutMillis:10000,query_timeout:10000,application_name:'dhumi-readonly-connection-check',
      options:'-c default_transaction_read_only=on'});
    client.on('error',()=>{});
    try {
      await client.connect();
      const socket=client.connection.stream;
      if(!socket.authorized||checkServerIdentity(config.host,socket.getPeerCertificate()))throw new Error('TLS identity rejected');
      await client.query('BEGIN READ ONLY');
      await client.query('SET LOCAL statement_timeout=5000');
      const {rows:[row]}=await client.query(`SELECT current_database() AS database,
        current_setting('transaction_read_only')='on' AS read_only,
        (SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls_enabled,
        (SELECT count(*)::integer FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relkind='r') AS app_tables`);
      await client.query('ROLLBACK');
      if(row.database!==config.database||!row.read_only||!row.tls_enabled)throw new Error('Connection scope rejected');
      return {role,status:'passed',readOnly:true,tlsVerified:true,appTables:row.app_tables};
    } catch {
      await client.query('ROLLBACK').catch(()=>{});
      return {role,status:'failed'};
    } finally {await client.end().catch(()=>{});}
  }));
  const passed=checks.every(check=>check.status==='passed');
  console.log(JSON.stringify({status:passed?'passed':'failed',checks,databaseWrites:0,
    customerDataRead:false,otherSchemasRead:false,providerCalls:0,emailCalls:0},null,2));
  if(!passed)process.exitCode=1;
} catch {
  console.error('Verified database connection check rejected the configuration. No application data was changed.');
  process.exitCode=1;
}
