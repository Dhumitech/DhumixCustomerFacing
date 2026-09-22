-- Privileged, rollback-only proof for Pattern 5 migration 0031.
-- This fixture uses the existing dhumi_job_manager capability. It creates no
-- LOGIN, role, provider charge, permanent row or real provider identifier.
\set ON_ERROR_STOP on

BEGIN;

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

CREATE TEMP TABLE p5_plan (
  mapping_id uuid,
  validated_input jsonb,
  operation_code text,
  provider_resource_ciphertext bytea,
  provider_resource_fingerprint bytea,
  output_policy jsonb,
  mapping_config_version text,
  provider_code text,
  provider_environment text,
  vault_secret_reference text
);
GRANT SELECT, INSERT, DELETE ON p5_plan TO dhumi_job_manager;

CREATE TEMP TABLE p5_reconciliation_plan (
  source_attempt_id uuid,
  mapping_id uuid,
  source_provider_reference_ciphertext bytea,
  source_provider_reference_fingerprint bytea,
  validated_input jsonb,
  operation_code text,
  provider_resource_ciphertext bytea,
  provider_resource_fingerprint bytea,
  output_policy jsonb,
  mapping_config_version text,
  provider_code text,
  provider_environment text,
  vault_secret_reference text
);
GRANT SELECT, INSERT ON p5_reconciliation_plan TO dhumi_job_manager;

INSERT INTO app.users (id, email_normalized, password_hash) VALUES (
  '76000000-0000-4000-8000-000000000015',
  'pattern5@example.test', '$argon2id$pattern5-test-only'
);

INSERT INTO app.tenants (id, display_name) VALUES
  ('76000000-0000-4000-8000-000000000001', 'Pattern 5 Tenant'),
  ('76000000-0000-4000-8000-000000000002', 'Pattern 5 Other Tenant');
INSERT INTO app.tenant_user_access (tenant_id, user_id) VALUES (
  '76000000-0000-4000-8000-000000000001',
  '76000000-0000-4000-8000-000000000015'
);

INSERT INTO app.launch_evidence (
  id, evidence_code, scope_type, scope_key, state, restricted_reference,
  effective_at, approved_by, approved_at
) VALUES
  ('76000000-0000-4000-8000-000000000003', 'p5-template', 'template', 'p5',
   'approved', 'restricted:p5-template', clock_timestamp() - interval '1 hour',
   'test', clock_timestamp() - interval '1 hour'),
  ('76000000-0000-4000-8000-000000000004', 'p5-mapping', 'mapping', 'p5',
   'approved', 'restricted:p5-mapping', clock_timestamp() - interval '1 hour',
   'test', clock_timestamp() - interval '1 hour'),
  ('76000000-0000-4000-8000-000000000005', 'p5-feature', 'feature', 'p5',
   'approved', 'restricted:p5-feature', clock_timestamp() - interval '1 hour',
   'test', clock_timestamp() - interval '1 hour');

INSERT INTO app.feature_flags (
  id, feature_code, environment, state, launch_evidence_id,
  changed_by, changed_reason
) VALUES (
  '76000000-0000-4000-8000-000000000006', 'scraper_library', 'test',
  'enabled', '76000000-0000-4000-8000-000000000005',
  'test', 'rollback-only Pattern 5 proof'
);

INSERT INTO app.adapter_definitions (id, code, product_family) VALUES (
  '76000000-0000-4000-8000-000000000007',
  'pattern5-private-boundary', 'scraper_library'
);
INSERT INTO app.adapter_versions (
  id, adapter_definition_id, semantic_version, code_artifact_digest, state
) VALUES (
  '76000000-0000-4000-8000-000000000008',
  '76000000-0000-4000-8000-000000000007', '1.0.0-test',
  decode(repeat('51', 32), 'hex'), 'enabled'
);

