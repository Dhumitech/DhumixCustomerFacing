-- Privileged rollback-only structural proof for migration 0022 and Run retry.
-- The migration and every fixture row are rolled back; no provider call or
-- durable retry aggregate survives this script.
\set ON_ERROR_STOP on

BEGIN;
\ir ../../scripts/migrations/0022_run_retry.sql

CREATE FUNCTION pg_temp.assert_true(value boolean, message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'assertion failed: %', message;
  END IF;
END;
$$;

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 2
    FROM pg_constraint
    WHERE connamespace = 'app'::regnamespace
      AND conname IN (
        'idempotency_records_run_retry_semantics_check',
        'runs_retry_not_self_check'
      )
  ),
  'migration 0022 must install both retry CHECK constraints'
);

SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE oid = 'app.lock_run_for_retry(uuid)'::regprocedure
      AND prosecdef
      AND proowner = 'dhumi_owner'::regrole
      AND proconfig @> ARRAY['search_path=pg_catalog, app, pg_temp']::text[]
  ),
  'the retry lock must be a dhumi_owner SECURITY DEFINER function with a safe search path'
);

SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE oid = 'app.validate_run_retry_lineage()'::regprocedure
      AND prosecdef
      AND proowner = 'dhumi_owner'::regrole
      AND proconfig @> ARRAY['search_path=pg_catalog, app, pg_temp']::text[]
  ),
  'the lineage validator must use the reviewed owner boundary'
);

SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'app.runs'::regclass
      AND tgname = 'runs_validate_retry_lineage'
      AND NOT tgisinternal
  ),
  'the retry lineage trigger must be installed on Runs'
);

SELECT pg_temp.assert_true(
  has_function_privilege('dhumi_admission', 'app.lock_run_for_retry(uuid)', 'EXECUTE')
  AND NOT has_function_privilege(
    'dhumi_customer_api',
    'app.lock_run_for_retry(uuid)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'dhumi_job_manager',
    'app.lock_run_for_retry(uuid)',
    'EXECUTE'
  ),
  'only Admission may execute the retry lock capability'
);

SELECT pg_temp.assert_true(
  has_column_privilege('dhumi_admission', 'app.runs', 'retry_of_run_id', 'INSERT')
  AND NOT has_column_privilege('dhumi_admission', 'app.runs', 'validated_input', 'SELECT')
  AND NOT has_column_privilege('dhumi_admission', 'app.run_attempts', 'state', 'SELECT')
  AND NOT has_table_privilege('dhumi_admission', 'app.runs', 'UPDATE'),
  'Admission must receive only lineage INSERT, never broad retry-source access'
);

INSERT INTO app.tenants (id, display_name) VALUES (
  '76000000-0000-4000-8000-000000000001',
  'Rollback-only Run retry'
);

INSERT INTO app.idempotency_records (
  id, tenant_id, scope_kind, actor_fingerprint, operation_code,
  idempotency_key, request_hash, state, expires_at
) VALUES (
  '76000000-0000-4000-8000-000000000002',
  '76000000-0000-4000-8000-000000000001',
  'tenant', decode(repeat('11', 32), 'hex'), 'runs.retry',
  'rollback-retry-proof-0001', decode(repeat('22', 32), 'hex'),
  'in_progress', clock_timestamp() + interval '24 hours'
);

UPDATE app.idempotency_records
SET
  state = 'completed',
  response_status = 202,
  resource_type = 'run',
  resource_id = '76000000-0000-4000-8000-000000000003',
  related_resource_id = '76000000-0000-4000-8000-000000000004',
  response_body_reference = 'inline_json_v1',
  response_body = jsonb_build_object(
    'run_id', '76000000-0000-4000-8000-000000000003',
    'status', 'queued',
    'accepted_at', '2026-08-25T12:00:00.000Z'
  ),
  completed_at = clock_timestamp()
WHERE id = '76000000-0000-4000-8000-000000000002';

DO $$
BEGIN
  BEGIN
    UPDATE app.idempotency_records
    SET response_body = response_body || '{"provider_id":"private"}'::jsonb
    WHERE id = '76000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'expected retry response-shape rejection';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM pg_index AS idx
    JOIN pg_attribute AS attribute
      ON attribute.attrelid = idx.indrelid
     AND attribute.attnum = ANY(idx.indkey)
    WHERE idx.indrelid = 'app.runs'::regclass
      AND idx.indisunique
      AND attribute.attname = 'retry_of_run_id'
  ),
  'retry lineage must remain one-to-many rather than uniquely constrained'
);

ROLLBACK;
