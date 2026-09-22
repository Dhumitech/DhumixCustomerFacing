-- Regression tests for 0004_database_integrity_corrections.sql.
-- The complete file is rolled back and must run only on an isolated test DB.

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

CREATE TEMP TABLE correction_fixture (
  tenant_id uuid,
  user_id uuid,
  service_template_version_id uuid,
  adapter_version_id uuid,
  provider_mapping_id uuid,
  provider_credential_id uuid,
  service_version_id uuid,
  run_id uuid,
  first_outbox_id uuid,
  first_claim_token uuid,
  second_claim_token uuid,
  envelope_id uuid
) ON COMMIT DROP;
GRANT ALL ON TABLE correction_fixture TO PUBLIC;
INSERT INTO correction_fixture DEFAULT VALUES;

CREATE TEMP TABLE claimed_outbox (
  id uuid,
  aggregate_type text,
  aggregate_id uuid,
  tenant_id uuid,
  topic text,
  ordering_key text,
  payload jsonb,
  schema_version integer,
  claim_token uuid
) ON COMMIT DROP;
GRANT ALL ON TABLE claimed_outbox TO PUBLIC;

-- API-key recovery/expiry test. This validates the database representation for
-- the future application response IDEMPOTENCY_REPLAY_EXPIRED behavior. It does
-- not store a plaintext key.
WITH envelope_tenant AS (
  INSERT INTO app.tenants (display_name)
  VALUES ('Envelope Integrity Tenant')
  RETURNING id
)
UPDATE correction_fixture
SET tenant_id = envelope_tenant.id
FROM envelope_tenant;

WITH captured_time AS MATERIALIZED (
  SELECT clock_timestamp() AS value
), inserted AS (
  INSERT INTO app.idempotency_records (
    tenant_id, scope_kind, actor_fingerprint, operation_code, idempotency_key,
    request_hash, state, response_status, created_at, expires_at, completed_at,
    response_envelope_ciphertext,
    response_envelope_key_reference, response_envelope_recoverable_until
  )
  SELECT
    tenant_id, 'tenant', decode('a1', 'hex'), 'keys.create.test',
    'key-envelope-test', decode('b1', 'hex'), 'completed', 201,
    captured_time.value, captured_time.value + interval '1 day',
    captured_time.value, decode('c1', 'hex'),
    'test-kms-key-version-not-a-secret', captured_time.value + interval '10 minutes'
  FROM correction_fixture, captured_time
  RETURNING id
)
UPDATE correction_fixture SET envelope_id = (SELECT id FROM inserted);

UPDATE app.idempotency_records
SET
  response_envelope_ciphertext = NULL,
  response_envelope_key_reference = NULL,
  response_envelope_destroyed_at = response_envelope_recoverable_until
WHERE id = (SELECT envelope_id FROM correction_fixture);

SELECT pg_temp.assert_true(
  (SELECT response_envelope_ciphertext IS NULL
      AND response_envelope_key_reference IS NULL
      AND response_envelope_recoverable_until IS NOT NULL
      AND response_envelope_destroyed_at IS NOT NULL
   FROM app.idempotency_records
   WHERE id = (SELECT envelope_id FROM correction_fixture)),
  'destroyed recovery envelope must retain deadline/evidence but no ciphertext or key reference'
);

DO $$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    WITH captured_time AS MATERIALIZED (
      SELECT clock_timestamp() AS value
    )
    INSERT INTO app.idempotency_records (
      tenant_id, scope_kind, actor_fingerprint, operation_code, idempotency_key,
      request_hash, state, response_status, created_at, expires_at, completed_at,
      response_envelope_ciphertext,
      response_envelope_key_reference, response_envelope_recoverable_until,
      response_envelope_destroyed_at
    )
    SELECT
      tenant_id, 'tenant', decode('a2', 'hex'), 'keys.create.test',
      'invalid-envelope-test', decode('b2', 'hex'), 'completed', 201,
      captured_time.value, captured_time.value + interval '1 day',
      captured_time.value, decode('c2', 'hex'),
      'test-kms-key-version-not-a-secret', captured_time.value + interval '10 minutes',
      captured_time.value + interval '10 minutes'
    FROM correction_fixture, captured_time;
  EXCEPTION WHEN check_violation THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'destroyed envelope must not retain ciphertext');
