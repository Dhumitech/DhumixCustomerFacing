import fs from 'node:fs';
import pg from 'pg';
import {checkServerIdentity} from 'node:tls';
import {createClient} from 'redis';
import {loadRuntimeConfig} from '../../dist/config/environment.js';
import {loadOutboxDispatcherConfig, loadJobManagerConfig} from '../../dist/config/pattern4Environment.js';
import {configuredAzureBlobService} from '../../dist/services/storage/resultStorageComposition.js';
import {createConfiguredServiceBusClient} from '../../dist/services/jobs/serviceBusExecutionQueue.js';

// Mount this file read-only at /app/scripts/azure/check-docker-rehearsal.mjs
// in a one-off container. It uses only that container's scoped runtime secret.
const role = process.argv[2];
const checks = [];
async function database(name, config, credential) {
  if (config.database !== 'dhumi_shared' || !config.ssl?.rejectUnauthorized) throw new Error('Rejected database scope');
  const client = new pg.Client({host: config.host, port: config.port, database: config.database,
    user: credential.user, password: credential.password,
    ssl: {...config.ssl, checkServerIdentity: (_hostname, certificate) => checkServerIdentity(config.host, certificate)},
    application_name: 'dhumi-docker-readonly-check', connectionTimeoutMillis: 10000, query_timeout: 10000,
    options: '-c default_transaction_read_only=on'});
  client.on('error', () => {});
  try {
    await client.connect();
    if (!client.connection.stream.authorized || checkServerIdentity(config.host, client.connection.stream.getPeerCertificate())) throw new Error('Rejected TLS');
    await client.query('BEGIN READ ONLY');
    await client.query('SET LOCAL statement_timeout=5000');
    const {rows: [row]} = await client.query(`SELECT current_database() AS database,
      current_setting('transaction_read_only')='on' AS read_only,
      (SELECT count(*)::integer FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relkind='r') AS tables`);
    if (row.database !== 'dhumi_shared' || !row.read_only || row.tables !== 25) throw new Error('Rejected baseline');
    checks.push({check: name, tlsVerified: true, readOnly: true, appTables: row.tables});
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
}
async function blob(config) {
  if (config.driver !== 'azure_blob') throw new Error('Real Blob required');
  const {service, container} = await configuredAzureBlobService(config);
  await container.listBlobsFlat().byPage({maxPageSize: 1}).next();
  const now = new Date();
  await service.getUserDelegationKey(new Date(now.valueOf() - 30000), new Date(now.valueOf() + 60000));
  checks.push({check: 'Azure Blob authentication/read/delegation', passed: true});
}
async function queue(config, send) {
  if (config.driver !== 'azure') throw new Error('Real Service Bus required');
  const client = createConfiguredServiceBusClient(config);
  const link = send ? client.createSender(config.queueName) : client.createReceiver(config.queueName, {receiveMode: 'peekLock'});
  try {
    if (send) await link.createMessageBatch();
    else await link.peekMessages(1);
    checks.push({check: send ? 'Azure queue sender authentication' : 'Azure queue receiver peek', passed: true});
  } finally {await link.close(); await client.close();}
}
async function redis(url) {
  if (!url?.startsWith('rediss://')) throw new Error('Secured Redis required');
  const client = createClient({url, disableOfflineQueue: true, socket: {tls: true, minVersion: 'TLSv1.2', rejectUnauthorized: true, connectTimeout: 10000, reconnectStrategy: false}});
  client.on('error', () => {});
  try {
    await client.connect();
    if (await client.ping() !== 'PONG') throw new Error('Redis ping failed');
    checks.push({check: 'Azure Redis TLS/authentication/PING', passed: true});
  } finally {if (client.isReady) await client.quit(); else if (client.isOpen) client.destroy();}
}
try {
  const env = JSON.parse(fs.readFileSync('/run/secrets/runtime.json', 'utf8'));
  if (env.NODE_ENV !== 'test' || env.DEMO_DISABLE_OTP !== 'true') throw new Error('Retain demo mode');
  if (role === 'api') {
    const config = loadRuntimeConfig(env);
    for (const name of ['identity', 'customerApi', 'admission']) await database(name, config.database, config.database[name]);
    await blob(config.resultStorage);
  } else if (role === 'outbox') {
    const config = loadOutboxDispatcherConfig(env);
    await database('outbox', config.database, config.database.credential);
    await queue(config.serviceBus, true);
  } else if (role === 'jobs') {
    const config = loadJobManagerConfig(env);
    if (config.executor.driver !== 'bright_data') throw new Error('Real executor required');
    await database('jobManager', config.database, config.database.credential);
    await database('resultRecorder', config.resultRecorderDatabase, config.resultRecorderDatabase.credential);
    await blob(config.resultStorage);
    await queue(config.serviceBus, false);
    await redis(env.REDIS_URL);
  } else throw new Error('Unknown role');
  console.log(JSON.stringify({status: 'passed', role, checks, sqlWrites: 0, blobWrites: 0,
    queueMessagesSent: 0, queueMessagesConsumed: 0, redisWrites: 0, providerCalls: 0, emailCalls: 0}));
} catch {
  console.error(JSON.stringify({status: 'failed', role, completedChecks: checks.map(c => c.check), mutationsByChecker: 0}));
  process.exitCode = 1;
}
