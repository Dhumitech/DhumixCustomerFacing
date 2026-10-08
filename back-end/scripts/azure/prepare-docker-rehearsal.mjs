import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {projectDeploymentEnvironment} from '../../dist/deployment/environment.js';
import {loadRuntimeConfig} from '../../dist/config/environment.js';
import {loadOutboxDispatcherConfig, loadJobManagerConfig} from '../../dist/config/pattern4Environment.js';
import {loadOrganizationWorkflowConfig, loadOrganizationCollaborationEnabled} from '../../dist/config/organizationEnvironment.js';

// Generates mounted role settings; it never starts workers, restores data or
// writes the canonical env. Build before running, as with deployment:check.
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const assert = (value, message) => { if (!value) throw new Error(message); };
try {
  const args = process.argv.slice(2);
  assert(args.length <= 1 && args.every(a => /^--port=\d+$/.test(a)), 'Use only --port=4173');
  const port = Number(args[0]?.slice(7) || 4173);
  assert(port >= 1024 && port <= 65535, 'Use an unprivileged valid port');
  const origin = `http://127.0.0.1:${port}`;
  const profile = path.join(backend, '.env.azure');
  const bytes = fs.readFileSync(profile);
  const source = parseEnv(bytes.toString('utf8'));
  assert(source.DATABASE_NAME === 'dhumi_shared' && source.DATABASE_HOST === '20.244.41.57' && source.DATABASE_PORT === '5432', 'Retain the reviewed Azure database endpoint');
  assert(source.DATABASE_SSL_MODE === 'verify-full' && source.DATABASE_SSL_CA_BASE64 && !source.DATABASE_SSL_CA_FILE, 'Portable verified database TLS is required');
  assert(source.NODE_ENV === 'test' && source.DEMO_DISABLE_OTP === 'true' && source.ORGANIZATION_COLLABORATION_ENABLED === 'false', 'Retain the accepted demo behavior');
  assert(source.RESULT_STORAGE_DRIVER === 'azure_blob' && source.SERVICE_BUS_DRIVER === 'azure' && source.RUN_EXECUTOR_DRIVER === 'bright_data' && source.REDIS_URL?.startsWith('rediss://'), 'Use all existing Azure dependencies and the real executor');
  const directory = path.join(backend, '.runtime', 'azure-docker-rehearsal');
  assert(!fs.existsSync(path.join(directory, 'prepared.json')), 'Prepared settings already exist; do not replace settings used by running containers');
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  if (process.platform === 'win32') {
    const safePath = directory.replaceAll("'", "''");
    const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $rehearsalPath='${safePath}'; $rehearsalSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; & icacls.exe $rehearsalPath '/inheritance:r' '/grant:r' ('*'+$rehearsalSid+':(OI)(CI)F') | Out-Null; if($LASTEXITCODE -ne 0){throw 'Private directory ACL failed'}`], {windowsHide: true, encoding: 'utf8'});
    assert(result.status === 0, 'Private directory ACL failed');
  } else fs.chmodSync(directory, 0o700);
  const write = (name, content, mode = 0o600) => {
    const target = path.join(directory, name);
    if (fs.existsSync(target)) fs.chmodSync(target, 0o600);
    fs.writeFileSync(target, content, {mode});
  };
  const settings = {};
  const loaders = {api: loadRuntimeConfig, outbox: loadOutboxDispatcherConfig, jobs: loadJobManagerConfig};
  for (const role of Object.keys(loaders)) {
    const env = projectDeploymentEnvironment(role, source, {});
    // This public flag selects the already accepted container demo entrypoint.
    env.DEMO_DISABLE_OTP = 'true';
    if (role === 'api') {
      Object.assign(env, {HOST: '0.0.0.0', PORT: '3000', TRUST_PROXY_HOPS: '1', FRONTEND_ORIGIN: origin, APP_PUBLIC_URL: origin});
      assert(!env.SESSION_COOKIE_DOMAIN, 'Use host-only cookies for this separate loopback origin');
      loadOrganizationWorkflowConfig(env);
      assert(loadOrganizationCollaborationEnabled(env) === false, 'Collaboration must remain disabled');
    }
    for (const [key, value] of Object.entries(env)) {
      if (/(?:PASSWORD|SECRET|API_KEY|LOCAL_KEY|REDIS_URL|CONNECTION_STRING)$/.test(key)) assert(value === source[key], 'Credential or reference key changed');
    }
    loaders[role](env);
    settings[role] = env;
    write(`${role}.private.json`, JSON.stringify(env, null, 2) + '\n', 0o444);
  }
  const catalogue = loadRuntimeConfig(settings.api).legal.documents;
  const frontend = {};
  for (const name of ['.env', '.env.local', '.env.development', '.env.development.local']) {
    const target = path.join(path.dirname(backend), 'front-end', name);
    if (fs.existsSync(target)) Object.assign(frontend, parseEnv(fs.readFileSync(target, 'utf8')));
  }
  // Reuse the running portal's exact consent metadata. An empty backend
  // catalogue is permitted by the retained demo, not permission to invent one.
  const legal = frontend.VITE_SIGNUP_LEGAL_ACCEPTANCES_JSON
    ? JSON.parse(frontend.VITE_SIGNUP_LEGAL_ACCEPTANCES_JSON)
    : catalogue.length
      ? catalogue.map(d => ({document_type: d.documentType, document_version: d.documentVersion, content_hash: d.contentHash, accepted: true}))
      : JSON.parse(fs.readFileSync(path.join(path.dirname(backend), 'deploy/azure-rehearsal/signup-legal.json'), 'utf8'));
  assert(Array.isArray(legal) && legal.length > 0 && legal.every(d => d.document_type && d.document_version && /^[a-fA-F0-9]{64}$/.test(d.content_hash) && d.accepted === true), 'Use existing configured legal metadata');
  if (catalogue.length) assert(legal.every(d => catalogue.some(c => c.documentType === d.document_type && c.documentVersion === d.document_version && c.contentHash === d.content_hash)), 'Frontend consent must match the configured backend catalogue');
  const release = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const compose = {DHUMI_RELEASE: release, DHUMI_PRIVATE_DIR: directory.replaceAll('\\', '/'), DHUMI_HTTP_PORT: String(port), SIGNUP_LEGAL_ACCEPTANCES_JSON: JSON.stringify(legal)};
  assert(Object.values(compose).every(v => !/[\r\n']/.test(v)), 'Unsupported compose value');
  write('compose.private.env', Object.entries(compose).map(([key, value]) => `${key}='${value}'`).join('\n') + '\n');
  assert(hash(fs.readFileSync(profile)) === hash(bytes), 'Canonical env changed during preparation');
  const receipt = {preparedAt: new Date().toISOString(), origin, release, sourceEnvSha256: hash(bytes), sourceEnvUnchanged: true, roleProfiles: 3, sharedAzureData: true, credentialsRetained: true, providerSubmissions: 0};
  write('prepared.json', JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({status: 'prepared', origin, release, sharedAzureData: true, canonicalEnvUnchanged: true, roleProfiles: 3}));
} catch (error) {
  // Never print env values or configuration errors, including endpoint URLs.
  console.error('Docker rehearsal preparation rejected. Verify the private Azure profile and that no existing prepared bundle is being replaced.');
  process.exitCode = 1;
}