END;
$$;

-- Create provider-neutral test configuration and one pinned Run.
WITH evidence AS (
  INSERT INTO app.launch_evidence (
    evidence_code, scope_type, scope_key, state, restricted_reference,
    effective_at, approved_by, approved_at
  ) VALUES (
    'test.integrity.adapter', 'adapter', 'integrity-test', 'approved',
    'test://integrity-evidence', clock_timestamp(), 'test', clock_timestamp()
  ) RETURNING id
), definition AS (
  INSERT INTO app.adapter_definitions (code, product_family)
  VALUES ('mock.integrity.marketplace', 'marketplace_dataset')
  RETURNING id
), adapter AS (
  INSERT INTO app.adapter_versions (
    adapter_definition_id, semantic_version, code_artifact_digest, state
  )
  SELECT id, '1.0.0-integrity-test', decode('11', 'hex'), 'enabled'
  FROM definition
  RETURNING id
), template AS (
  INSERT INTO app.service_templates (slug, product_family, state)
  VALUES ('integrity-marketplace-template', 'marketplace_dataset', 'published')
  RETURNING id
), template_version AS (
  INSERT INTO app.service_template_versions (
    service_template_id, version, public_name, public_description,
    input_schema, output_schema, availability_copy, adapter_version_id,
    launch_evidence_id, effective_at, published_at
  )
  SELECT template.id, 1, 'Integrity Marketplace', 'Test only', '{}'::jsonb,
    '{}'::jsonb, 'Test only', adapter.id, evidence.id,
    clock_timestamp(), clock_timestamp()
  FROM template, adapter, evidence
  RETURNING id, adapter_version_id
), credential AS (
  INSERT INTO app.provider_credentials (
    provider_code, environment, vault_secret_reference, permission_label,
    state, activated_at
  ) VALUES (
    'mock', 'test', 'mock://integrity-no-secret', 'mock', 'active', clock_timestamp()
  ) RETURNING id
), mapping AS (
  INSERT INTO app.provider_mappings (
    service_template_version_id, adapter_version_id, provider_credential_id,
    environment, operation_code, provider_resource_ciphertext,
    provider_resource_fingerprint, commercial_config_version, config_version,
    launch_evidence_id, state
  )
  SELECT template_version.id, template_version.adapter_version_id, credential.id,
    'test', 'mock.integrity', decode('12', 'hex'), decode('13', 'hex'),
    'integrity-commercial-v1', 'integrity-config-v1', evidence.id, 'enabled'
  FROM template_version, credential, evidence
  RETURNING id, service_template_version_id, adapter_version_id, provider_credential_id
)
UPDATE correction_fixture
SET
  service_template_version_id = mapping.service_template_version_id,
  adapter_version_id = mapping.adapter_version_id,
  provider_mapping_id = mapping.id,
  provider_credential_id = mapping.provider_credential_id
FROM mapping;

-- Provider Mapping immutability test.
DO $$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    UPDATE app.provider_mappings
    SET operation_code = 'changed-illegally'
    WHERE id = (SELECT provider_mapping_id FROM correction_fixture);
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'pinned Provider Mapping UPDATE must fail');
END;
$$;

SET LOCAL ROLE dhumi_identity;
WITH created AS (
  SELECT *
  FROM app.create_signup(
    'integrity-user@example.test',
    'test-password-hash',
    'Integrity Tenant',
    '[{"document_type":"terms","document_version":"v1","document_hash_hex":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}]'::jsonb,
    'integrity-signup-first',
    decode('21', 'hex'),
    decode('22', 'hex')
  )
)
UPDATE correction_fixture
SET user_id = created.user_id, tenant_id = created.tenant_id
FROM created;

