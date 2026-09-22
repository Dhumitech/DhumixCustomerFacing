-- Regression tests for 0009_envelope_destruction.sql.
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

CREATE TEMP TABLE envelope_janitor_fixture (
  due_tenant_id uuid,
  live_tenant_id uuid,
  due_record_id uuid,
  live_record_id uuid
) ON COMMIT DROP;
GRANT ALL ON TABLE envelope_janitor_fixture TO PUBLIC;
INSERT INTO envelope_janitor_fixture DEFAULT VALUES;

-- The capability can see only the columns needed to discover/destroy an
-- envelope. Logical request identity and Tenant identity stay unreadable.
SELECT pg_temp.assert_true(
  has_column_privilege(
    'dhumi_envelope_janitor',
    'app.due_response_envelopes',
    'id',
    'SELECT'
  )
  AND has_column_privilege(
    'dhumi_envelope_janitor',
    'app.due_response_envelopes',
    'response_envelope_ciphertext',
    'SELECT'
  )
  AND has_column_privilege(
    'dhumi_envelope_janitor',
    'app.due_response_envelopes',
    'response_envelope_recoverable_until',
    'SELECT'
  ),
  'janitor must select only its discovery columns'
);
SELECT pg_temp.assert_true(
  has_column_privilege(
    'dhumi_envelope_janitor',
    'app.due_response_envelopes',
    'response_envelope_ciphertext',
    'UPDATE'
  )
  AND has_column_privilege(
    'dhumi_envelope_janitor',
    'app.due_response_envelopes',
    'response_envelope_key_reference',
    'UPDATE'
  )
  AND has_column_privilege(
    'dhumi_envelope_janitor',
    'app.due_response_envelopes',
    'response_envelope_destroyed_at',
    'UPDATE'
  ),
  'janitor must update only envelope-destruction columns'
);
SELECT pg_temp.assert_true(
  NOT has_column_privilege(
    'dhumi_envelope_janitor',
    'app.idempotency_records',
    'tenant_id',
    'SELECT'
  )
  AND NOT has_column_privilege(
    'dhumi_envelope_janitor',
    'app.idempotency_records',
    'idempotency_key',
    'SELECT'
  )
  AND NOT has_column_privilege(
    'dhumi_envelope_janitor',
    'app.idempotency_records',
    'actor_fingerprint',
    'SELECT'
  )
  AND NOT has_column_privilege(
    'dhumi_envelope_janitor',
    'app.idempotency_records',
    'request_hash',
    'SELECT'
  )
  AND NOT has_table_privilege(
    'dhumi_envelope_janitor',
    'app.idempotency_records',
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  'janitor must not read request identity or insert/delete tombstones'
);
SELECT pg_temp.assert_true(
  has_function_privilege(
    'dhumi_envelope_janitor',
    'app.destroy_due_response_envelopes(integer)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'dhumi_customer_api',
    'app.destroy_due_response_envelopes(integer)',
    'EXECUTE'
  ),
  'only the janitor capability must execute destruction'
);

SET LOCAL ROLE dhumi_identity;
WITH due_tenant AS (
  INSERT INTO app.tenants (display_name)
  VALUES ('Envelope Janitor Due Tenant')
  RETURNING id
), live_tenant AS (
  INSERT INTO app.tenants (display_name)
  VALUES ('Envelope Janitor Live Tenant')
  RETURNING id
)
UPDATE envelope_janitor_fixture
SET
  due_tenant_id = due_tenant.id,
  live_tenant_id = live_tenant.id
FROM due_tenant, live_tenant;
RESET ROLE;

SET LOCAL ROLE dhumi_customer_api;
SELECT set_config(
  'app.tenant_id',
  (SELECT due_tenant_id::text FROM envelope_janitor_fixture),
  true
);
WITH captured_time AS MATERIALIZED (
  SELECT clock_timestamp() AS value
), inserted AS (
  INSERT INTO app.idempotency_records (
    tenant_id, scope_kind, actor_fingerprint, operation_code,
    idempotency_key, request_hash, state, response_status,
    created_at, expires_at, completed_at,
    response_envelope_ciphertext, response_envelope_key_reference,
    response_envelope_recoverable_until
  )
  SELECT
    due_tenant_id, 'tenant', decode(repeat('11', 32), 'hex'),
    'api_keys.create', 'janitor-due-record-0001', decode(repeat('12', 32), 'hex'),
    'completed', 201, value - interval '2 hours', value + interval '1 day',
    value - interval '1 hour', decode('13', 'hex'), 'local:test-key',
    value - interval '50 minutes'
  FROM envelope_janitor_fixture, captured_time
  RETURNING id
)
UPDATE envelope_janitor_fixture
SET due_record_id = inserted.id
FROM inserted;

SELECT set_config(
  'app.tenant_id',
  (SELECT live_tenant_id::text FROM envelope_janitor_fixture),
  true
);
WITH captured_time AS MATERIALIZED (
  SELECT clock_timestamp() AS value
), inserted AS (
  INSERT INTO app.idempotency_records (
    tenant_id, scope_kind, actor_fingerprint, operation_code,
    idempotency_key, request_hash, state, response_status,
    created_at, expires_at, completed_at,
    response_envelope_ciphertext, response_envelope_key_reference,
    response_envelope_recoverable_until
  )
  SELECT
    live_tenant_id, 'tenant', decode(repeat('21', 32), 'hex'),
    'api_keys.create', 'janitor-live-record-0001', decode(repeat('22', 32), 'hex'),
    'completed', 201, value - interval '1 minute', value + interval '1 day',
    value - interval '30 seconds', decode('23', 'hex'), 'local:test-key',
    value + interval '10 minutes'
  FROM envelope_janitor_fixture, captured_time
  RETURNING id
)
UPDATE envelope_janitor_fixture
SET live_record_id = inserted.id
FROM inserted;
RESET ROLE;

SET LOCAL ROLE dhumi_envelope_janitor;
SELECT pg_temp.assert_true(
  (SELECT count(*) FROM app.due_response_envelopes) = 1,
  'RLS must expose a due live envelope but hide every non-due row across Tenants'
);

DO $$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    PERFORM tenant_id, idempotency_key, actor_fingerprint, request_hash
    FROM app.idempotency_records;
  EXCEPTION WHEN insufficient_privilege THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'janitor must not read request identity columns');
