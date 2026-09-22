-- Privileged rollback-only proof for migration 0023.
-- The policy correction is rolled back and no fixture data is created.
\set ON_ERROR_STOP on

BEGIN;
\ir ../../scripts/migrations/0023_run_retry_owner_rls.sql

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
  EXISTS (
    SELECT 1
    FROM pg_policy
    WHERE polrelid = 'app.service_versions'::regclass
      AND polname = 'service_versions_tenant_isolation'
      AND 'dhumi_owner'::regrole::oid = ANY(polroles)
      AND 'dhumi_admission'::regrole::oid = ANY(polroles)
      AND 'dhumi_customer_api'::regrole::oid = ANY(polroles)
      AND pg_get_expr(polqual, polrelid) =
        '(tenant_id = app.current_tenant_id())'
      AND pg_get_expr(polwithcheck, polrelid) =
        '(tenant_id = app.current_tenant_id())'
  ),
  'service_versions must admit the owner only through exact Tenant context'
);

SELECT pg_temp.assert_true(
  NOT has_column_privilege(
    'dhumi_admission',
    'app.runs',
    'validated_input',
    'SELECT'
  )
  AND NOT has_column_privilege(
    'dhumi_admission',
    'app.run_attempts',
    'state',
    'SELECT'
  ),
  'the owner RLS correction must not widen Admission source reads'
);

ROLLBACK;