-- Existing normalized email follows the same accepted flow but creates no
-- second User or Tenant and returns no existing identity IDs to the caller.
SELECT pg_temp.assert_true(
  (SELECT result.user_id IS NULL AND result.tenant_id IS NULL AND NOT result.replayed
   FROM app.create_signup(
     'integrity-user@example.test',
     'attacker-supplied-unused-hash',
     'Ignored Workspace',
     '[{"document_type":"terms","document_version":"v1","document_hash_hex":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}]'::jsonb,
     'integrity-signup-existing',
     decode('23', 'hex'),
     decode('22', 'hex')
   ) result),
  'existing email must return a generic accepted internal outcome without IDs'
);

SELECT pg_temp.assert_true(
  (SELECT count(*) FROM app.users WHERE email_normalized = 'integrity-user@example.test') = 1,
  'existing-email signup must not create a second User'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) FROM app.tenant_user_access
   WHERE user_id = (SELECT user_id FROM correction_fixture)) = 1,
  'existing-email signup must not create a second Tenant access row'
);

-- Different-body idempotency test: only this conflict maps to 409.
DO $$
DECLARE
  rejected boolean := false;
  error_message text;
BEGIN
  BEGIN
    PERFORM *
    FROM app.create_signup(
      'integrity-user@example.test',
      'test-password-hash',
      'Different Body',
      '[{"document_type":"terms","document_version":"v1","document_hash_hex":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}]'::jsonb,
      'integrity-signup-first',
      decode('ff', 'hex'),
      decode('22', 'hex')
    );
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS error_message = MESSAGE_TEXT;
    rejected := error_message = 'IDEMPOTENCY_CONFLICT';
  END;
  PERFORM pg_temp.assert_true(
    rejected,
    'same key with different request hash must raise IDEMPOTENCY_CONFLICT'
  );
END;
$$;
RESET ROLE;

SET LOCAL ROLE dhumi_admission;
SELECT set_config('app.tenant_id', (SELECT tenant_id::text FROM correction_fixture), true);
WITH service AS (
  INSERT INTO app.services (tenant_id, service_template_id, name)
  SELECT fixture.tenant_id, version.service_template_id, 'Integrity Service'
  FROM correction_fixture fixture
  JOIN app.service_template_versions version
    ON version.id = fixture.service_template_version_id
  RETURNING id, tenant_id
), service_version AS (
  INSERT INTO app.service_versions (
    tenant_id, service_id, version, service_template_version_id,
    validated_configuration, schema_hash
  )
  SELECT service.tenant_id, service.id, 1, fixture.service_template_version_id,
    '{}'::jsonb, decode('31', 'hex')
  FROM service, correction_fixture fixture
  RETURNING id
), run AS (
  INSERT INTO app.runs (
    tenant_id, service_version_id, service_template_version_id,
    adapter_version_id, provider_mapping_id, commercial_config_version
  )
  SELECT fixture.tenant_id, service_version.id,
    fixture.service_template_version_id, fixture.adapter_version_id,
    fixture.provider_mapping_id, 'integrity-commercial-v1'
  FROM correction_fixture fixture, service_version
  RETURNING id
)
UPDATE correction_fixture
SET service_version_id = service_version.id, run_id = run.id
FROM service_version, run;
RESET ROLE;

SET LOCAL ROLE dhumi_job_manager;
SELECT set_config('app.tenant_id', (SELECT tenant_id::text FROM correction_fixture), true);

-- The restricted SECURITY DEFINER function remains usable after direct UPDATE
-- is revoked from Job Manager.
SELECT app.transition_run(
  (SELECT run_id FROM correction_fixture),
  0,
  'SUBMITTED',
  'provider.accepted',
  'integrity-transition-submitted'
);

DO $$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    UPDATE app.runs
    SET internal_status = 'UPSTREAM_FAILED', public_status = 'failed', state_version = 2
    WHERE id = (SELECT run_id FROM correction_fixture);
  EXCEPTION WHEN insufficient_privilege THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'Job Manager direct Run status UPDATE must fail');
END;
$$;

-- The previously impossible legal transition must now succeed.
SELECT app.transition_run(
  (SELECT run_id FROM correction_fixture),
  1,
  'UPSTREAM_FAILED',
  'provider.failed',
  'integrity-transition-upstream-failed',
  NULL,
  'UPSTREAM_FAILED_SAFE',
  false,
  '{}'::jsonb
);

