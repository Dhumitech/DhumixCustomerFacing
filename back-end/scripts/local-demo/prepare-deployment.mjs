import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import { BlobServiceClient } from '@azure/storage-blob';
import { jobCommandEnvelopeSchema } from '../../src/services/jobs/jobCommand.ts';
import { sourceEnvironment, processEnvironment, backend, root, database, verifyTarget, capture, sha, assert, command, literal, identifier, protectRuntime } from './common.mjs';

const publicOrigin = process.argv.find(arg => arg.startsWith('--public-origin='))?.slice(16);
assert(publicOrigin, 'Supply --public-origin=https://your-demo-host or a loopback rehearsal origin');
const url = new URL(publicOrigin);
const local = ['localhost', '127.0.0.1'].includes(url.hostname);
assert(url.origin === publicOrigin && (url.protocol === 'https:' || (local && url.protocol === 'http:')), 'Public origin must be HTTPS or loopback HTTP');
const name = process.argv.find(arg => arg.startsWith('--name='))?.slice(7) ?? 'hosted-demo';
assert(/^[a-z][a-z0-9-]{0,63}$/.test(name), 'Use a simple private export directory name');
const directory = path.join(backend, '.runtime', name);
assert(!fs.existsSync(path.join(directory, 'prepared.json')), 'A prepared export exists; preserve it and choose a new directory before another export');
fs.mkdirSync(path.join(directory, 'restore/blobs'), { recursive: true, mode: 0o700 });
protectRuntime(directory);
const write = (name, value) => {
  const file = path.join(directory, name);
  if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, value, { mode: 0o600 });
};
const safeEnvHash = sha(fs.readFileSync(path.join(backend, '.env')));
const source = sourceEnvironment();
const c = database(); await c.connect();
try {
  await verifyTarget(c);
  await c.query('BEGIN READ ONLY');
  let running, pending;
  try {
    running = (await c.query("SELECT count(*)::int n FROM app.runs WHERE internal_status IN ('QUEUED','SUBMITTED','RESULT_RECEIVED','PROCESSING')")).rows[0].n;
    // Use the command schema's exact topic allowlist, as the dispatcher does.
    // Old unrelated test events remain preserved but cannot become Run commands.
    await c.query('SET LOCAL ROLE dhumi_outbox_dispatcher');
    pending = (await c.query("SELECT count(*)::int n FROM app.outbox_events WHERE published_at IS NULL AND topic=ANY($1::text[])", [jobCommandEnvelopeSchema.shape.topic.options])).rows[0].n;
  } finally { await c.query('ROLLBACK'); }
  assert(running === 0 && pending === 0, 'Export requires no active Runs or pending outbox; do not copy paid work for replay');
  const baseline = await capture(c);
  await c.query('BEGIN READ ONLY');
  let roles, settings;
  try {
    roles = (await c.query("SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolpassword,rolvaliduntil FROM pg_authid WHERE rolname LIKE 'dhumi_%' AND (NOT rolcanlogin OR rolname LIKE 'dhumi_test_%_login') ORDER BY rolname")).rows;
    settings = (await c.query("SELECT r.rolname,s.setdatabase,s.setconfig,d.datname FROM pg_db_role_setting s JOIN pg_roles r ON r.oid=s.setrole LEFT JOIN pg_database d ON d.oid=s.setdatabase WHERE (r.rolname LIKE 'dhumi_test_%_login' OR (r.rolname LIKE 'dhumi_%' AND NOT r.rolcanlogin)) AND (s.setdatabase=0 OR d.datname='dhumi_test')")).rows;
  } finally { await c.query('ROLLBACK'); }
  assert(roles.length === 17 && roles.filter(r => r.rolcanlogin).length === 8, 'Existing test identities must be retained exactly');
  let roleSql = roles.map(r => `CREATE ROLE ${identifier(r.rolname)} WITH ${r.rolsuper ? '' : 'NO'}SUPERUSER ${r.rolinherit ? '' : 'NO'}INHERIT ${r.rolcreaterole ? '' : 'NO'}CREATEROLE ${r.rolcreatedb ? '' : 'NO'}CREATEDB ${r.rolcanlogin ? '' : 'NO'}LOGIN ${r.rolreplication ? '' : 'NO'}REPLICATION ${r.rolbypassrls ? '' : 'NO'}BYPASSRLS CONNECTION LIMIT ${r.rolconnlimit} PASSWORD ${literal(r.rolpassword)}${r.rolvaliduntil ? ' VALID UNTIL ' + literal(r.rolvaliduntil.toISOString()) : ''};`).join('\n') + '\n';
  roleSql += baseline.memberships.map(m => `GRANT ${identifier(m.role)} TO ${identifier(m.member)} WITH ADMIN ${m.admin_option}, INHERIT ${m.inherit_option}, SET ${m.set_option};`).join('\n') + '\n';
  for (const row of settings) for (const setting of row.setconfig ?? []) { const at = setting.indexOf('='); const key = setting.slice(0, at), value = setting.slice(at + 1); roleSql += `ALTER ROLE ${identifier(row.rolname)}${row.setdatabase ? ' IN DATABASE dhumi_test' : ''} SET ${identifier(key)} TO ${key === 'search_path' ? value : literal(value)};\n`; }
  write('restore/roles.private.sql', roleSql);
  const pgDirectory = process.env.DHUMI_PG_BIN ?? (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/18/bin' : '');
  const tool = name => pgDirectory ? path.join(pgDirectory, name + (process.platform === 'win32' ? '.exe' : '')) : name;
  const dump = path.join(directory, 'database.private.dump');
  command(tool('pg_dump'), ['--host=127.0.0.1', '--port=55432', `--username=${source.POSTGRES_USER}`, '--dbname=dhumi_test', '--format=custom', '--no-password', `--file=${dump}`], { env: { ...process.env, PGPASSWORD: source.POSTGRES_PASSWORD, PGOPTIONS: '-c default_transaction_read_only=on' }, quiet: true, label: 'Read-only Docker demo export' });
  command(tool('pg_restore'), ['--schema-only', `--file=${path.join(directory, 'restore/schema.private.sql')}`, dump], { quiet: true });
  command(tool('pg_restore'), ['--data-only', '--disable-triggers', `--file=${path.join(directory, 'restore/data.private.sql')}`, dump], { quiet: true });
  const blobs = []; const storage = BlobServiceClient.fromConnectionString(processEnvironment('api').RESULT_STORAGE_CONNECTION_STRING).getContainerClient(processEnvironment('api').RESULT_STORAGE_CONTAINER);
  for await (const item of storage.listBlobsFlat()) {
    const blob = storage.getBlobClient(item.name); const props = await blob.getProperties(); const bytes = await blob.downloadToBuffer(); const checksum = sha(bytes);
    write(`restore/blobs/${checksum}.bin`, bytes);
    blobs.push({ key: item.name, sha256: checksum, bytes: bytes.length, contentType: props.contentType ?? 'application/octet-stream', metadata: props.metadata ?? {} });
  }
  write('restore/blobs.private.json', JSON.stringify(blobs));
  // A public demo must never expose Azurite's documented development key.
  const storageKey = randomBytes(64).toString('base64');
  const storageConnection = `DefaultEndpointsProtocol=http;AccountName=dhumidemo;AccountKey=${storageKey};BlobEndpoint=http://127.0.0.1:10000/dhumidemo;`;
  write('azurite.private.env', `AZURITE_ACCOUNTS=dhumidemo:${storageKey}\n`);
  const common = { NODE_ENV: 'test', DEMO_DISABLE_OTP: 'true', ORGANIZATION_COLLABORATION_ENABLED: 'false', HOST: '0.0.0.0', PORT: '3000', TRUST_PROXY_HOPS: '1', FRONTEND_ORIGIN: publicOrigin, APP_PUBLIC_URL: publicOrigin, ACCESS_TOKEN_TTL_SECONDS: '900', SESSION_COOKIE_SAMESITE: 'strict', DATABASE_HOST: 'postgres', DATABASE_PORT: '5432', DATABASE_NAME: 'dhumi_test', SERVICE_BUS_CONNECTION_STRING: 'Endpoint=sb://servicebus;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;', REDIS_URL: 'redis://127.0.0.1:6379', RESULT_STORAGE_CONNECTION_STRING: storageConnection, RESULT_DOWNLOAD_PROXY_URL: `${publicOrigin}/blob`, OUTBOX_DISPATCHER_ID: 'dhumi-hosted-demo' };
  for (const name of ['api','outbox','jobs']) {
    const env = processEnvironment(name);
    const filtered = Object.fromEntries(Object.entries(env).filter(([key,value]) => typeof value === 'string' && /^(NODE_ENV|LOG_LEVEL|HOST|PORT|FRONTEND_|DATABASE_|DEMO_|ORGANIZATION_|APP_|LEGAL_|PASSWORD_|ACCESS_|REFRESH_|SESSION_|SIGNIN_|SIGNUP_|RESULT_|MARKETPLACE_|SERVICE_BUS_|RUN_EXECUTOR_|SHARED_SCRAPER_|REDIS_|OUTBOX_|JOB_|PROVIDER_|BRIGHTDATA_)/.test(key)));
    write(`${name}.private.json`, JSON.stringify({ ...filtered, ...common }, null, 2));
  }
  write('results.private.json', JSON.stringify({ NODE_ENV: 'test', DEMO_DISABLE_OTP: 'true', RESULT_STORAGE_CONNECTION_STRING: storageConnection, RESULT_STORAGE_CONTAINER: processEnvironment('api').RESULT_STORAGE_CONTAINER }));
  write('postgres-password.private.txt', source.POSTGRES_PASSWORD);
  const bus = parseEnv(fs.readFileSync(path.join(backend, '.env.pattern4'), 'utf8'));
  assert(bus.PATTERN4_ACCEPT_EULA === 'Y' && bus.PATTERN4_MSSQL_SA_PASSWORD, 'Retain the existing emulator EULA and password');
  write('mssql-password.private.txt', bus.PATTERN4_MSSQL_SA_PASSWORD); fs.chmodSync(path.join(directory, 'mssql-password.private.txt'), 0o444);
  assert(!/[\r\n]/.test(bus.PATTERN4_MSSQL_SA_PASSWORD), 'Emulator password must be one line');
  write('servicebus.private.env', `MSSQL_SA_PASSWORD=${bus.PATTERN4_MSSQL_SA_PASSWORD}\n`);
  const front = {};
  for (const name of ['.env','.env.local','.env.development','.env.development.local']) {
    const file = path.join(root, 'front-end', name);
    if (fs.existsSync(file)) Object.assign(front, parseEnv(fs.readFileSync(file,'utf8')));
  }
  const legal = front.VITE_SIGNUP_LEGAL_ACCEPTANCES_JSON ?? source.VITE_SIGNUP_LEGAL_ACCEPTANCES_JSON;
  assert(legal && Array.isArray(JSON.parse(legal)) && JSON.parse(legal).length > 0, 'Use existing approved frontend legal metadata');
  const variables = { DHUMI_RELEASE: '20261008-demo', DHUMI_PRIVATE_DIR: directory.replaceAll('\\','/'), DHUMI_POSTGRES_USER: source.POSTGRES_USER, DHUMI_ACCEPT_EULA: bus.PATTERN4_ACCEPT_EULA, DHUMI_SITE_ADDRESS: local ? 'http://:80' : url.hostname, DHUMI_BIND_IP: local ? '127.0.0.1' : '0.0.0.0', DHUMI_HTTP_PORT: local ? (url.port || '3900') : '80', DHUMI_HTTPS_PORT: local ? '3943' : '443', SIGNUP_LEGAL_ACCEPTANCES_JSON: legal };
  assert(Object.values(variables).every(value => !value.includes("'") && !/[\r\n]/.test(value)), 'Unsupported compose setting encoding');
  write('compose.private.env', Object.entries(variables).map(([key,value]) => `${key}='${value}'`).join('\n')+'\n');
  const after = await capture(c); assert(JSON.stringify(baseline.rows) === JSON.stringify(after.rows), 'Source changed during export; review the snapshot before using it');
  assert(sha(fs.readFileSync(path.join(backend, '.env'))) === safeEnvHash, 'Existing credentials changed');
  write('baseline.private.json', JSON.stringify(baseline));
  write('prepared.json', JSON.stringify({ preparedAt: new Date().toISOString(), publicOrigin, tables: Object.keys(baseline.rows).length, migrations: baseline.ledger.length, storedObjects: blobs.length, sourceUnchanged: true, databaseDumpSha256: sha(fs.readFileSync(dump)) }, null, 2));
  // Docker mounts bypass the enclosing private directory. Read-only secret
  // files admit only their non-root container; the host parent stays private.
  for (const name of ['api.private.json','outbox.private.json','jobs.private.json','results.private.json']) fs.chmodSync(path.join(directory, name), 0o444);
  fs.chmodSync(path.join(directory, 'restore'), 0o755); fs.chmodSync(path.join(directory, 'restore/blobs'), 0o755);
  for (const name of fs.readdirSync(path.join(directory, 'restore'))) {
    const file = path.join(directory, 'restore', name); if (fs.statSync(file).isFile()) fs.chmodSync(file, 0o444);
  }
  for (const name of fs.readdirSync(path.join(directory, 'restore/blobs'))) fs.chmodSync(path.join(directory, 'restore/blobs', name), 0o444);
  console.log(JSON.stringify({ prepared: true, tables: 25, migrations: 75, storedObjects: blobs.length, sourceUnchanged: true, privateDirectory: directory }));
} finally { await c.end(); }
