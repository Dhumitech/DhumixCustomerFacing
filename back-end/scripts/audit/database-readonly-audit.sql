\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

WITH
required_roles(role_name) AS (
  VALUES
    ('dhumi_owner'),
    ('dhumi_admission'),
    ('dhumi_customer_api'),
    ('dhumi_identity'),
    ('dhumi_job_manager'),
    ('dhumi_operator'),
    ('dhumi_outbox_dispatcher'),
    ('dhumi_result_recorder')
),
runtime_roles(role_name) AS (
  SELECT role_name FROM required_roles WHERE role_name <> 'dhumi_owner'
),
required_tables(table_name) AS (
  VALUES
    ('schema_migrations'), ('users'), ('tenants'), ('tenant_user_access'),
    ('auth_sessions'), ('auth_refresh_tokens'), ('legal_acceptances'), ('platform_api_keys'),
    ('launch_evidence'), ('feature_flags'), ('adapter_definitions'),
    ('adapter_versions'), ('service_templates'), ('service_template_versions'),
    ('provider_credentials'), ('provider_mappings'), ('catalog_imports'),
    ('catalog_candidates'), ('services'), ('service_versions'), ('runs'),
    ('run_attempts'), ('run_events'), ('artifacts'), ('usage_events'),
    ('provider_cost_holds'), ('idempotency_records'), ('outbox_events'),
    ('audit_events'), ('run_status_transitions')
),
required_views(view_name) AS (
  VALUES
    ('due_response_envelopes')
),
required_rls_tables(table_name) AS (
  VALUES
    ('tenants'), ('tenant_user_access'), ('platform_api_keys'),
    ('legal_acceptances'), ('services'), ('service_versions'), ('runs'),
    ('run_attempts'), ('run_events'), ('artifacts'), ('usage_events'),
    ('provider_cost_holds'), ('idempotency_records'), ('audit_events'),
    ('service_templates'), ('service_template_versions')
),
required_immutable_tables(table_name) AS (
  VALUES
    ('adapter_versions'), ('service_template_versions'), ('service_versions'),
    ('provider_mappings'), ('legal_acceptances'), ('run_events'),
    ('usage_events'), ('audit_events')
),
required_tenant_fks(child_table, child_column, parent_table) AS (
  VALUES
    ('service_versions', 'service_id', 'services'),
    ('runs', 'service_version_id', 'service_versions'),
    ('runs', 'retry_of_run_id', 'runs'),
    ('run_attempts', 'run_id', 'runs'),
    ('run_events', 'run_id', 'runs'),
    ('run_events', 'attempt_id', 'run_attempts'),
    ('artifacts', 'run_id', 'runs'),
    ('artifacts', 'attempt_id', 'run_attempts'),
    ('usage_events', 'run_id', 'runs'),
    ('usage_events', 'attempt_id', 'run_attempts'),
    ('provider_cost_holds', 'run_id', 'runs')
),
immutable_status(table_name, is_enforced) AS (
  SELECT
    required.table_name,
    EXISTS (
      SELECT 1
      FROM pg_trigger trigger
      JOIN pg_class t ON t.oid = trigger.tgrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_proc p ON p.oid = trigger.tgfoid
      WHERE n.nspname = :'expected_schema'
        AND t.relname = required.table_name
        AND NOT trigger.tgisinternal
        AND p.proname = 'reject_version_mutation'
    )
  FROM required_immutable_tables required
),
function_text AS (
  SELECT
    p.proname,
    pg_get_functiondef(p.oid) AS definition
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = :'expected_schema'
),
run_constraint AS (
  SELECT string_agg(pg_get_constraintdef(c.oid), ' ') AS definition
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = :'expected_schema'
    AND t.relname = 'runs'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%internal_status%'
),
idempotency_columns AS (
  SELECT array_agg(column_name ORDER BY ordinal_position) AS names
  FROM information_schema.columns
  WHERE table_schema = :'expected_schema'
    AND table_name = 'idempotency_records'
),
checks(category, check_name, status, details) AS (
  SELECT
    'Connection',
    'Expected database',
    CASE WHEN current_database() = :'expected_database' THEN 'PASS' ELSE 'FAIL' END,
    'connected=' || current_database() || '; expected=' || :'expected_database'

  UNION ALL
  SELECT
    'Cluster',
    'PostgreSQL 18.x',
    CASE WHEN current_setting('server_version_num')::integer >= 180000
               AND current_setting('server_version_num')::integer < 190000
         THEN 'PASS' ELSE 'FAIL' END,
    current_setting('server_version')

  UNION ALL
  SELECT
    'Cluster',
    'Local-only listener setting',
    CASE WHEN current_setting('listen_addresses') = 'localhost' THEN 'PASS' ELSE 'FAIL' END,
    'listen_addresses=' || current_setting('listen_addresses')

  UNION ALL
  SELECT
    'Cluster',
    'SCRAM password encryption',
    CASE WHEN current_setting('password_encryption') = 'scram-sha-256' THEN 'PASS' ELSE 'FAIL' END,
    'password_encryption=' || current_setting('password_encryption')

  UNION ALL
  SELECT
    'Cluster',
    'Data checksums enabled',
    CASE WHEN current_setting('data_checksums') = 'on' THEN 'PASS' ELSE 'FAIL' END,
    'data_checksums=' || current_setting('data_checksums')

  UNION ALL
  SELECT
    'Ownership',
    'Database owner',
    CASE WHEN pg_get_userbyid(d.datdba) = :'expected_owner' THEN 'PASS' ELSE 'FAIL' END,
    'owner=' || pg_get_userbyid(d.datdba)
  FROM pg_database d
  WHERE d.datname = current_database()

  UNION ALL
  SELECT
    'Ownership',
    'Application schema owner',
    CASE WHEN pg_get_userbyid(n.nspowner) = :'expected_owner' THEN 'PASS' ELSE 'FAIL' END,
    'owner=' || pg_get_userbyid(n.nspowner)
  FROM pg_namespace n
  WHERE n.nspname = :'expected_schema'

  UNION ALL
  SELECT
    'Roles',
    'Required roles exist',
    CASE WHEN count(r.oid) = (SELECT count(*) FROM required_roles) THEN 'PASS' ELSE 'FAIL' END,
    'found=' || count(r.oid)::text || '; expected=' || (SELECT count(*) FROM required_roles)::text
  FROM required_roles expected
  LEFT JOIN pg_roles r ON r.rolname = expected.role_name

  UNION ALL
  SELECT
    'Roles',
    'Runtime and owner roles are non-login/non-superuser',
    CASE WHEN bool_and(
      NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreatedb
      AND NOT r.rolcreaterole AND NOT r.rolreplication AND NOT r.rolbypassrls
    ) THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(string_agg(
      r.rolname || '[login=' || r.rolcanlogin || ',super=' || r.rolsuper ||
      ',createdb=' || r.rolcreatedb || ',createrole=' || r.rolcreaterole ||
      ',bypassrls=' || r.rolbypassrls || ']', '; ' ORDER BY r.rolname
    ), 'roles missing')
  FROM required_roles expected
  LEFT JOIN pg_roles r ON r.rolname = expected.role_name

  UNION ALL
  SELECT
    'Roles',
    'Runtime roles can connect',
    CASE WHEN bool_and(has_database_privilege(role_name, current_database(), 'CONNECT'))
         THEN 'PASS' ELSE 'FAIL' END,
    string_agg(role_name || '=' || has_database_privilege(role_name, current_database(), 'CONNECT'), '; ' ORDER BY role_name)
  FROM runtime_roles

  UNION ALL
  SELECT
    'Roles',
    'Runtime roles use but cannot create in app schema',
    CASE WHEN bool_and(
      has_schema_privilege(role_name, :'expected_schema', 'USAGE')
      AND NOT has_schema_privilege(role_name, :'expected_schema', 'CREATE')
    ) THEN 'PASS' ELSE 'FAIL' END,
    string_agg(
      role_name || '[use=' || has_schema_privilege(role_name, :'expected_schema', 'USAGE') ||
      ',create=' || has_schema_privilege(role_name, :'expected_schema', 'CREATE') || ']','; ' ORDER BY role_name
    )
  FROM runtime_roles

  UNION ALL
  SELECT
    'Public privileges',
    'PUBLIC cannot connect to database',
    CASE WHEN NOT EXISTS (
      SELECT 1 FROM pg_database d,
        LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) acl
      WHERE d.datname = current_database() AND acl.grantee = 0 AND acl.privilege_type = 'CONNECT'
    ) THEN 'PASS' ELSE 'FAIL' END,
    'No explicit PUBLIC CONNECT grant is permitted.'

  UNION ALL
  SELECT
    'Public privileges',
    'PUBLIC has no app schema privilege',
    CASE WHEN NOT EXISTS (
      SELECT 1 FROM pg_namespace n,
        LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) acl
      WHERE n.nspname = :'expected_schema' AND acl.grantee = 0
        AND acl.privilege_type IN ('USAGE', 'CREATE')
    ) THEN 'PASS' ELSE 'FAIL' END,
    'PUBLIC USAGE/CREATE must both be absent.'

  UNION ALL
  SELECT
    'Public privileges',
    'PUBLIC has no app table privilege',
    CASE WHEN NOT EXISTS (
      SELECT 1
      FROM pg_class t
      JOIN pg_namespace n ON n.oid = t.relnamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(t.relacl, acldefault('r', t.relowner))) acl
      WHERE n.nspname = :'expected_schema' AND t.relkind IN ('r', 'p', 'v', 'm') AND acl.grantee = 0
    ) THEN 'PASS' ELSE 'FAIL' END,
    'All app relations checked.'

  UNION ALL
  SELECT
    'Public privileges',
    'PUBLIC has no app function privilege',
    CASE WHEN NOT EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
      WHERE n.nspname = :'expected_schema' AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
    ) THEN 'PASS' ELSE 'FAIL' END,
    'All app functions checked.'

  UNION ALL
  SELECT
    'Schema',
    'Exact current table set',
    CASE WHEN NOT EXISTS (
      SELECT table_name FROM required_tables
      EXCEPT
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = :'expected_schema'
        AND table_type = 'BASE TABLE'
    ) AND NOT EXISTS (
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = :'expected_schema'
        AND table_type = 'BASE TABLE'
      EXCEPT
      SELECT table_name FROM required_tables
    ) THEN 'PASS' ELSE 'FAIL' END,
    'actual=' || (
      SELECT count(*)::text
      FROM information_schema.tables
      WHERE table_schema = :'expected_schema'
        AND table_type = 'BASE TABLE'
    ) ||
    '; expected=' || (SELECT count(*)::text FROM required_tables)

  UNION ALL
  SELECT
    'Schema',
    'Exact current view set',
    CASE WHEN NOT EXISTS (
      SELECT view_name FROM required_views
      EXCEPT
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = :'expected_schema'
        AND table_type = 'VIEW'
    ) AND NOT EXISTS (
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = :'expected_schema'
        AND table_type = 'VIEW'
      EXCEPT
      SELECT view_name FROM required_views
    ) THEN 'PASS' ELSE 'FAIL' END,
    'actual=' || (
      SELECT count(*)::text
      FROM information_schema.tables
      WHERE table_schema = :'expected_schema'
        AND table_type = 'VIEW'
    ) ||
    '; expected=' || (SELECT count(*)::text FROM required_views)

  UNION ALL
  SELECT
    'Scope',
    'No forbidden demo tables',
    CASE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = :'expected_schema'
        AND table_name ~* '(activation|subscription|invoice|payment|credit|quota|team|invite|membership)'
    ) THEN 'PASS' ELSE 'FAIL' END,
    COALESCE((
      SELECT string_agg(table_name, ', ' ORDER BY table_name)
      FROM information_schema.tables
      WHERE table_schema = :'expected_schema'
        AND table_name ~* '(activation|subscription|invoice|payment|credit|quota|team|invite|membership)'
    ), 'none')

  UNION ALL
  SELECT
    'Ownership',
    'All app tables owned by migration owner',
    CASE WHEN count(*) FILTER (WHERE pg_get_userbyid(t.relowner) <> :'expected_owner') = 0
         THEN 'PASS' ELSE 'FAIL' END,
    'incorrect=' || count(*) FILTER (WHERE pg_get_userbyid(t.relowner) <> :'expected_owner')::text
  FROM pg_class t
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = :'expected_schema' AND t.relkind IN ('r', 'p')

  UNION ALL
  SELECT
    'Ownership',
    'All app functions owned by migration owner',
    CASE WHEN count(*) FILTER (WHERE pg_get_userbyid(p.proowner) <> :'expected_owner') = 0
         THEN 'PASS' ELSE 'FAIL' END,
    'incorrect=' || count(*) FILTER (WHERE pg_get_userbyid(p.proowner) <> :'expected_owner')::text
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = :'expected_schema'

  UNION ALL
  SELECT
    'RLS',
    'Required tables enable and force RLS',
    CASE WHEN bool_and(COALESCE(t.relrowsecurity AND t.relforcerowsecurity, false))
         THEN 'PASS' ELSE 'FAIL' END,
    string_agg(expected.table_name || '[enabled=' || COALESCE(t.relrowsecurity, false) ||
      ',forced=' || COALESCE(t.relforcerowsecurity, false) || ']', '; ' ORDER BY expected.table_name)
  FROM required_rls_tables expected
  LEFT JOIN pg_class t ON t.relname = expected.table_name
  LEFT JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = :'expected_schema'

  UNION ALL
  SELECT
    'RLS',
    'Every required RLS table has a policy',
    CASE WHEN bool_and(COALESCE(policy_count, 0) > 0) THEN 'PASS' ELSE 'FAIL' END,
    string_agg(expected.table_name || '=' || COALESCE(policy_count, 0)::text, '; ' ORDER BY expected.table_name)
  FROM required_rls_tables expected
  LEFT JOIN (
    SELECT tablename, count(*) AS policy_count
    FROM pg_policies
    WHERE schemaname = :'expected_schema'
    GROUP BY tablename
  ) policy ON policy.tablename = expected.table_name

  UNION ALL
  SELECT
    'Tenant integrity',
    'Required composite tenant foreign keys',
    CASE WHEN bool_and(EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_class child ON child.oid = c.conrelid
      JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
      JOIN pg_class parent ON parent.oid = c.confrelid
      WHERE c.contype = 'f'
        AND child_ns.nspname = :'expected_schema'
        AND child.relname = required.child_table
        AND parent.relname = required.parent_table
        AND pg_get_constraintdef(c.oid) ILIKE
          '%FOREIGN KEY (tenant_id, ' || required.child_column || ') REFERENCES ' ||
          :'expected_schema' || '.' || required.parent_table || '(tenant_id, id)%'
    )) THEN 'PASS' ELSE 'FAIL' END,
    string_agg(required.child_table || '.' || required.child_column || '->' || required.parent_table,
      '; ' ORDER BY required.child_table, required.child_column)
  FROM required_tenant_fks required

  UNION ALL
  SELECT
    'Immutability',
    'Required history/configuration tables reject UPDATE and DELETE',
    CASE WHEN bool_and(status.is_enforced) THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(
      string_agg(status.table_name, ', ' ORDER BY status.table_name)
        FILTER (WHERE NOT status.is_enforced),
      'all required tables are protected'
    )
  FROM immutable_status status

  UNION ALL
  SELECT
    'Run lifecycle',
    'Stored state constraint covers transition graph',
    CASE WHEN NOT EXISTS (
      SELECT state
      FROM (
        SELECT from_internal_status AS state FROM app.run_status_transitions
        UNION
        SELECT to_internal_status FROM app.run_status_transitions
      ) graph
      CROSS JOIN run_constraint constraint_text
      WHERE constraint_text.definition NOT ILIKE '%' || graph.state || '%'
    ) THEN 'PASS' ELSE 'FAIL' END,
    COALESCE((
      SELECT string_agg(state, ', ' ORDER BY state)
      FROM (
        SELECT state
        FROM (
          SELECT from_internal_status AS state FROM app.run_status_transitions
          UNION
          SELECT to_internal_status FROM app.run_status_transitions
        ) graph
        CROSS JOIN run_constraint constraint_text
        WHERE constraint_text.definition NOT ILIKE '%' || graph.state || '%'
      ) missing
    ), 'all transition states accepted')

  UNION ALL
  SELECT
    'Run lifecycle',
    'Transition and status-writer functions exist',
    CASE WHEN to_regprocedure('app.transition_run(uuid,bigint,text,text,text,uuid,text,boolean,jsonb)') IS NOT NULL
               AND to_regprocedure('app.guard_run_status_writer()') IS NOT NULL
         THEN 'PASS' ELSE 'FAIL' END,
    'transition_run + guard_run_status_writer'

  UNION ALL
  SELECT
    'Run lifecycle',
    'Job Manager direct UPDATE is a reviewed hardening gap',
    CASE WHEN has_table_privilege('dhumi_job_manager', :'expected_schema' || '.runs', 'UPDATE')
         THEN 'WARN' ELSE 'PASS' END,
    CASE WHEN has_table_privilege('dhumi_job_manager', :'expected_schema' || '.runs', 'UPDATE')
         THEN 'SECURITY INVOKER currently needs UPDATE, but direct SQL can bypass the transition graph. Prefer a narrowly owned SECURITY DEFINER function in a forward migration.'
         ELSE 'Job Manager cannot update runs directly.' END

  UNION ALL
  SELECT
    'Immutability',
    'Runtime roles cannot update Run history',
    CASE WHEN NOT has_table_privilege('dhumi_job_manager', :'expected_schema' || '.run_events', 'UPDATE')
               AND NOT has_table_privilege('dhumi_result_recorder', :'expected_schema' || '.run_events', 'UPDATE')
         THEN 'PASS' ELSE 'FAIL' END,
    'job_manager=' || has_table_privilege('dhumi_job_manager', :'expected_schema' || '.run_events', 'UPDATE') ||
      '; result_recorder=' || has_table_privilege('dhumi_result_recorder', :'expected_schema' || '.run_events', 'UPDATE')

  UNION ALL
  SELECT
    'Outbox',
    'Only dispatcher can update outbox rows',
    CASE WHEN NOT has_table_privilege('dhumi_identity', :'expected_schema' || '.outbox_events', 'UPDATE')
               AND NOT has_table_privilege('dhumi_admission', :'expected_schema' || '.outbox_events', 'UPDATE')
               AND NOT has_table_privilege('dhumi_job_manager', :'expected_schema' || '.outbox_events', 'UPDATE')
               AND NOT has_table_privilege('dhumi_result_recorder', :'expected_schema' || '.outbox_events', 'UPDATE')
         THEN 'PASS' ELSE 'FAIL' END,
    'identity=' || has_table_privilege('dhumi_identity', :'expected_schema' || '.outbox_events', 'UPDATE') ||
      '; admission=' || has_table_privilege('dhumi_admission', :'expected_schema' || '.outbox_events', 'UPDATE') ||
      '; job_manager=' || has_table_privilege('dhumi_job_manager', :'expected_schema' || '.outbox_events', 'UPDATE') ||
      '; result_recorder=' || has_table_privilege('dhumi_result_recorder', :'expected_schema' || '.outbox_events', 'UPDATE')

  UNION ALL
  SELECT
    'Integration boundary',
    'Job Manager cannot read credential registry',
    CASE WHEN NOT has_table_privilege('dhumi_job_manager', :'expected_schema' || '.provider_credentials', 'SELECT')
         THEN 'PASS' ELSE 'FAIL' END,
    'job_manager_select=' || has_table_privilege('dhumi_job_manager', :'expected_schema' || '.provider_credentials', 'SELECT')

  UNION ALL
  SELECT
    'Secrets',
    'No plaintext Dhumi API-key column',
    CASE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = :'expected_schema' AND table_name = 'platform_api_keys'
        AND column_name ~* '(plain|secret|raw).*key|key.*(plain|secret|raw)'
    ) AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = :'expected_schema' AND table_name = 'platform_api_keys' AND column_name = 'key_hash'
    ) THEN 'PASS' ELSE 'FAIL' END,
    'Only prefix/hash metadata may be stored.'

  UNION ALL
  SELECT
    'Idempotency',
    'API-key encrypted response envelope fields',
    CASE WHEN EXISTS (
      SELECT 1 FROM unnest(columns.names) name WHERE name ~* '(envelope|response).*cipher|cipher.*(envelope|response)'
    ) AND EXISTS (
      SELECT 1 FROM unnest(columns.names) name WHERE name ~* '(kms|key).*reference|reference.*(kms|key)'
    ) AND EXISTS (
      SELECT 1 FROM unnest(columns.names) name WHERE name ~* 'recoverable.*until|recovery.*expires'
    ) AND EXISTS (
      SELECT 1 FROM unnest(columns.names) name WHERE name ~* 'destroyed.*at|destruction.*time'
    ) THEN 'PASS' ELSE 'FAIL' END,
    array_to_string(columns.names, ', ')
  FROM idempotency_columns columns

  UNION ALL
  SELECT
    'Signup',
    'Existing email uses a generic accepted path',
    CASE WHEN definition ~* 'ON[[:space:]]+CONFLICT|unique_violation|FROM[[:space:]]+app[.]users.*email_normalized'
         THEN 'PASS' ELSE 'FAIL' END,
    'Static semantic gate: verify existing normalized email cannot surface a unique violation.'
  FROM function_text
  WHERE proname = 'create_signup'

  UNION ALL
  SELECT
    'Signup',
    'Concurrent first idempotency claim is serialized',
    CASE WHEN definition ~* 'pg_advisory_xact_lock|INSERT[[:space:]]+INTO[[:space:]]+app[.]idempotency_records.*ON[[:space:]]+CONFLICT'
         THEN 'PASS' ELSE 'FAIL' END,
    'SELECT FOR UPDATE does not lock a row that does not exist.'
  FROM function_text
  WHERE proname = 'create_signup'

  UNION ALL
  SELECT
    'Data state',
    'Customer-owned row count',
    'INFO',
    'users=' || (SELECT count(*) FROM app.users) ||
      '; tenants=' || (SELECT count(*) FROM app.tenants) ||
      '; services=' || (SELECT count(*) FROM app.services) ||
      '; runs=' || (SELECT count(*) FROM app.runs)
)
SELECT
  'CHECK' AS record_type,
  category,
  check_name AS record_name,
  status,
  details
FROM checks

UNION ALL

SELECT
  'MIGRATION' AS record_type,
  'Migration ledger' AS category,
  version AS record_name,
  'INFO' AS status,
  checksum AS details
FROM app.schema_migrations

ORDER BY record_type, category, record_name;

COMMIT;