SELECT pg_temp.assert_true(
  (SELECT internal_status = 'UPSTREAM_FAILED'
      AND public_status = 'failed'
      AND state_version = 2
   FROM app.runs
   WHERE id = (SELECT run_id FROM correction_fixture)),
  'SUBMITTED to UPSTREAM_FAILED must be a legal terminal transition'
);

-- Run-event immutability test and privilege boundary.
DO $$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    UPDATE app.run_events
    SET safe_payload = '{"changed":true}'::jsonb
    WHERE run_id = (SELECT run_id FROM correction_fixture);
  EXCEPTION WHEN insufficient_privilege THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'Job Manager must not update Run history');
END;
$$;

DO $$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    PERFORM id FROM app.provider_credentials LIMIT 1;
  EXCEPTION WHEN insufficient_privilege THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'Job Manager must not read provider credential registry');
END;
$$;
RESET ROLE;

SET LOCAL ROLE dhumi_result_recorder;
SELECT set_config('app.tenant_id', (SELECT tenant_id::text FROM correction_fixture), true);
DO $$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    UPDATE app.run_events
    SET safe_payload = '{"changed":true}'::jsonb
    WHERE run_id = (SELECT run_id FROM correction_fixture);
  EXCEPTION WHEN insufficient_privilege THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'Result Recorder must not update Run history');
END;
$$;
RESET ROLE;

-- The append-only trigger also protects history from a privileged accidental
-- write, independently of the runtime-role REVOKE.
DO $$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    UPDATE app.run_events
    SET safe_payload = '{"privileged_change":true}'::jsonb
    WHERE run_id = (SELECT run_id FROM correction_fixture);
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'Run Event UPDATE must be rejected by append-only trigger');
END;
$$;

SET LOCAL ROLE dhumi_identity;
DO $$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    UPDATE app.outbox_events
    SET available_at = clock_timestamp()
    WHERE tenant_id = (SELECT tenant_id FROM correction_fixture);
  EXCEPTION WHEN insufficient_privilege THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'Identity producer must not update outbox rows');
END;
$$;
RESET ROLE;

-- Outbox stale-claim reclaim test. The test administrator simulates TTL expiry;
-- only the dispatcher can claim and acknowledge the row during runtime.
SET LOCAL ROLE dhumi_outbox_dispatcher;
INSERT INTO claimed_outbox
SELECT * FROM app.claim_outbox_events('integrity-dispatcher-a', 1);
UPDATE correction_fixture
SET first_outbox_id = claimed.id, first_claim_token = claimed.claim_token
FROM claimed_outbox claimed;
RESET ROLE;

UPDATE app.outbox_events
SET claimed_at = clock_timestamp() - interval '10 minutes'
WHERE id = (SELECT first_outbox_id FROM correction_fixture);

TRUNCATE TABLE claimed_outbox;
SET LOCAL ROLE dhumi_outbox_dispatcher;
INSERT INTO claimed_outbox
SELECT * FROM app.claim_outbox_events('integrity-dispatcher-b', 1, interval '5 minutes');
UPDATE correction_fixture
SET second_claim_token = claimed.claim_token
FROM claimed_outbox claimed
WHERE claimed.id = (SELECT first_outbox_id FROM correction_fixture);

SELECT pg_temp.assert_true(
  (SELECT first_claim_token IS DISTINCT FROM second_claim_token FROM correction_fixture),
  'stale outbox claim must be reclaimed with a new token'
);
SELECT pg_temp.assert_true(
  NOT app.mark_outbox_event_published(
    (SELECT first_outbox_id FROM correction_fixture),
    (SELECT first_claim_token FROM correction_fixture)
  ),
  'old outbox claim token must not acknowledge a reclaimed event'
);
SELECT pg_temp.assert_true(
  app.mark_outbox_event_published(
    (SELECT first_outbox_id FROM correction_fixture),
    (SELECT second_claim_token FROM correction_fixture)
  ),
  'new outbox claim token must acknowledge the reclaimed event'
);
RESET ROLE;

ROLLBACK;
