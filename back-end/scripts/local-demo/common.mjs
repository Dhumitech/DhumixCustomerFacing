import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
import pg from 'pg';

export const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const root = path.dirname(backend);
export const runtime = path.join(backend, '.runtime/local-demo');
export const assert = (condition, message) => { if (!condition) throw new Error(message); };
export const save = (name, value) => fs.writeFileSync(path.join(runtime, name), JSON.stringify(value, null, 2) + '\n');
export const sha = value => createHash('sha256').update(value).digest('hex');
export const identifier = value => { assert(/^[a-z_][a-z0-9_]*$/.test(value), 'Unsafe SQL identifier'); return '"' + value + '"'; };
export const literal = value => value === null ? 'NULL' : "'" + String(value).replaceAll("'", "''") + "'";
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export function sourceEnvironment() {
  const value = parseEnv(fs.readFileSync(path.join(backend, '.env'), 'utf8'));
  assert(value.DATABASE_NAME === 'dhumi_test' && String(value.DATABASE_PORT ?? '5432') === '5432' && ['localhost', '127.0.0.1'].includes(value.DATABASE_HOST), 'Source must be loopback:5432/dhumi_test');
  assert(value.POSTGRES_USER && value.POSTGRES_PASSWORD, 'Fill the existing POSTGRES_USER/PASSWORD holder in back-end/.env');
  return value;
}
export function liveProviderSettings(source = sourceEnvironment()) {
  assert(source.BRIGHTDATA_API_KEY?.trim(), 'Fill the existing backend-only BRIGHTDATA_API_KEY before starting the real demo');
  const keyPath = path.join(runtime, 'real-provider-reference-key.private.txt');
  const key = source.PROVIDER_REFERENCE_LOCAL_KEY ?? (fs.existsSync(keyPath) ? fs.readFileSync(keyPath, 'utf8').trim() : '');
  assert(/^[A-Za-z0-9_-]{43}$/.test(key) && Buffer.from(key, 'base64url').length === 32, 'A persistent private provider-reference key is required; provision the real binding with demo:up');
  return { BRIGHTDATA_API_KEY: source.BRIGHTDATA_API_KEY, PROVIDER_REFERENCE_LOCAL_KEY: key };
}
export function demoEnvironment() {
  const env = { ...process.env, ...sourceEnvironment(),
    NODE_ENV: 'test', LOG_LEVEL: 'info', HOST: '127.0.0.1', PORT: '3000', FRONTEND_ORIGIN: 'http://localhost:5173',
    DATABASE_HOST: '127.0.0.1', DATABASE_PORT: '55432', DATABASE_NAME: 'dhumi_test', DATABASE_SSL_MODE: 'disable',
    DEMO_DISABLE_OTP: 'true', RESULT_STORAGE_DRIVER: 'azurite', RESULT_STORAGE_CONTAINER: 'dhumi-demo-results',
    SERVICE_BUS_DRIVER: 'emulator', SERVICE_BUS_RUN_COMMAND_QUEUE: 'dhumi-demo-run-commands',
    RUN_EXECUTOR_DRIVER: 'bright_data', SHARED_SCRAPER_PIPELINE_ENABLED: 'false',
    REDIS_URL: 'redis://127.0.0.1:6380', REDIS_LEASE_PREFIX: 'dhumi:local-demo:capacity',
    OUTBOX_DISPATCHER_ID: 'dhumi-local-demo', OUTBOX_DISPATCHER_INTERVAL_MS: '250',
    SIGNUP_RATE_LIMIT_MAX: '50', SIGNUP_RATE_LIMIT_WINDOW_MS: '60000',
    SIGNIN_RATE_LIMIT_MAX: '50', SIGNIN_RATE_LIMIT_WINDOW_MS: '60000',
    VITE_DHUMI_API_BASE_URL: 'http://localhost:3000',
  };
  assert(env.RESULT_STORAGE_CONNECTION_STRING === 'UseDevelopmentStorage=true' || /(?:^|;)BlobEndpoint=http:\/\/(?:localhost|127\.0\.0\.1)(?::10000)?\//i.test(env.RESULT_STORAGE_CONNECTION_STRING ?? ''), 'Storage must target local Azurite');
  assert(/UseDevelopmentEmulator=true/i.test(env.SERVICE_BUS_CONNECTION_STRING ?? '') && /Endpoint=sb:\/\/(?:localhost|127\.0\.0\.1)(?:[:/;])/i.test(env.SERVICE_BUS_CONNECTION_STRING), 'Service Bus must target the local emulator');
  // Provider credentials are stripped here and supplied only to the Job Manager.
  // The API/frontend/outbox never receive them or the admin credential holder.
  for (const name of Object.keys(env)) if (/^(POSTGRES_|PGPASSWORD|BRIGHTDATA_API_KEY|PROVIDER_REFERENCE_LOCAL_KEY|SMTP_|EMAIL_|OTP_SECRET)/.test(name)) delete env[name];
  return env;
}
export function processEnvironment(name) {
  const env = demoEnvironment();
  if (name === 'frontend') {
    // Vite needs only public settings and OS/tooling variables.
    for (const key of Object.keys(env)) if (/^(DATABASE_|ACCESS_TOKEN_|REFRESH_TOKEN_|SESSION_|SERVICE_BUS_|RESULT_|REDIS_|PROVIDER_|OUTBOX_|JOB_|DEMO_|LEGAL_)/.test(key)) delete env[key];
  } else {
    const capabilities = name === 'api' ? ['IDENTITY', 'CUSTOMER_API', 'ADMISSION'] : name === 'jobs' ? ['JOB_MANAGER', 'RESULT_RECORDER'] : name === 'outbox' ? ['OUTBOX_DISPATCHER'] : [];
    assert(capabilities.length > 0, 'Unknown demo process');
    for (const key of Object.keys(env)) {
      const credential = /^DATABASE_(.+)_(USER|PASSWORD)$/.exec(key);
      if (credential && !capabilities.includes(credential[1])) delete env[key];
    }
    if (name !== 'api') for (const key of Object.keys(env)) if (/^(ACCESS_TOKEN_|REFRESH_TOKEN_|SESSION_)/.test(key)) delete env[key];
    if (name === 'jobs') Object.assign(env, liveProviderSettings());
  }
  return env;
}
export function database({ source = false, credential } = {}) {
  const env = sourceEnvironment();
  const c = new pg.Client({ host: '127.0.0.1', port: source ? 5432 : 55432, database: 'dhumi_test',
    user: credential?.user ?? env.POSTGRES_USER, password: credential?.password ?? env.POSTGRES_PASSWORD,
    application_name: 'dhumi-local-demo', connectionTimeoutMillis: 5000, query_timeout: 120000,
    options: '-c TimeZone=UTC -c statement_timeout=120000 -c lock_timeout=5000' + (source ? ' -c default_transaction_read_only=on' : ''),
  });
  c.on('error', () => {});
  return c;
}
export function command(executable, args, { env = process.env, cwd = backend, input, timeout = 180000, label = executable, quiet = false } = {}) {
  const result = spawnSync(executable, args, { cwd, env, input, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, 'last-command.private.log'), `${result.error?.message ?? ''}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    throw new Error(`${label} failed; inspect .runtime/local-demo/last-command.private.log locally`);
  }
  if (!quiet && result.stdout?.trim()) console.log(result.stdout.trim());
  return result.stdout ?? '';
}
export function protectRuntime(directory = runtime) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') { fs.chmodSync(directory, 0o700); return; }
  const escaped = directory.replaceAll("'", "''");
  command('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $demoPath='${escaped}'; $demoSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; & icacls.exe $demoPath '/inheritance:r' '/grant:r' ('*'+$demoSid+':(OI)(CI)F') | Out-Null; if($LASTEXITCODE -ne 0){throw 'Private directory ACL failed'}`], { quiet: true, label: 'Private runtime ACL' });
}
export async function capture(c) {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const tables = (await c.query("SELECT tablename FROM pg_tables WHERE schemaname='app' ORDER BY tablename")).rows;
    const rows = {};
    for (const { tablename } of tables) rows[tablename] = (await c.query(`SELECT count(*)::int count, md5(coalesce(string_agg(d,'' ORDER BY d),'')) digest FROM (SELECT md5(to_jsonb(t)::text) d FROM app.${identifier(tablename)} t) s`)).rows[0];
    const ledger = (await c.query('SELECT version,checksum FROM app.schema_migrations ORDER BY version')).rows;
    const columns = (await c.query("SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='app' ORDER BY table_name,column_name")).rows;
    const constraints = (await c.query("SELECT c.relname,con.conname,pg_get_constraintdef(con.oid) definition FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' ORDER BY 1,2")).rows;
    const policies = (await c.query("SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='app' ORDER BY 1,2")).rows;
    const rls = (await c.query("SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relkind='r' ORDER BY 1")).rows;
    const grants = (await c.query("SELECT table_name,grantee,privilege_type,is_grantable FROM information_schema.role_table_grants WHERE table_schema='app' ORDER BY 1,2,3")).rows;
    const roles = (await c.query("SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls FROM pg_roles WHERE rolname LIKE 'dhumi_%' AND (NOT rolcanlogin OR rolname LIKE 'dhumi_test_%_login') ORDER BY 1")).rows;
    const memberships = (await c.query("SELECT r.rolname role,u.rolname member,m.admin_option,m.inherit_option,m.set_option FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles u ON u.oid=m.member WHERE (u.rolname LIKE 'dhumi_test_%_login' OR (u.rolname LIKE 'dhumi_%' AND NOT u.rolcanlogin)) AND r.rolname LIKE 'dhumi_%' ORDER BY 1,2")).rows;
    // PostgreSQL assigns fresh OIDs to restored FK triggers. Compare their real
    // constraint/event identity and complete definition rather than generated names.
    const triggers = (await c.query("SELECT c.relname,CASE WHEN t.tgisinternal THEN con.conname||':'||t.tgtype::text ELSE t.tgname::text END tgname,t.tgenabled,t.tgisinternal,replace(pg_get_triggerdef(t.oid),quote_ident(t.tgname),quote_ident(CASE WHEN t.tgisinternal THEN con.conname||':'||t.tgtype::text ELSE t.tgname::text END)) definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_constraint con ON con.oid=t.tgconstraint WHERE n.nspname='app' ORDER BY 1,2,5")).rows;
    const indexes = (await c.query("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='app' ORDER BY 1,2")).rows;
    const routines = (await c.query("SELECT p.proname,pg_get_function_identity_arguments(p.oid) args,pg_get_functiondef(p.oid) definition,p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner) owner,p.proacl::text acl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' ORDER BY 1,2")).rows;
    return { rows, ledger, columns, constraints, policies, rls, grants, roles, memberships, triggers, indexes, routines };
  } finally { await c.query('ROLLBACK'); }
}
export async function verifyTarget(c) {
  const container = command('docker', ['ps', '--filter', 'label=com.docker.compose.project=dhumi-local-demo', '--filter', 'label=com.docker.compose.service=postgres', '--format', '{{.ID}}'], { quiet: true, label: 'Docker database identity' }).trim();
  assert(/^[0-9a-f]{12,64}$/.test(container), 'Exactly one running local-demo PostgreSQL container is required');
  assert(command('docker', ['port', container, '5432/tcp'], { quiet: true }).trim() === '127.0.0.1:55432', 'Docker database must own port 55432');
  const target = (await c.query('SELECT current_database() db,inet_server_port() port')).rows[0];
  // Inside Docker the server reports 5432; the client must be connected via fixed host port 55432.
  assert(c.connectionParameters.port === 55432 && target.db === 'dhumi_test', 'Docker dhumi_test only');
  const ledger = (await c.query('SELECT version FROM app.schema_migrations ORDER BY version')).rows;
  assert(ledger.length === 75 && ledger.at(-1).version.startsWith('0075'), 'Docker database must have the reviewed 0075 schema');
  for (const row of ledger) {
    const actual = sha(fs.readFileSync(path.join(backend, 'scripts/migrations', row.version + '.sql')));
    const stored = (await c.query('SELECT checksum FROM app.schema_migrations WHERE version=$1', [row.version])).rows[0].checksum;
    assert(actual === stored, 'Migration checksum mismatch: ' + row.version);
  }
}
