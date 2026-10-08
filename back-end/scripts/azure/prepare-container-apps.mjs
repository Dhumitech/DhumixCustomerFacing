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

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = path.dirname(backend);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const assert = (ok, message) => {if (!ok) throw new Error(message);};
try {
  assert(process.argv.length === 2, 'No overrides accepted for the reviewed deployment');
  const resources = JSON.parse(fs.readFileSync(path.join(root, 'deploy/azure/Container-Apps-Environment-Resources.json'), 'utf8'));
  const release = JSON.parse(fs.readFileSync(path.join(root, 'deploy/azure/Container-Registry-Release.json'), 'utf8'));
  assert(resources.status === 'Succeeded' && resources.environment.name === 'cae-dhumi-ci-01', 'Reviewed environment required');
  const names = {api: 'ca-dhumi-api-ci-01', frontend: 'ca-dhumi-frontend-ci-01', outbox: 'ca-dhumi-outbox-ci-01', jobs: 'ca-dhumi-jobs-ci-01'};
  const origin = `https://${names.frontend}.${resources.environment.defaultDomain}`;
  const apiUpstream = `https://${names.api}.internal.${resources.environment.defaultDomain}`;
  const identityId = `/subscriptions/${resources.subscriptionId}/resourceGroups/${resources.resourceGroup}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-dhumi-acr-pull-ci-01`;
  const sourceFile = path.join(backend, '.env.azure');
  const bytes = fs.readFileSync(sourceFile);
  const source = parseEnv(bytes.toString('utf8'));
  assert(source.DATABASE_HOST === '20.244.41.57' && source.DATABASE_NAME === 'dhumi_shared' && source.DATABASE_PORT === '5432', 'Reviewed app database only');
  assert(source.DATABASE_SSL_MODE === 'verify-full' && source.DATABASE_SSL_CA_BASE64 && !source.DATABASE_SSL_CA_FILE, 'Retain portable verified TLS');
  assert(source.NODE_ENV === 'test' && source.DEMO_DISABLE_OTP === 'true' && source.ORGANIZATION_COLLABORATION_ENABLED === 'false', 'Retain accepted demo behavior');
  assert(source.RESULT_STORAGE_DRIVER === 'azure_blob' && source.SERVICE_BUS_DRIVER === 'azure' && source.RUN_EXECUTOR_DRIVER === 'bright_data' && source.REDIS_URL?.startsWith('rediss://'), 'Real Azure dependencies required');
  const directory = path.join(backend, '.runtime', 'azure-container-apps-20261009');
  assert(!fs.existsSync(path.join(directory, 'prepared.json')), 'Do not overwrite a prepared release');
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  if (process.platform === 'win32') {
    const quoted = directory.replaceAll("'", "''");
    const acl = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $hostingPath='${quoted}'; $hostingSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; & icacls.exe $hostingPath '/inheritance:r' '/grant:r' ('*'+$hostingSid+':(OI)(CI)F') | Out-Null; if($LASTEXITCODE -ne 0){throw 'ACL failed'}`], {windowsHide: true, encoding: 'utf8'});
    assert(acl.status === 0, 'Private ACL required');
  }
  const write = (name, value) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  const settings = {};
  const loaders = {api: loadRuntimeConfig, outbox: loadOutboxDispatcherConfig, jobs: loadJobManagerConfig};
  for (const role of Object.keys(loaders)) {
    const env = projectDeploymentEnvironment(role, source, {});
    env.DEMO_DISABLE_OTP = 'true';
    if (role === 'api') {
      Object.assign(env, {HOST: '0.0.0.0', PORT: '3000', TRUST_PROXY_HOPS: '1', FRONTEND_ORIGIN: origin, APP_PUBLIC_URL: origin});
      assert(!env.SESSION_COOKIE_DOMAIN, 'Retain host-only cookies');
      loadOrganizationWorkflowConfig(env);
      assert(loadOrganizationCollaborationEnabled(env) === false, 'Collaboration remains deferred');
    }
    for (const [key, value] of Object.entries(env)) {
      if (/(?:PASSWORD|SECRET|API_KEY|LOCAL_KEY|REDIS_URL|CONNECTION_STRING)$/.test(key)) assert(value === source[key], 'Credential changed');
    }
    loaders[role](env);
    settings[role] = env;
    write(`${role}.private.json`, env);
  }
  assert(loadRuntimeConfig(settings.api).session.cookie.secure, 'HTTPS cookie required');
  const parameters = value => ({'$schema': 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#', contentVersion: '1.0.0.0', parameters: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, {value: item}]))});
  const backendImage = release.images.find(i => i.repository === 'dhumi/backend').reference;
  const frontendImage = release.images.find(i => i.repository === 'dhumi/frontend').reference;
  const base = {environmentId: resources.environment.id, registryIdentityId: identityId};
  for (const role of ['api', 'frontend', 'outbox', 'jobs']) {
    write(`${role}.parameters.private.json`, parameters({...base, appName: names[role], role, imageReference: role === 'frontend' ? frontendImage : backendImage, runtimeSettings: settings[role] ?? {}, apiUpstream: role === 'frontend' ? apiUpstream : ''}));
  }
  write('qualification.parameters.private.json', parameters({...base, backendImage, apiSettings: settings.api, outboxSettings: settings.outbox, jobsSettings: settings.jobs, checkerSource: fs.readFileSync(path.join(backend, 'scripts/azure/check-docker-rehearsal.mjs'), 'utf8')}));
  assert(hash(fs.readFileSync(sourceFile)) === hash(bytes), 'Master env changed');
  const receipt = {preparedAtUtc: new Date().toISOString(), origin, apiUpstream, names, identityId, backendImage, frontendImage, sourceEnvSha256: hash(bytes), sourceEnvUnchanged: true, credentialsRetained: true, secureCookies: true, roleProfiles: 3, providerSubmissions: 0};
  write('prepared.json', receipt);
  console.log(JSON.stringify({status: 'prepared', origin, canonicalEnvUnchanged: true, roleProfiles: 3, secureCookies: true}));
} catch {
  console.error('Cloud preparation rejected. Check the reviewed resource metadata and private profile without printing credentials.');
  process.exitCode = 1;
}