END;
$$;

SELECT pg_temp.assert_true(
  app.destroy_due_response_envelopes(100) = 1,
  'one due envelope must be destroyed atomically'
);
SELECT pg_temp.assert_true(
  app.destroy_due_response_envelopes(100) = 0,
  're-running destruction must be idempotent'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) FROM app.due_response_envelopes) = 0,
  'destroyed and non-due rows must both be invisible to janitor RLS'
);

DO $$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    PERFORM app.destroy_due_response_envelopes(501);
  EXCEPTION WHEN invalid_parameter_value THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'batch limit above 500 must fail closed');
END;
$$;
RESET ROLE;

SET LOCAL ROLE dhumi_customer_api;
SELECT set_config(
  'app.tenant_id',
  (SELECT due_tenant_id::text FROM envelope_janitor_fixture),
  true
);
SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1
    FROM app.idempotency_records
    WHERE id = (SELECT due_record_id FROM envelope_janitor_fixture)
      AND state = 'completed'
      AND response_envelope_ciphertext IS NULL
      AND response_envelope_key_reference IS NULL
      AND response_envelope_destroyed_at >= response_envelope_recoverable_until
  ),
  'destroyed row must remain as permanent CHECK-state-3 tombstone evidence'
);

SELECT set_config(
  'app.tenant_id',
  (SELECT live_tenant_id::text FROM envelope_janitor_fixture),
  true
);
SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1
    FROM app.idempotency_records
    WHERE id = (SELECT live_record_id FROM envelope_janitor_fixture)
      AND response_envelope_ciphertext = decode('23', 'hex')
      AND response_envelope_key_reference = 'local:test-key'
      AND response_envelope_destroyed_at IS NULL
  ),
  'a non-due envelope must remain recoverable and unchanged'
);
RESET ROLE;

ROLLBACK;
