// The only writable SQL connection here is the additional Docker instance on 55432.
import fs from 'node:fs';
import path from 'node:path';
import { sourceEnvironment, backend, runtime, assert, save, sha, identifier, literal, database, command, protectRuntime, capture, verifyTarget, delay } from './common.mjs';

function compareClone(before, restored) {
  // PostgreSQL re-parses these three associative AND checks when restoring DDL.
  // Accept exactly the redundant parentheses change, never a changed clause.
  const names = new Set(['idempotency_records_idempotency_key_contract_check', 'service_templates_slug_check', 'services_name_check']);
  const normalized = structuredClone(before); const differences = [];
  for (let i = 0; i < before.constraints.length; i++) {
    const original = before.constraints[i], copy = restored.constraints[i];
    if (JSON.stringify(original) === JSON.stringify(copy)) continue;
    const match = original.definition.match(/^CHECK \(\(\(\((.*?)\) AND \((.*?)\)\) AND \((.*?)\)\)\)$/);
    assert(names.has(original.conname) && copy.conname === original.conname && match && copy.definition === `CHECK (((${match[1]}) AND (${match[2]}) AND (${match[3]})))`, 'Clone constraint changed: ' + original.conname);
    normalized.constraints[i] = copy;
    differences.push({ name: original.conname, reason: 'Associative AND parentheses re-parsed; exact three clauses preserved' });
  }
  assert(JSON.stringify(normalized) === JSON.stringify(restored), 'Clone data, schema, RLS, grants or role settings differ; inspect private snapshots');
  return differences;
}
async function receipt(source, target, before) {
  const restored = await capture(target); save('docker-restored.json', restored);
  const normalization = compareClone(before, restored);
  const after = await capture(source); save('host-after-clone.json', after);
  assert(JSON.stringify(before) === JSON.stringify(after), 'Host changed during clone');
  save('clone-receipt.json', { status: 'PASSED', time: new Date().toISOString(), source: '127.0.0.1:5432/dhumi_test (read-only)', target: '127.0.0.1:55432/dhumi_test (Docker)', tables: 25, migrations: 75, capabilityRoles: 9, existingTestLogins: 8,
    preservedOrphanAttempts: 4, normalization, dumpSha256: sha(fs.readFileSync(path.join(runtime, 'dhumi_test-before-demo.private.dump'))), sourceSha256: sha(JSON.stringify(before)), restoredSha256: sha(JSON.stringify(restored)), originalEnvSha256: sha(fs.readFileSync(path.join(backend, '.env'))) });
  console.log('Verified Docker clone: 25 tables, 75 checksums, all row digests, RLS, grants and test roles match. Three CHECK expressions have equivalent parentheses. Host unchanged.');
}

