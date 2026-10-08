import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { parseEnv } from 'node:util';
import { backend, root, runtime, assert, command, protectRuntime, save, sourceEnvironment, processEnvironment, database, verifyTarget, delay, sha } from './common.mjs';
import { cloneDatabase } from './clone.mjs';

const stateFile = path.join(runtime, 'processes.json');
const processes = () => fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function portFree(port) {
  return new Promise(resolve => {
    const s = net.createServer(); s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}
async function ready(url, seconds = 40) {
  for (let i = 0; i < seconds * 2; i++) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (response.ok) return; } catch { /* startup */ }
    await delay(500);
  }
  throw new Error('Not ready: ' + url + '; inspect the private local-demo logs');
}
function run(name, entry, env, cwd = backend) {
  const configurationSha256 = sha(JSON.stringify(env));
  let children = processes();
  if (children[name] && alive(children[name].pid)) {
    if (children[name].configurationSha256 === configurationSha256) return;
    stop(name); children = processes();
  }
  const out = fs.openSync(path.join(runtime, name + '.private.log'), 'a');
  const child = spawn(process.execPath, [entry], { cwd, env, detached: true, windowsHide: true, stdio: ['ignore', out, out] });
  assert(child.pid, 'Could not start ' + name);
  children[name] = { pid: child.pid, entry, configurationSha256, startedAt: new Date().toISOString() };
  save('processes.json', children); child.unref(); fs.closeSync(out);
}
async function start() {
  protectRuntime();
  assert(fs.existsSync(path.join(runtime, 'clone-receipt.json')), 'Run demo:up to create and qualify the Docker clone');
  const realPath = path.join(runtime, 'real-demo-receipt.json');
  assert(fs.existsSync(realPath), 'Provision the real Amazon binding with demo:up or enable-real before starting');
  const real = JSON.parse(fs.readFileSync(realPath, 'utf8'));
  const db = database(); await db.connect(); try {
    await verifyTarget(db);
    assert((await db.query("SELECT v.id FROM app.service_template_versions v JOIN app.service_templates t ON t.id=v.service_template_id WHERE v.id=$1 AND t.state='published' AND t.current_public_version_id=v.id AND v.execution_definition->'output_policy'->'provider_submission'->>'endpoint'='scrape'", [real.templateVersionId])).rowCount === 1, 'Reviewed real Amazon publication is required; no controlled fallback');
  } finally { await db.end(); }
  const current = processes();
  for (const [name, port] of [['api', 3000], ['frontend', 5173]]) assert(current[name] && alive(current[name].pid) || await portFree(port), `${name} port ${port} belongs to another process; it was not stopped`);
  run('api', path.join(backend, 'dist/server.js'), processEnvironment('api'));
  await ready('http://127.0.0.1:3000/v1/status');
  run('outbox', path.join(backend, 'dist/worker/outboxDispatcher.js'), processEnvironment('outbox'));
  run('jobs', path.join(backend, 'dist/worker/jobManager.js'), processEnvironment('jobs'));
  run('frontend', path.join(root, 'front-end/node_modules/vite/bin/vite.js'), processEnvironment('frontend'), path.join(root, 'front-end'));
  await ready('http://localhost:5173');
  await delay(2000);
  for (const [name, process] of Object.entries(processes())) assert(alive(process.pid), name + ' exited; inspect its private log');
  console.log('Real scraping demo running: http://localhost:5173 — API http://localhost:3000/v1/status — Docker PostgreSQL 127.0.0.1:55432/dhumi_test. Frontend Runs use Bright Data; no synthetic fallback.');
}
function stop(only) {
  const children = processes();
  for (const [name, info] of Object.entries(children)) {
    if (only && name !== only) continue;
    if (!alive(info.pid)) continue;
    // Prevent a recycled PID from stopping somebody else's process.
    if (process.platform === 'win32') {
      const actual = command('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(info.pid)}').CommandLine`], { quiet: true }).trim();
      assert(actual.includes(info.entry), 'PID identity mismatch for ' + name + '; nothing stopped');
    }
    process.kill(info.pid, 'SIGTERM'); console.log('Stopped ' + name);
    delete children[name];
  }
  save('processes.json', only ? children : {});
  console.log(only ? 'Selected demo process stopped.' : 'Application processes stopped. Docker database and emulators retained.');
}
async function up() {
  protectRuntime();
  const settings = path.join(backend, '.env.pattern4');
  assert(fs.existsSync(settings), 'Fill .env.pattern4 from its example and accept the Service Bus EULA');
  // Existing local Azure resources are reused without replacing their volumes.
  command('docker', ['compose', '-f', 'compose.pattern3.yml', 'up', '-d', '--wait'], { label: 'Azurite' });
  const pattern4 = parseEnv(fs.readFileSync(settings, 'utf8'));
  assert(pattern4.PATTERN4_ACCEPT_EULA === 'Y', 'Service Bus emulator EULA must already be accepted');
  await cloneDatabase();
  // Preserve the original emulator volume; its conflicting SQL files are not reset.
  command('docker', ['compose', '--env-file', '.env.pattern4', '-f', 'compose.pattern4.yml', 'stop', 'servicebus-emulator', 'mssql'], { label: 'Pause original Service Bus store' });
  command('docker', ['compose', '--env-file', '.env.pattern4', '-f', 'compose.pattern4.yml', 'up', '-d', '--wait', 'redis'], { label: 'Redis' });
  command('docker', ['compose', '-f', 'compose.local-demo.yml', 'up', '-d', 'mssql', 'servicebus'], { env: { ...process.env, ...pattern4, DHUMI_DEMO_POSTGRES_USER: sourceEnvironment().POSTGRES_USER }, label: 'Dedicated demo Service Bus store' });
  await ready('http://127.0.0.1:5300/health', 60);
  command(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { label: 'Backend build' });
  command(process.execPath, ['node_modules/typescript/bin/tsc', '-b'], { cwd: path.join(root, 'front-end'), label: 'Frontend typecheck' });
  command(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { cwd: path.join(root, 'front-end'), label: 'Frontend build' });
  const { seed } = await import('./seed.mjs'); await seed({ publisherId: process.argv.find(arg => arg.startsWith('--publisher-id='))?.slice(15) });
  await start();
}
async function enableReal() {
  protectRuntime();
  const { seed } = await import('./seed.mjs');
  await seed({ publisherId: process.argv.find(arg => arg.startsWith('--publisher-id='))?.slice(15) });
  await start();
}
async function status() {
  command('docker', ['ps', '--filter', 'name=dhumi-local-demo', '--filter', 'name=dhumi-pattern4', '--filter', 'name=back-end-azurite', '--format', '{{.Names}}: {{.Status}} {{.Ports}}']);
  for (const [name, info] of Object.entries(processes())) console.log(name + ': ' + (alive(info.pid) ? 'running' : 'stopped'));
  for (const name of ['api', 'outbox', 'jobs', 'frontend']) assert(processes()[name] && alive(processes()[name].pid), name + ' is not running; use demo:up or demo:start');
  const db = database(); await db.connect(); try { await verifyTarget(db); } finally { await db.end(); }
  await ready('http://127.0.0.1:5300/health', 2);
  await ready('http://127.0.0.1:3000/v1/status', 2); await ready('http://localhost:5173', 2);
}
try {
  const mode = process.argv[2];
  if (mode === 'up') await up();
  else if (mode === 'enable-real') await enableReal();
  else if (mode === 'start') await start();
  else if (mode === 'stop') stop();
  else if (mode === 'pause-jobs') stop('jobs');
  else if (mode === 'restart-api') {
    stop('api');
    run('api', path.join(backend, 'dist/server.js'), processEnvironment('api'));
    await ready('http://127.0.0.1:3000/v1/status');
  }
  else if (mode === 'status') await status();
  else if (mode === 'test') { const { test } = await import('./test.mjs'); await test(); }
  else throw new Error('Use demo:up, demo:start, demo:stop, demo:status, demo:test or enable-real --publisher-id=<existing demo user UUID>');
} catch (e) { console.error(e.message); process.exitCode = 1; }