INSERT INTO app.service_templates (id, slug, product_family, state) VALUES (
  '76000000-0000-4000-8000-000000000009',
  'pattern5-private-boundary', 'scraper_library', 'draft'
);
INSERT INTO app.service_template_versions (
  id, service_template_id, version, public_name, public_description,
  input_schema, configuration_schema, output_schema, presentation_metadata,
  availability_copy, availability_state, adapter_version_id,
  launch_evidence_id, effective_at
) VALUES (
  '76000000-0000-4000-8000-00000000000a',
  '76000000-0000-4000-8000-000000000009', 1,
  'Pattern 5 private boundary', 'Rollback-only provider-boundary proof',
  '{"type":"object","required":["input"],"properties":{"input":{"type":"array"}},"additionalProperties":false}'::jsonb,
  '{"type":"object","additionalProperties":false}'::jsonb,
  '{"type":"array"}'::jsonb,
  '{"domain_slug":"amazon","domain_name":"Amazon","category":"web-data","icon_key":"amazon","operation_group":"Products","operation_name":"Private boundary","display_priority":100}'::jsonb,
  'Test only', 'available',
  '76000000-0000-4000-8000-000000000008',
  '76000000-0000-4000-8000-000000000003',
  clock_timestamp() - interval '1 hour'
);

INSERT INTO app.provider_credentials (
  id, provider_code, environment, vault_secret_reference, permission_label,
  state, activated_at
) VALUES (
  '76000000-0000-4000-8000-00000000000b', 'bright_data', 'test',
  'BRIGHTDATA_API_KEY', 'pattern5-test-only', 'active',
  clock_timestamp() - interval '1 hour'
);
INSERT INTO app.provider_mappings (
  id, service_template_version_id, adapter_version_id, provider_credential_id,
  environment, operation_code, provider_resource_ciphertext,
  provider_resource_fingerprint, output_policy, commercial_config_version,
  config_version, launch_evidence_id, state
) VALUES (
  '76000000-0000-4000-8000-00000000000c',
  '76000000-0000-4000-8000-00000000000a',
  '76000000-0000-4000-8000-000000000008',
  '76000000-0000-4000-8000-00000000000b', 'test',
  'amazon.products.collect_by_url', decode(repeat('52', 40), 'hex'),
  decode(repeat('53', 32), 'hex'),
  '{"provider_request":{"mode":"collect","limit_per_input":null},"snapshot":{"enabled":true,"cancel_enabled":true,"multipart_enabled":false,"format":"json"},"normalizer_code":"amazon.product.observed-array","normalizer_version":1,"normalized_schema_version":"amazon.product.output.observed-0.1"}'::jsonb,
  'test-v1', 'test-v1',
  '76000000-0000-4000-8000-000000000004', 'enabled'
);

INSERT INTO app.services (
  id, tenant_id, service_template_id, name, state, current_version
) VALUES (
  '76000000-0000-4000-8000-00000000000d',
  '76000000-0000-4000-8000-000000000001',
  '76000000-0000-4000-8000-000000000009',
  'Pattern 5 Service', 'active', 1
);
INSERT INTO app.service_versions (
  id, tenant_id, service_id, version, service_template_version_id,
  validated_configuration, schema_hash, created_by_user_id
) VALUES (
  '76000000-0000-4000-8000-00000000000e',
  '76000000-0000-4000-8000-000000000001',
  '76000000-0000-4000-8000-00000000000d', 1,
  '76000000-0000-4000-8000-00000000000a', '{}'::jsonb,
  decode(repeat('54', 32), 'hex'),
  '76000000-0000-4000-8000-000000000015'
);