export async function cloneDatabase() {
  protectRuntime();
  const env = sourceEnvironment();
  const dockerEnv = { ...process.env, DHUMI_DEMO_POSTGRES_USER: env.POSTGRES_USER };
  const passwordFile = path.join(runtime, 'postgres-password.private.txt');
  fs.writeFileSync(passwordFile, env.POSTGRES_PASSWORD, { mode: 0o600 });
  command('docker', ['compose', '-f', 'compose.local-demo.yml', 'up', '-d', '--wait', 'postgres'], { env: dockerEnv, label: 'Docker PostgreSQL' });
  const binding = command('docker', ['compose', '-f', 'compose.local-demo.yml', 'port', 'postgres', '5432'], { env: dockerEnv, quiet: true }).trim();
  assert(binding === '127.0.0.1:55432', 'Unexpected Docker PostgreSQL port mapping');
  const target = database();
  for (let i = 0; ; i++) {
    try { await target.connect(); break; }
    catch (e) { if (i > 0) throw e; await delay(1000); }
  }
  try {
    const existing = (await target.query("SELECT to_regclass('app.schema_migrations') ledger")).rows[0].ledger;
    if (existing) {
      await verifyTarget(target);
      if (!fs.existsSync(path.join(runtime, 'clone-receipt.json'))) {
        assert(fs.existsSync(path.join(runtime, 'host-before.json')) && fs.existsSync(path.join(runtime, 'docker-restored.json')), 'An existing Docker schema has no clone evidence; refusing to overwrite it');
        const source = database({ source: true }); await source.connect();
        try { await receipt(source, target, JSON.parse(fs.readFileSync(path.join(runtime, 'host-before.json'), 'utf8'))); }
        finally { await source.end(); }
      }
      console.log('Existing Docker dhumi_test retained; no restore or reset.');
      return;
    }
    assert((await target.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind='r'")).rows[0].n === 0, 'Docker database must be empty for initial restore');
    const source = database({ source: true }); await source.connect();
    try {
      const before = await capture(source); save('host-before.json', before);
      assert(before.ledger.length === 75 && Object.keys(before.rows).length === 25, 'Source must be 0075 with 25 app tables');
      const roles = (await source.query("SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolpassword,rolvaliduntil FROM pg_authid WHERE rolname LIKE 'dhumi_%' AND (NOT rolcanlogin OR rolname LIKE 'dhumi_test_%_login') ORDER BY rolname")).rows;
      assert(roles.length === 17 && roles.filter(r => r.rolcanlogin).length === 8, 'Expected nine capabilities and eight existing test logins');
      const roleSql = roles.map(r => `DO $role$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname=${literal(r.rolname)}) THEN CREATE ROLE ${identifier(r.rolname)}; END IF; END $role$; ALTER ROLE ${identifier(r.rolname)} WITH ${r.rolsuper ? '' : 'NO'}SUPERUSER ${r.rolinherit ? '' : 'NO'}INHERIT ${r.rolcreaterole ? '' : 'NO'}CREATEROLE ${r.rolcreatedb ? '' : 'NO'}CREATEDB ${r.rolcanlogin ? '' : 'NO'}LOGIN ${r.rolreplication ? '' : 'NO'}REPLICATION ${r.rolbypassrls ? '' : 'NO'}BYPASSRLS CONNECTION LIMIT ${r.rolconnlimit} PASSWORD ${literal(r.rolpassword)}${r.rolvaliduntil ? ' VALID UNTIL ' + literal(r.rolvaliduntil.toISOString()) : ''};`).join('\n') + '\n' + before.memberships.map(m => `GRANT ${identifier(m.role)} TO ${identifier(m.member)} WITH ADMIN ${m.admin_option}, INHERIT ${m.inherit_option}, SET ${m.set_option};`).join('\n') + '\n';
      fs.writeFileSync(path.join(runtime, 'roles.private.sql'), roleSql, { mode: 0o600 });
      // Apply role settings without exposing passwords in logs or command arguments.
      await target.query('BEGIN');
      try {
        await target.query(roleSql);
        const settings = (await source.query("SELECT r.rolname,s.setdatabase,s.setconfig,d.datname FROM pg_db_role_setting s JOIN pg_roles r ON r.oid=s.setrole LEFT JOIN pg_database d ON d.oid=s.setdatabase WHERE (r.rolname LIKE 'dhumi_test_%_login' OR (r.rolname LIKE 'dhumi_%' AND NOT r.rolcanlogin)) AND (s.setdatabase=0 OR d.datname='dhumi_test')")).rows;
        for (const role of settings) for (const setting of role.setconfig ?? []) {
          const at = setting.indexOf('='); const key = setting.slice(0, at); const value = setting.slice(at + 1);
          const sqlValue = key === 'search_path' ? value : literal(value);
          await target.query(`ALTER ROLE ${identifier(role.rolname)}${role.setdatabase ? ' IN DATABASE dhumi_test' : ''} SET ${identifier(key)} TO ${sqlValue}`);
        }
        await target.query('COMMIT');
      } catch (e) { await target.query('ROLLBACK'); throw e; }
      const directory = process.env.DHUMI_PG_BIN ?? (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/18/bin' : '');
      const pgTool = tool => directory ? path.join(directory, tool + (process.platform === 'win32' ? '.exe' : '')) : tool;
      const cliEnv = { ...process.env, PGPASSWORD: env.POSTGRES_PASSWORD, PGSSLMODE: 'disable', PGOPTIONS: '-c default_transaction_read_only=on' };
      const dump = path.join(runtime, 'dhumi_test-before-demo.private.dump');
      command(pgTool('pg_dump'), ['--host=127.0.0.1', '--port=5432', '--username=' + env.POSTGRES_USER, '--dbname=dhumi_test', '--format=custom', '--file=' + dump, '--no-password'], { env: cliEnv, quiet: true, label: 'Read-only host dump' });
      // Preserve the source's four already-existing orphan attempts exactly. Creating
      // constraints after loading data would newly validate historical rows and reject
      // this source. Build the empty schema first, then load with triggers disabled
      // only for this restore. pg_restore re-enables them; normal app writes enforce FKs.
      const schema = path.join(runtime, 'schema.private.sql'), data = path.join(runtime, 'data.private.sql');
      command(pgTool('pg_restore'), ['--schema-only', '--file=' + schema, dump], { quiet: true, label: 'Render clone schema' });
      command(pgTool('pg_restore'), ['--data-only', '--disable-triggers', '--file=' + data, dump], { quiet: true, label: 'Render preserved clone data' });
      command(pgTool('psql'), ['--host=127.0.0.1', '--port=55432', '--username=' + env.POSTGRES_USER, '--dbname=dhumi_test', '--single-transaction', '--set=ON_ERROR_STOP=1', '--no-password', '--file=' + schema, '--file=' + data], { env: { ...cliEnv, PGOPTIONS: '' }, quiet: true, label: 'Docker restore' });
      await verifyTarget(target);
      await receipt(source, target, before);
    } finally { await source.end(); }
  } finally { await target.end(); }
}
