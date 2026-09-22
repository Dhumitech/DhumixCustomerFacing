-- Regression tests for 0005_tenant_workspace_state_alignment.sql.
-- The complete file is rolled back and must run only on dhumi_test.

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(p_condition boolean, p_message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_condition IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'assertion failed: %', p_message;
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.assert_true(boolean, text) TO PUBLIC;

-- The named constraint must exist, be validated, and contain exactly the four
-- states published by Workspace.state in the OpenAPI contract.
SELECT pg_temp.assert_true(
  (
    SELECT c.convalidated
      AND pg_get_constraintdef(c.oid) =
        'CHECK ((state = ANY (ARRAY[''active''::text, ''suspended''::text, ''closing''::text, ''closed''::text])))'
    FROM pg_constraint AS c
    JOIN pg_class AS t
      ON t.oid = c.conrelid
    JOIN pg_namespace AS n
      ON n.oid = t.relnamespace
    WHERE n.nspname = 'app'
      AND t.relname = 'tenants'
      AND c.conname = 'tenants_state_check'
      AND c.contype = 'c'
  ),
  'app.tenants must allow exactly active, suspended, closing, and closed'
);

-- Exercise the constraint using the identity capability role, which owns the
-- workspace lifecycle writes used by the authentication module.
SET LOCAL ROLE dhumi_identity;

INSERT INTO app.tenants (id, display_name, state)
VALUES
  ('00000000-0000-4000-8000-000000000501', 'State test active', 'active'),
  ('00000000-0000-4000-8000-000000000502', 'State test suspended', 'suspended'),
  ('00000000-0000-4000-8000-000000000503', 'State test closing', 'closing'),
  ('00000000-0000-4000-8000-000000000504', 'State test closed', 'closed');

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 4
    FROM app.tenants
    WHERE id IN (
      '00000000-0000-4000-8000-000000000501',
      '00000000-0000-4000-8000-000000000502',
      '00000000-0000-4000-8000-000000000503',
      '00000000-0000-4000-8000-000000000504'
    )
  ),
  'all four approved workspace states must be insertable by dhumi_identity'
);

DO $$
DECLARE
  v_rejected boolean := false;
BEGIN
  BEGIN
    INSERT INTO app.tenants (id, display_name, state)
    VALUES (
      '00000000-0000-4000-8000-000000000505',
      'State test invalid',
      'invalid-state'
    );
  EXCEPTION
    WHEN check_violation THEN
      v_rejected := true;
  END;

  PERFORM pg_temp.assert_true(
    v_rejected,
    'an unapproved workspace state must be rejected'
  );
END;
$$;

RESET ROLE;

ROLLBACK;
