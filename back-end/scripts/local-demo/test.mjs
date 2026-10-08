import fs from 'node:fs';
import path from 'node:path';
import { assert, backend, runtime, database, verifyTarget, demoEnvironment, processEnvironment, save, sha, command } from './common.mjs';

// Default demo:test never creates Runs or emits a paid provider submission.
// Live end-to-end collection is a separate owner-directed/manual action.
export async function test() {
  const checks = [], check = (ok, label) => { assert(ok, label); checks.push(label); console.log('PASS ' + label); };
  const c = database(); await c.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await verifyTarget(c);
    check((await c.query("SELECT current_setting('transaction_read_only') value")).rows[0].value === 'on', 'Docker schema and all 75 applied migration checksums inspected read-only');
    const receipt = JSON.parse(fs.readFileSync(path.join(runtime, 'real-demo-receipt.json'), 'utf8'));
    const row = (await c.query("SELECT t.slug,t.state,v.version,v.published_at,v.provider_dataset_ciphertext IS NOT NULL binding,v.execution_definition FROM app.service_templates t JOIN app.service_template_versions v ON v.id=t.current_public_version_id WHERE v.id=$1", [receipt.templateVersionId])).rows[0];
    check(row?.state === 'published' && row.slug === 'amazon-products-collect-by-url' && row.binding && row.published_at, 'Real Amazon Collect by URL is published with a protected binding');
    check(row.execution_definition.output_policy.provider_submission.endpoint === 'scrape', 'Provider uses scrape with its existing inline/snapshot fallback');
    const synthetic = (await c.query("SELECT t.state,(SELECT count(*)::int FROM app.services s WHERE s.template_version_id='de000001-0000-4000-8000-000000000002' AND s.state='active') active_services FROM app.service_templates t WHERE t.id='de000001-0000-4000-8000-000000000001'")).rows[0];
    check(!synthetic || synthetic.state === 'retired' && synthetic.active_services === 0, 'Synthetic Run Template is retired and has no active Services');
    check(demoEnvironment().RUN_EXECUTOR_DRIVER === 'bright_data', 'Default interactive worker has no synthetic fallback');
    for (const name of ['api', 'outbox', 'frontend']) {
      const env = processEnvironment(name);
      check(!env.BRIGHTDATA_API_KEY && !env.PROVIDER_REFERENCE_LOCAL_KEY && !env.POSTGRES_PASSWORD, name + ' receives no provider/reference/admin credentials');
    }
    const jobs = processEnvironment('jobs');
    check(!!jobs.BRIGHTDATA_API_KEY && !!jobs.PROVIDER_REFERENCE_LOCAL_KEY && !jobs.POSTGRES_PASSWORD, 'Only Job Manager receives the real provider/reference credentials');
    check((await fetch('http://localhost:5173')).ok && (await fetch('http://127.0.0.1:3000/v1/status')).ok, 'Frontend and real-database API are reachable');
    check((await fetch('http://127.0.0.1:5300/health')).ok, 'Service Bus emulator is healthy');
    await c.query('ROLLBACK');
    const env = { ...demoEnvironment(), RUN_AZURITE_INTEGRATION_TESTS: 'true', RUN_REDIS_INTEGRATION_TESTS: 'true', RUN_SERVICE_BUS_EMULATOR_TESTS: 'true',
      SERVICE_BUS_TEST_CONNECTION_STRING: demoEnvironment().SERVICE_BUS_CONNECTION_STRING, SERVICE_BUS_TEST_QUEUE: 'dhumi-demo-test-commands', REDIS_TEST_URL: demoEnvironment().REDIS_URL };
    const output = command(process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
      'tests/unit/local-demo-live.test.ts', 'tests/unit/brightdata-integration-client.test.ts', 'tests/unit/brightdata-run-executor.test.ts', 'tests/unit/job-manager-service.test.ts',
      'tests/unit/amazon-products-result-v2.test.ts',
      'tests/integration/azurite-result-storage.test.ts', 'tests/integration/azurite-marketplace-sample-storage.test.ts', 'tests/integration/azurite-marketplace-sample-download.test.ts',
      'tests/integration/redis-capacity-lease.test.ts', 'tests/integration/servicebus-execution-queue.test.ts', '--testTimeout=30000', '--maxWorkers=1'],
      { env, timeout: 180000, quiet: true, label: 'Real-demo configuration/provider unit/emulator checks' });
    fs.writeFileSync(path.join(runtime, 'real-demo-tests.private.log'), output);
    save('real-demo-tests.json', { status: 'PASSED', time: new Date().toISOString(), checks, databaseWrites: false, providerSubmissions: 0, logSha256: sha(output), dedicatedAdapterQueue: 'dhumi-demo-test-commands' });
    console.log(output);
  } finally { await c.query('ROLLBACK').catch(() => {}); await c.end(); }
}
