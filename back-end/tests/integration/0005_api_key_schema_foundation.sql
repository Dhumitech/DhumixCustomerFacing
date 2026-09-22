-- Regression tests for 0007_api_key_schema_foundation.sql.
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

CREATE TEMP TABLE api_key_foundation_fixture (
  tenant_a uuid,
  tenant_b uuid,
  user_id uuid,
  api_key_id uuid,
  idempotency_id uuid
) ON COMMIT DROP;
GRANT ALL ON TABLE api_key_foundation_fixture TO PUBLIC;
INSERT INTO api_key_foundation_fixture DEFAULT VALUES;

SET LOCAL ROLE dhumi_identity;
WITH created_user AS (
  INSERT INTO app.users (email_normalized, password_hash)
  VALUES ('api-key-foundation@example.test', 'test-password-hash')
  RETURNING id
), tenant_a AS (
  INSERT INTO app.tenants (display_name)
  VALUES ('API Key Foundation Tenant A')
  RETURNING id
), tenant_b AS (
  INSERT INTO app.tenants (display_name)
  VALUES ('API Key Foundation Tenant B')
  RETURNING id
), access_a AS (
  INSERT INTO app.tenant_user_access (tenant_id, user_id)
  SELECT tenant_a.id, created_user.id FROM tenant_a, created_user
), access_b AS (
  INSERT INTO app.tenant_user_access (tenant_id, user_id)
  SELECT tenant_b.id, created_user.id FROM tenant_b, created_user
)
UPDATE api_key_foundation_fixture
SET
  tenant_a = tenant_a.id,
  tenant_b = tenant_b.id,
  user_id = created_user.id
FROM tenant_a, tenant_b, created_user;
RESET ROLE;

-- Exact capability boundary for create/list/replay. API-key revocation remains
-- a later migration because this operation must not gain key UPDATE early.
SELECT pg_temp.assert_true(
  has_table_privilege('dhumi_customer_api', 'app.platform_api_keys', 'SELECT,INSERT'),
  'Customer API must select and insert API-key metadata'
);
SELECT pg_temp.assert_true(
  NOT has_table_privilege('dhumi_customer_api', 'app.platform_api_keys', 'UPDATE,DELETE'),
  'Customer API must not update or delete API keys during create-key phase'
);
SELECT pg_temp.assert_true(
  has_table_privilege('dhumi_customer_api', 'app.idempotency_records', 'SELECT,INSERT'),
  'Customer API must claim and inspect Tenant idempotency rows'
);
SELECT pg_temp.assert_true(
  has_column_privilege('dhumi_customer_api', 'app.idempotency_records', 'state', 'UPDATE')
  AND has_column_privilege(
    'dhumi_customer_api',
    'app.idempotency_records',
    'response_envelope_ciphertext',
    'UPDATE'
  ),
  'Customer API must complete and later destroy its response envelope'
);
SELECT pg_temp.assert_true(
  NOT has_column_privilege(
    'dhumi_customer_api',
    'app.idempotency_records',
    'idempotency_key',
    'UPDATE'
  )
  AND NOT has_table_privilege('dhumi_customer_api', 'app.idempotency_records', 'DELETE'),
  'Customer API must not rewrite claim identity or delete tombstones'
);
SELECT pg_temp.assert_true(
  has_table_privilege('dhumi_customer_api', 'app.audit_events', 'INSERT')
  AND NOT has_table_privilege(
    'dhumi_customer_api',
    'app.audit_events',
    'SELECT,UPDATE,DELETE'
  ),
  'Customer API audit capability must be append-only'
);
SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'app'
      AND tablename = 'audit_events'
      AND policyname = 'audit_events_customer_insert'
      AND cmd = 'INSERT'
      AND roles = ARRAY['dhumi_customer_api']::name[]
  ),
  'Customer API must have a dedicated Tenant-scoped audit INSERT policy'
);

SET LOCAL ROLE dhumi_customer_api;
SELECT set_config(
  'app.tenant_id',
  (SELECT tenant_a::text FROM api_key_foundation_fixture),
  true
);

WITH inserted AS (
  INSERT INTO app.platform_api_keys (
    tenant_id, creator_user_id, name, key_prefix, key_hash, scopes,
    expires_at
  )
  SELECT
    tenant_a, user_id, 'Contract Test Key', 'dh_test_contract',
    decode('01', 'hex'), ARRAY['catalog:read', 'runs:read']::text[],
    clock_timestamp() + interval '30 days'
  FROM api_key_foundation_fixture
  RETURNING id
)
UPDATE api_key_foundation_fixture
SET api_key_id = inserted.id
FROM inserted;

WITH captured_time AS MATERIALIZED (
  SELECT clock_timestamp() AS value
), inserted AS (
  INSERT INTO app.idempotency_records (
    tenant_id, scope_kind, actor_fingerprint, operation_code,
    idempotency_key, request_hash, state, response_status,
    resource_type, resource_id, created_at, expires_at, completed_at,
    response_envelope_ciphertext, response_envelope_key_reference,
    response_envelope_recoverable_until
  )
  SELECT
    tenant_a, 'tenant', decode(repeat('02', 32), 'hex'), 'api_keys.create',
    'api-key-contract-0001', decode(repeat('03', 32), 'hex'),
    'completed', 201, 'platform_api_key', api_key_id,
    captured_time.value, captured_time.value + interval '1 day',
    captured_time.value, decode('04', 'hex'), 'test-kms-key-version',
    captured_time.value + interval '10 minutes'
  FROM api_key_foundation_fixture, captured_time
  RETURNING id
)
UPDATE api_key_foundation_fixture
SET idempotency_id = inserted.id
FROM inserted;

