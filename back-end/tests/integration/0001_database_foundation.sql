-- Run with DATABASE_TEST_URL after applying the migrations. The test principal
-- must be permitted to SET ROLE to each dhumi_* NOLOGIN role. Every fixture is
-- rolled back so the test never deletes or mutates shared test data.

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

CREATE TEMP TABLE fixture (
  tenant_a uuid,
  tenant_b uuid,
  user_a uuid,
  user_b uuid,
  service_template_id uuid,
  service_template_version_id uuid,
  adapter_version_id uuid,
  provider_mapping_id uuid,
  launch_evidence_id uuid,
  feature_flag_id uuid,
  service_a_id uuid,
  service_version_a_id uuid,
  run_a_id uuid
) ON COMMIT DROP;
GRANT ALL ON TABLE fixture TO PUBLIC;

-- Test-harness storage is created by the test administrator. The production
-- outbox dispatcher intentionally has CONNECT but not TEMPORARY database
-- privilege, so it must not create its own temporary objects.
CREATE TEMP TABLE claimed_events (
  id uuid NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  tenant_id uuid,
  topic text NOT NULL,
  ordering_key text NOT NULL,
  payload jsonb NOT NULL,
  schema_version integer NOT NULL,
  claim_token uuid NOT NULL
) ON COMMIT DROP;
GRANT SELECT, INSERT ON TABLE claimed_events TO dhumi_outbox_dispatcher;

-- Create only mock/provider-neutral global configuration. No Bright Data value
-- is present in the test fixture.
WITH evidence AS (
  INSERT INTO app.launch_evidence (
    evidence_code, scope_type, scope_key, state, restricted_reference,
    effective_at, approved_by, approved_at
  ) VALUES (
    'test.mock.adapter', 'adapter', 'mock', 'approved', 'test://mock-evidence',
    clock_timestamp(), 'test', clock_timestamp()
  ) RETURNING id
), definition AS (
  INSERT INTO app.adapter_definitions (code, product_family)
  VALUES ('mock.marketplace', 'marketplace_dataset')
  RETURNING id
), adapter AS (
  INSERT INTO app.adapter_versions (
    adapter_definition_id, semantic_version, code_artifact_digest, state
  )
  SELECT id, '1.0.0-test', decode('01', 'hex'), 'enabled' FROM definition
  RETURNING id
), feature AS (
  INSERT INTO app.feature_flags (
    feature_code, environment, state, launch_evidence_id,
    changed_by, changed_reason
  )
  SELECT 'marketplace_dataset', 'test', 'enabled', evidence.id,
    'test', 'rollback-only database proof'
  FROM evidence
  RETURNING id
), template AS (
  INSERT INTO app.service_templates (slug, product_family, state)
  VALUES ('mock-marketplace-template', 'marketplace_dataset', 'draft')
  RETURNING id
), template_version AS (
  INSERT INTO app.service_template_versions (
    service_template_id, version, public_name, public_description,
    input_schema, configuration_schema, output_schema, presentation_metadata,
    availability_copy, availability_state, adapter_version_id,
    launch_evidence_id, effective_at, published_at
  )
  SELECT template.id, 1, 'Mock Marketplace', 'Test only', '{}'::jsonb,
    '{}'::jsonb, '{}'::jsonb,
    '{"domain_slug":"marketplace-datasets","domain_name":"Marketplace Datasets","category":"datasets","icon_key":"marketplace-datasets","operation_group":"Mock Marketplace","operation_name":"Run","display_priority":200}'::jsonb,
    'Available in test', 'available', adapter.id, evidence.id,
    clock_timestamp(), clock_timestamp()
  FROM template, adapter, evidence
  RETURNING id, service_template_id, adapter_version_id
), credential AS (
  INSERT INTO app.provider_credentials (
    provider_code, environment, vault_secret_reference, permission_label,
    state, activated_at
  ) VALUES (
    'mock', 'test', 'mock://no-secret', 'mock', 'active', clock_timestamp()
  ) RETURNING id
), mapping AS (
  INSERT INTO app.provider_mappings (
    service_template_version_id, adapter_version_id, provider_credential_id,
    environment, operation_code, provider_resource_ciphertext,
    provider_resource_fingerprint, commercial_config_version, config_version,
    launch_evidence_id, state
  )
  SELECT template_version.id, template_version.adapter_version_id, credential.id,
    'test', 'mock.search', decode('00', 'hex'), decode('01', 'hex'),
    'mock-commercial-v1', 'mock-config-v1', evidence.id, 'enabled'
  FROM template_version, credential, evidence
  RETURNING id, service_template_version_id, adapter_version_id
)
INSERT INTO fixture (
  service_template_id, service_template_version_id, adapter_version_id,
  provider_mapping_id, launch_evidence_id, feature_flag_id
)
SELECT template.id, mapping.service_template_version_id, mapping.adapter_version_id,
  mapping.id, evidence.id, feature.id
