-- Privileged rollback-only proof for migration 0024.
-- The grant correction is rolled back and no fixture data is created.
\set ON_ERROR_STOP on

BEGIN;
\ir ../../scripts/migrations/0024_run_retry_idempotency_lineage.sql

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
  has_column_privilege(
    'dhumi_admission',
    'app.idempotency_records',
    'related_resource_id',
    'SELECT'
  )
  AND has_column_privilege(
    'dhumi_admission',
    'app.idempotency_records',
    'related_resource_id',
    'UPDATE'
  ),
  'Admission must read and complete only the retry related-resource column'
);

SELECT pg_temp.assert_true(
  NOT has_column_privilege(
    'dhumi_admission',
    'app.idempotency_records',
    'tenant_id',
    'UPDATE'
  )
  AND NOT has_column_privilege(
    'dhumi_admission',
    'app.idempotency_records',
    'actor_fingerprint',
    'UPDATE'
  )
  AND NOT has_column_privilege(
    'dhumi_admission',
    'app.idempotency_records',
    'request_hash',
    'UPDATE'
  )
  AND NOT has_table_privilege(
    'dhumi_admission',
    'app.idempotency_records',
    'UPDATE'
  ),
  'retry completion must not gain table-wide or claim-identity mutation'
);

ROLLBACK;