INSERT INTO app.runs (
  id, tenant_id, service_version_id, service_template_version_id,
  adapter_version_id, provider_mapping_id, commercial_config_version,
  validated_input, template_launch_evidence_id, mapping_launch_evidence_id,
  feature_flag_id, feature_launch_evidence_id, public_status,
  internal_status, state_version, retryable, started_at
) VALUES (
  '76000000-0000-4000-8000-00000000000f',
  '76000000-0000-4000-8000-000000000001',
  '76000000-0000-4000-8000-00000000000e',
  '76000000-0000-4000-8000-00000000000a',
  '76000000-0000-4000-8000-000000000008',
  '76000000-0000-4000-8000-00000000000c', 'test-v1',
  '{"targets":[{"url":"https://www.amazon.com/dp/B000000000"}]}'::jsonb,
  '76000000-0000-4000-8000-000000000003',
  '76000000-0000-4000-8000-000000000004',
  '76000000-0000-4000-8000-000000000006',
  '76000000-0000-4000-8000-000000000005',
  'running', 'SUBMITTED', 2, false, clock_timestamp()
);
INSERT INTO app.run_attempts (
  id, tenant_id, run_id, attempt_number, kind, state, fence_token,
  worker_lease_expires_at, adapter_version_id, provider_mapping_id,
  provider_credential_id
) VALUES (
  '76000000-0000-4000-8000-000000000010',
  '76000000-0000-4000-8000-000000000001',
  '76000000-0000-4000-8000-00000000000f', 1, 'submission', 'claimed',
  '76000000-0000-4000-8000-000000000011',
  clock_timestamp() + interval '15 minutes',
  '76000000-0000-4000-8000-000000000008',
  '76000000-0000-4000-8000-00000000000c',
  '76000000-0000-4000-8000-00000000000b'
);

SELECT pg_temp.assert_true(
  has_function_privilege(
    'dhumi_job_manager',
    'app.resolve_provider_execution_plan(uuid,uuid,uuid)', 'EXECUTE'
  )
  AND has_function_privilege(
    'dhumi_job_manager',
    'app.record_provider_reference_fenced(uuid,uuid,uuid,bytea,bytea)',
    'EXECUTE'
  )
  AND NOT has_table_privilege(
    'dhumi_job_manager', 'app.provider_credentials', 'SELECT'
  ),
  'existing Job Manager must have narrow function access without credential-table SELECT'
);

SET LOCAL ROLE dhumi_job_manager;
SELECT set_config(
  'app.tenant_id', '76000000-0000-4000-8000-000000000001', true
);

DO $$
BEGIN
  BEGIN
    PERFORM 1 FROM app.provider_credentials LIMIT 1;
    RAISE EXCEPTION 'direct provider credential SELECT unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;

INSERT INTO p5_plan
SELECT *
FROM app.resolve_provider_execution_plan(
  '76000000-0000-4000-8000-00000000000f',
  '76000000-0000-4000-8000-000000000010',
  '76000000-0000-4000-8000-000000000011'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) FROM p5_plan) = 1
  AND (SELECT operation_code FROM p5_plan) = 'amazon.products.collect_by_url'
  AND (SELECT provider_code FROM p5_plan) = 'bright_data'
  AND (SELECT vault_secret_reference FROM p5_plan) = 'BRIGHTDATA_API_KEY',
  'live fenced submission must resolve exactly its pinned private plan'
);

DO $$
BEGIN
  BEGIN
    PERFORM * FROM app.resolve_provider_execution_plan(
      '76000000-0000-4000-8000-00000000000f',
      '76000000-0000-4000-8000-000000000010',
      '76000000-0000-4000-8000-000000000099'
    );
    RAISE EXCEPTION 'stale fence unexpectedly resolved a provider plan';
  EXCEPTION
    WHEN SQLSTATE 'P0002' THEN NULL;
  END;
END;
$$;

SELECT set_config(
  'app.tenant_id', '76000000-0000-4000-8000-000000000002', true
);
DO $$
BEGIN
  BEGIN
    PERFORM * FROM app.resolve_provider_execution_plan(
      '76000000-0000-4000-8000-00000000000f',
      '76000000-0000-4000-8000-000000000010',
      '76000000-0000-4000-8000-000000000011'
    );
    RAISE EXCEPTION 'cross-Tenant provider plan unexpectedly resolved';
  EXCEPTION
    WHEN SQLSTATE 'P0002' THEN NULL;
  END;