FROM template, mapping, evidence, feature;

UPDATE app.service_templates
SET state = 'published',
    current_public_version_id = (SELECT service_template_version_id FROM fixture)
WHERE id = (SELECT service_template_id FROM fixture);

SET LOCAL ROLE dhumi_identity;
WITH user_a AS (
  INSERT INTO app.users (email_normalized, password_hash)
  VALUES ('tenant-a@example.test', 'test-hash-a')
  RETURNING id
), tenant_a AS (
  INSERT INTO app.tenants (display_name) VALUES ('Tenant A') RETURNING id
), access_a AS (
  INSERT INTO app.tenant_user_access (tenant_id, user_id)
  SELECT tenant_a.id, user_a.id FROM tenant_a, user_a
), user_b AS (
  INSERT INTO app.users (email_normalized, password_hash)
  VALUES ('tenant-b@example.test', 'test-hash-b')
  RETURNING id
), tenant_b AS (
  INSERT INTO app.tenants (display_name) VALUES ('Tenant B') RETURNING id
), access_b AS (
  INSERT INTO app.tenant_user_access (tenant_id, user_id)
  SELECT tenant_b.id, user_b.id FROM tenant_b, user_b
)
UPDATE fixture
SET
  tenant_a = (SELECT id FROM tenant_a),
  user_a = (SELECT id FROM user_a),
  tenant_b = (SELECT id FROM tenant_b),
  user_b = (SELECT id FROM user_b);
RESET ROLE;

-- Service creation happens under a resolved tenant context.
SET LOCAL ROLE dhumi_admission;
SELECT set_config('app.tenant_id', (SELECT tenant_a::text FROM fixture), true);
WITH service AS (
  INSERT INTO app.services (tenant_id, service_template_id, name)
  SELECT tenant_a, service_template_id, 'Tenant A mock service' FROM fixture
  RETURNING id
), service_version AS (
  INSERT INTO app.service_versions (
    tenant_id, service_id, version, service_template_version_id,
    validated_configuration, schema_hash, created_by_user_id
  )
  SELECT fixture.tenant_a, service.id, 1, fixture.service_template_version_id,
    '{}'::jsonb, decode(repeat('01', 32), 'hex'), fixture.user_a
  FROM fixture, service
  RETURNING id
)
UPDATE fixture
SET
  service_a_id = (SELECT id FROM service),
  service_version_a_id = (SELECT id FROM service_version);
RESET ROLE;

-- RLS must expose Tenant A rows only when the transaction context is Tenant A.
SET LOCAL ROLE dhumi_customer_api;
SELECT set_config('app.tenant_id', (SELECT tenant_a::text FROM fixture), true);
SELECT pg_temp.assert_true(
  (SELECT count(*) FROM app.services) = 1,
  'Tenant A must see its own Service'
);
SELECT set_config('app.tenant_id', (SELECT tenant_b::text FROM fixture), true);
SELECT pg_temp.assert_true(
  (SELECT count(*) FROM app.services) = 0,
  'Tenant B must not see Tenant A Service'
);
SELECT set_config('app.tenant_id', '', true);
SELECT pg_temp.assert_true(
  (SELECT count(*) FROM app.services) = 0,
  'missing tenant context must expose zero Service rows'
);
RESET ROLE;

-- A composite tenant foreign key must reject a Service Version that points to
-- another tenant's Service, even when an application bug bypasses its guard.
SET LOCAL ROLE dhumi_admission;
SELECT set_config('app.tenant_id', (SELECT tenant_b::text FROM fixture), true);
DO $$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    INSERT INTO app.service_versions (
      tenant_id, service_id, version, service_template_version_id,
      validated_configuration, schema_hash, created_by_user_id
    )
    SELECT tenant_b, service_a_id, 2, service_template_version_id,
      '{}'::jsonb, decode(repeat('02', 32), 'hex'), user_b
    FROM fixture;
  EXCEPTION WHEN foreign_key_violation OR check_violation THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'cross-tenant Service Version reference must fail');