INSERT INTO app.audit_events (
  tenant_id, actor_user_id, action, target_type, target_id, outcome, safe_diff
)
SELECT
  tenant_a, user_id, 'api_keys.create', 'platform_api_key', api_key_id,
  'succeeded', jsonb_build_object('scopes', ARRAY['catalog:read', 'runs:read'])
FROM api_key_foundation_fixture;

SELECT pg_temp.assert_true(
  (SELECT count(*) FROM app.platform_api_keys) = 1
  AND (SELECT count(*) FROM app.idempotency_records) = 1,
  'Tenant A must see its own key and idempotency record'
);

UPDATE app.idempotency_records
SET
  response_envelope_ciphertext = NULL,
  response_envelope_key_reference = NULL,
  response_envelope_destroyed_at = response_envelope_recoverable_until
WHERE id = (SELECT idempotency_id FROM api_key_foundation_fixture);

SELECT set_config(
  'app.tenant_id',
  (SELECT tenant_b::text FROM api_key_foundation_fixture),
  true
);
SELECT pg_temp.assert_true(
  (SELECT count(*) FROM app.platform_api_keys) = 0
  AND (SELECT count(*) FROM app.idempotency_records) = 0,
  'Tenant B must not see Tenant A key or idempotency rows'
);

DO $$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    INSERT INTO app.audit_events (
      tenant_id, actor_user_id, action, target_type, outcome
    )
    SELECT tenant_a, user_id, 'api_keys.create', 'platform_api_key', 'succeeded'
    FROM api_key_foundation_fixture;
  EXCEPTION WHEN insufficient_privilege THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'cross-Tenant audit INSERT must fail RLS');
END;
$$;

DO $$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    UPDATE app.platform_api_keys
    SET name = 'Illegally Changed'
    WHERE id = (SELECT api_key_id FROM api_key_foundation_fixture);
  EXCEPTION WHEN insufficient_privilege THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'create-key capability must not update key rows');
END;
$$;
RESET ROLE;

-- Direct privileged writes prove that malformed states are rejected by the
-- database independently of route/service validation.
DO $$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    INSERT INTO app.platform_api_keys (
      tenant_id, creator_user_id, name, key_prefix, key_hash, scopes
    )
    SELECT
      tenant_a, user_id, 'Duplicate Scopes', 'dh_test_duplicate_scopes',
      decode('05', 'hex'), ARRAY['runs:read', 'runs:read']::text[]
    FROM api_key_foundation_fixture;
  EXCEPTION WHEN check_violation THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'duplicate API-key scopes must fail');
END;
$$;

DO $$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    INSERT INTO app.platform_api_keys (
      tenant_id, creator_user_id, name, key_prefix, key_hash, scopes,
      state, revoked_at
    )
    SELECT
      tenant_a, user_id, 'Bad Lifecycle', 'dh_test_bad_lifecycle',
      decode('06', 'hex'), ARRAY['catalog:read']::text[], 'revoked', NULL
    FROM api_key_foundation_fixture;
  EXCEPTION WHEN check_violation THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'revoked key without revoked_at must fail');
END;
$$;

DO $$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    WITH captured_time AS MATERIALIZED (
      SELECT clock_timestamp() AS value
    )
    INSERT INTO app.idempotency_records (
      tenant_id, scope_kind, actor_fingerprint, operation_code,
      idempotency_key, request_hash, expires_at
    )
    SELECT
      tenant_a, 'tenant', decode('07', 'hex'), 'api_keys.create',
      'too-short', decode('08', 'hex'), clock_timestamp() + interval '1 day'
    FROM api_key_foundation_fixture;
  EXCEPTION WHEN check_violation THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'database must match public Idempotency-Key contract');
END;
$$;

DO $$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    WITH captured_time AS MATERIALIZED (
      SELECT clock_timestamp() AS value
    )
    INSERT INTO app.idempotency_records (
      tenant_id, scope_kind, actor_fingerprint, operation_code,
      idempotency_key, request_hash, state, response_status,
      created_at, expires_at, completed_at, response_envelope_ciphertext,
      response_envelope_key_reference, response_envelope_recoverable_until
    )
    SELECT
      tenant_a, 'tenant', decode('09', 'hex'), 'api_keys.create',
      'bad-envelope-0001', decode('0a', 'hex'), 'completed', 200,
      captured_time.value, captured_time.value + interval '1 day',
      captured_time.value, decode('0b', 'hex'), 'test-kms-key-version',
      captured_time.value + interval '10 minutes'
    FROM api_key_foundation_fixture, captured_time;
  EXCEPTION WHEN check_violation THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'recovery envelope must represent a completed Tenant 201');
END;
$$;

DO $$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    INSERT INTO app.audit_events (tenant_id, action, target_type, outcome, safe_diff)
    SELECT tenant_a, '', 'platform_api_key', 'succeeded', '[]'::jsonb
    FROM api_key_foundation_fixture;
  EXCEPTION WHEN check_violation THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'audit labels must be non-empty and safe_diff an object');
END;
$$;

ROLLBACK;