END;
$$;
SELECT set_config(
  'app.tenant_id', '76000000-0000-4000-8000-000000000001', true
);

SELECT pg_temp.assert_true(
  app.record_provider_reference_fenced(
    '76000000-0000-4000-8000-00000000000f',
    '76000000-0000-4000-8000-000000000010',
    '76000000-0000-4000-8000-000000000011',
    decode(repeat('55', 40), 'hex'), decode(repeat('56', 32), 'hex')
  ),
  'first protected snapshot reference must be recorded'
);
SELECT pg_temp.assert_true(
  app.record_provider_reference_fenced(
    '76000000-0000-4000-8000-00000000000f',
    '76000000-0000-4000-8000-000000000010',
    '76000000-0000-4000-8000-000000000011',
    decode(repeat('55', 40), 'hex'), decode(repeat('56', 32), 'hex')
  ),
  'same protected snapshot reference must be idempotent'
);
DO $$
BEGIN
  BEGIN
    PERFORM app.record_provider_reference_fenced(
      '76000000-0000-4000-8000-00000000000f',
      '76000000-0000-4000-8000-000000000010',
      '76000000-0000-4000-8000-000000000011',
      decode(repeat('57', 40), 'hex'), decode(repeat('58', 32), 'hex')
    );
    RAISE EXCEPTION 'conflicting provider reference unexpectedly replaced the first';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;
END;
$$;
RESET ROLE;

SELECT pg_temp.assert_true(
  (SELECT provider_reference_fingerprint = decode(repeat('56', 32), 'hex')
   FROM app.run_attempts
   WHERE id = '76000000-0000-4000-8000-000000000010'),
  'only the first snapshot-reference fingerprint must remain stored'
);

UPDATE app.run_attempts
SET state = 'ambiguous', outcome_class = 'provider_submission_uncertain',
    worker_lease_expires_at = NULL, finished_at = clock_timestamp()
WHERE id = '76000000-0000-4000-8000-000000000010';
INSERT INTO app.run_attempts (
  id, tenant_id, run_id, attempt_number, kind, state, fence_token,
  worker_lease_expires_at, adapter_version_id, provider_mapping_id,
  provider_credential_id
) VALUES (
  '76000000-0000-4000-8000-000000000012',
  '76000000-0000-4000-8000-000000000001',
  '76000000-0000-4000-8000-00000000000f', 2, 'reconciliation', 'claimed',
  '76000000-0000-4000-8000-000000000013',
  clock_timestamp() + interval '15 minutes',
  '76000000-0000-4000-8000-000000000008',
  '76000000-0000-4000-8000-00000000000c',
  '76000000-0000-4000-8000-00000000000b'
);

SET LOCAL ROLE dhumi_job_manager;
SELECT set_config(
  'app.tenant_id', '76000000-0000-4000-8000-000000000001', true
);
INSERT INTO p5_reconciliation_plan
SELECT *
FROM app.resolve_provider_reconciliation_plan(
  '76000000-0000-4000-8000-00000000000f',
  '76000000-0000-4000-8000-000000000012',
  '76000000-0000-4000-8000-000000000013'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) FROM p5_reconciliation_plan) = 1
  AND (SELECT source_attempt_id FROM p5_reconciliation_plan) =
      '76000000-0000-4000-8000-000000000010'
  AND (SELECT source_provider_reference_fingerprint
       FROM p5_reconciliation_plan) = decode(repeat('56', 32), 'hex'),
  'reconciliation must recover the protected reference without a second POST'
);

SELECT pg_temp.assert_true(
  NOT app.is_run_cancellation_requested_fenced(
    '76000000-0000-4000-8000-00000000000f',
    '76000000-0000-4000-8000-000000000012',
    '76000000-0000-4000-8000-000000000013'
  ),
  'cancellation must be false before a cancel-request event exists'
);
RESET ROLE;