END;
$$;
RESET ROLE;

-- The Run stores all execution-version pins. A mismatched mapping is rejected
-- before any worker can claim or send provider work.
SET LOCAL ROLE dhumi_admission;
SELECT set_config('app.tenant_id', (SELECT tenant_a::text FROM fixture), true);
WITH run AS (
  INSERT INTO app.runs (
    tenant_id, service_version_id, service_template_version_id,
    adapter_version_id, provider_mapping_id, commercial_config_version,
    validated_input, template_launch_evidence_id, mapping_launch_evidence_id,
    feature_flag_id, feature_launch_evidence_id
  )
  SELECT tenant_a, service_version_a_id, service_template_version_id,
    adapter_version_id, provider_mapping_id, 'mock-commercial-v1',
    '{}'::jsonb, launch_evidence_id, launch_evidence_id,
    feature_flag_id, launch_evidence_id
  FROM fixture
  RETURNING id
)
UPDATE fixture SET run_a_id = (SELECT id FROM run);

DO $$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    UPDATE app.runs
    SET commercial_config_version = 'wrong-version'
    WHERE id = (SELECT run_a_id FROM fixture);
  EXCEPTION WHEN insufficient_privilege THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'admission role must not update Run status or pins');
END;
$$;
RESET ROLE;

-- Only Job Manager with a live Attempt fence may perform a legal status transition.
SET LOCAL ROLE dhumi_job_manager;
SELECT set_config('app.tenant_id', (SELECT tenant_a::text FROM fixture), true);
DO $$
DECLARE
  claimed record;
BEGIN
  SELECT * INTO claimed
  FROM app.claim_run_attempt(
    (SELECT run_a_id FROM fixture), 'submission', interval '1 minute'
  );
  PERFORM pg_temp.assert_true(
    claimed.disposition = 'claimed'
      AND claimed.attempt_id IS NOT NULL
      AND claimed.fence_token IS NOT NULL,
    'Job Manager must establish a live Attempt fence'
  );
  PERFORM app.transition_run_fenced(
    (SELECT run_a_id FROM fixture), 0, 'SUBMITTED', 'submitted',
    'foundation.submitted.v1', claimed.attempt_id, claimed.fence_token,
    NULL, false, '{"status":"running"}'::jsonb
  );
END;
$$;
SELECT pg_temp.assert_true(
  (SELECT internal_status = 'SUBMITTED' AND public_status = 'running' AND state_version = 1
     FROM app.runs WHERE id = (SELECT run_a_id FROM fixture)),
  'Job Manager must apply the queued to submitted transition'
);
RESET ROLE;

-- Signup is atomic and replay-safe. The same idempotency key and body returns
-- the original local result without creating another Tenant.
SET LOCAL ROLE dhumi_identity;
SELECT pg_temp.assert_true(
  (SELECT NOT replayed FROM app.create_signup(
    'replay@example.test', 'test-hash-replay', 'Replay Workspace',
    '[{"document_type":"terms","document_version":"v1","document_hash_hex":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}]'::jsonb,
    'signup-replay-key', decode('0a', 'hex'), decode('0b', 'hex')
  )),
  'first signup request must create local identity and tenant'
);
SELECT pg_temp.assert_true(
  (SELECT replayed FROM app.create_signup(
    'replay@example.test', 'test-hash-replay', 'Replay Workspace',
    '[{"document_type":"terms","document_version":"v1","document_hash_hex":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}]'::jsonb,
    'signup-replay-key', decode('0a', 'hex'), decode('0b', 'hex')
  )),
  'same signup request must replay without a second tenant'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) FROM app.users WHERE email_normalized = 'replay@example.test') = 1,
  'signup replay must not create a second User'
);
RESET ROLE;

-- An outbox claim is fenced by its token and may be safely acknowledged once.
SET LOCAL ROLE dhumi_outbox_dispatcher;
INSERT INTO claimed_events
  SELECT * FROM app.claim_outbox_events('integration-test', 10);
SELECT pg_temp.assert_true(
  (SELECT count(*) FROM claimed_events) > 0,
  'outbox dispatcher must claim committed events'
);
SELECT pg_temp.assert_true(
  (SELECT bool_and(app.mark_outbox_event_published(id, claim_token)) FROM claimed_events),
  'claimed events must acknowledge with their own claim token'
);
RESET ROLE;

ROLLBACK;