INSERT INTO app.run_events (
  id, tenant_id, run_id, sequence, event_type, source,
  event_idempotency_key, safe_payload
) VALUES (
  '76000000-0000-4000-8000-000000000014',
  '76000000-0000-4000-8000-000000000001',
  '76000000-0000-4000-8000-00000000000f',
  1, 'cancellation_requested', 'admission',
  'cancel.requested.v1:76000000-0000-4000-8000-000000000014',
  '{"status":"queued"}'::jsonb
);

SET LOCAL ROLE dhumi_job_manager;
SELECT set_config(
  'app.tenant_id', '76000000-0000-4000-8000-000000000001', true
);
SELECT pg_temp.assert_true(
  app.is_run_cancellation_requested_fenced(
    '76000000-0000-4000-8000-00000000000f',
    '76000000-0000-4000-8000-000000000012',
    '76000000-0000-4000-8000-000000000013'
  )
  AND NOT app.is_run_cancellation_requested_fenced(
    '76000000-0000-4000-8000-00000000000f',
    '76000000-0000-4000-8000-000000000012',
    '76000000-0000-4000-8000-000000000099'
  ),
  'cancel intent must be visible only to the live fenced attempt'
);
RESET ROLE;

SET LOCAL ROLE dhumi_owner;
SELECT set_config('app.run_transition_writer', 'on', true);
UPDATE app.runs
SET internal_status = 'PROCESSING', public_status = 'running', state_version = 4
WHERE id = '76000000-0000-4000-8000-00000000000f';
SELECT set_config('app.run_transition_writer', 'off', true);
RESET ROLE;

INSERT INTO app.artifacts (
  id, tenant_id, run_id, attempt_id, kind, artifact_version, object_key,
  content_type, byte_count, checksum, state
) VALUES (
  '76000000-0000-4000-8000-000000000016',
  '76000000-0000-4000-8000-000000000001',
  '76000000-0000-4000-8000-00000000000f',
  '76000000-0000-4000-8000-000000000010',
  'raw', 1,
  'tenants/76000000-0000-4000-8000-000000000001/runs/76000000-0000-4000-8000-00000000000f/attempts/76000000-0000-4000-8000-000000000010/raw/v1/result',
  'application/json', 2, decode(repeat('59', 32), 'hex'), 'durable'
);

SET LOCAL ROLE dhumi_job_manager;
SELECT set_config(
  'app.tenant_id', '76000000-0000-4000-8000-000000000001', true
);
SELECT pg_temp.assert_true(
  has_function_privilege(
    'dhumi_job_manager',
    'app.resolve_provider_normalization_plan(uuid,uuid,uuid,uuid)',
    'EXECUTE'
  ),
  'existing Job Manager must execute only the fenced normalization resolver'
);
SELECT pg_temp.assert_true(
  (
    SELECT operation_code = 'amazon.products.collect_by_url'
      AND output_policy ->> 'normalizer_code' = 'amazon.product.observed-array'
    FROM app.resolve_provider_normalization_plan(
      '76000000-0000-4000-8000-00000000000f',
      '76000000-0000-4000-8000-000000000012',
      '76000000-0000-4000-8000-000000000013',
      '76000000-0000-4000-8000-000000000010'
    )
  ),
  'PROCESSING must resolve the exact pinned operation and output policy'
);
DO $$
BEGIN
  BEGIN
    PERFORM * FROM app.resolve_provider_normalization_plan(
      '76000000-0000-4000-8000-00000000000f',
      '76000000-0000-4000-8000-000000000012',
      '76000000-0000-4000-8000-000000000099',
      '76000000-0000-4000-8000-000000000010'
    );
    RAISE EXCEPTION 'stale normalization fence unexpectedly resolved a plan';
  EXCEPTION
    WHEN SQLSTATE 'P0002' THEN NULL;
  END;
END;
$$;
RESET ROLE;

ROLLBACK;
