-- Privileged, rollback-only proof for Pattern 8A migration 0037.
\set ON_ERROR_STOP on
\pset pager off

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

CREATE TEMP TABLE p8_context (
  tenant_id uuid NOT NULL,
  other_tenant_id uuid NOT NULL,
  normal_run_id uuid NOT NULL,
  normal_attempt_id uuid NOT NULL,
  normal_fence uuid NOT NULL,
  normal_artifact_id uuid NOT NULL,
  reconciliation_run_id uuid NOT NULL,
  source_attempt_id uuid NOT NULL,
  reconciliation_attempt_id uuid NOT NULL,
  reconciliation_fence uuid NOT NULL,
  reconciliation_artifact_id uuid NOT NULL
);
INSERT INTO p8_context VALUES (
  '78000000-0000-4000-8000-000000000001',
  '78000000-0000-4000-8000-000000000002',
  '78000000-0000-4000-8000-000000000003',
  '78000000-0000-4000-8000-000000000004',
  '78000000-0000-4000-8000-000000000005',
  '78000000-0000-4000-8000-000000000006',
  '78000000-0000-4000-8000-000000000007',
  '78000000-0000-4000-8000-000000000008',
  '78000000-0000-4000-8000-000000000009',
  '78000000-0000-4000-8000-00000000000a',
  '78000000-0000-4000-8000-00000000000b'
);
GRANT SELECT ON p8_context TO dhumi_job_manager;

INSERT INTO app.users (id, email_normalized, password_hash) VALUES
  ('78000000-0000-4000-8000-00000000000c', 'pattern8@example.test', '$argon2id$test'),
  ('78000000-0000-4000-8000-00000000000d', 'pattern8-other@example.test', '$argon2id$test');
INSERT INTO app.tenants (id, display_name) VALUES
  ((SELECT tenant_id FROM p8_context), 'Pattern 8 Tenant'),
  ((SELECT other_tenant_id FROM p8_context), 'Pattern 8 Other Tenant');
INSERT INTO app.tenant_user_access (tenant_id, user_id) VALUES
  ((SELECT tenant_id FROM p8_context), '78000000-0000-4000-8000-00000000000c'),
  ((SELECT other_tenant_id FROM p8_context), '78000000-0000-4000-8000-00000000000d');

INSERT INTO app.launch_evidence (
  id, evidence_code, scope_type, scope_key, state, restricted_reference,
  effective_at, approved_by, approved_at
) VALUES
  ('78000000-0000-4000-8000-00000000000e', 'p8-template', 'template', 'p8',
   'approved', 'restricted:p8-template', clock_timestamp() - interval '1 hour',
   'test', clock_timestamp() - interval '1 hour'),
  ('78000000-0000-4000-8000-00000000000f', 'p8-mapping', 'mapping', 'p8',
   'approved', 'restricted:p8-mapping', clock_timestamp() - interval '1 hour',
   'test', clock_timestamp() - interval '1 hour'),
  ('78000000-0000-4000-8000-000000000010', 'p8-feature', 'feature', 'p8',
   'approved', 'restricted:p8-feature', clock_timestamp() - interval '1 hour',
   'test', clock_timestamp() - interval '1 hour');

INSERT INTO app.feature_flags (
  id, feature_code, environment, state, launch_evidence_id, changed_by, changed_reason
) VALUES (
  '78000000-0000-4000-8000-000000000011', 'scraper_library', 'test', 'enabled',
  '78000000-0000-4000-8000-000000000010', 'test', 'rollback-only proof'
);
INSERT INTO app.adapter_definitions (id, code, product_family) VALUES (
  '78000000-0000-4000-8000-000000000012', 'pattern8-usage', 'scraper_library'
);
INSERT INTO app.adapter_versions (
  id, adapter_definition_id, semantic_version, code_artifact_digest, state
) VALUES (
  '78000000-0000-4000-8000-000000000013',
  '78000000-0000-4000-8000-000000000012', '1.0.0-test',
  decode(repeat('81', 32), 'hex'), 'enabled'
);
INSERT INTO app.service_templates (id, slug, product_family, state) VALUES (
  '78000000-0000-4000-8000-000000000014',
  'pattern8-usage', 'scraper_library', 'draft'
);
INSERT INTO app.service_template_versions (
  id, service_template_id, version, public_name, public_description,
  input_schema, configuration_schema, output_schema, presentation_metadata,
  availability_copy, availability_state, adapter_version_id,
  launch_evidence_id, effective_at, published_at
) VALUES (
  '78000000-0000-4000-8000-000000000015',
  '78000000-0000-4000-8000-000000000014', 1,
  'Pattern 8 usage', 'Rollback-only usage proof',
  '{"type":"object","additionalProperties":false}'::jsonb,
  '{"type":"object","additionalProperties":false}'::jsonb,
  '{"type":"array","items":{"type":"object"}}'::jsonb,
  '{"domain_slug":"amazon-com","domain_name":"amazon.com","category":"e-commerce","icon_key":"amazon","operation_group":"Amazon products","operation_name":"Collect by URL","display_priority":100}'::jsonb,
  'Test only', 'available', '78000000-0000-4000-8000-000000000013',
  '78000000-0000-4000-8000-00000000000e',
  clock_timestamp() - interval '1 hour', clock_timestamp() - interval '1 hour'
);
UPDATE app.service_templates
SET state = 'published',
    current_public_version_id = '78000000-0000-4000-8000-000000000015'
WHERE id = '78000000-0000-4000-8000-000000000014';

INSERT INTO app.provider_credentials (
  id, provider_code, environment, vault_secret_reference, permission_label,
  state, activated_at
) VALUES (
  '78000000-0000-4000-8000-000000000016', 'bright_data', 'test',
  'vault://test-only/p8', 'test-only', 'active', clock_timestamp()
);
INSERT INTO app.provider_mappings (
  id, service_template_version_id, adapter_version_id, provider_credential_id,
  environment, operation_code, provider_resource_ciphertext,
  provider_resource_fingerprint, output_policy, commercial_config_version,
  config_version, launch_evidence_id, state
) VALUES (
  '78000000-0000-4000-8000-000000000017',
  '78000000-0000-4000-8000-000000000015',
  '78000000-0000-4000-8000-000000000013',
  '78000000-0000-4000-8000-000000000016', 'test',
  'amazon.products.collect_by_url', convert_to('private-test-only', 'UTF8'),
  decode(repeat('82', 32), 'hex'), '{}'::jsonb, 'test-v1', 'test-v1',
  '78000000-0000-4000-8000-00000000000f', 'enabled'
);
INSERT INTO app.services (
  id, tenant_id, service_template_id, name, state, current_version
) VALUES (
  '78000000-0000-4000-8000-000000000018',
  (SELECT tenant_id FROM p8_context),
  '78000000-0000-4000-8000-000000000014', 'Pattern 8 Service', 'active', 1
);
INSERT INTO app.service_versions (
  id, tenant_id, service_id, version, service_template_version_id,
  validated_configuration, schema_hash, created_by_user_id
) VALUES (
  '78000000-0000-4000-8000-000000000019',
  (SELECT tenant_id FROM p8_context),
  '78000000-0000-4000-8000-000000000018', 1,
  '78000000-0000-4000-8000-000000000015', '{}'::jsonb,
  decode(repeat('83', 32), 'hex'), '78000000-0000-4000-8000-00000000000c'
);

INSERT INTO app.runs (
  id, tenant_id, service_version_id, service_template_version_id,
  adapter_version_id, provider_mapping_id, commercial_config_version,
  validated_input, template_launch_evidence_id, mapping_launch_evidence_id,
  feature_flag_id, feature_launch_evidence_id, public_status,
  internal_status, state_version, retryable, started_at
) VALUES
  ((SELECT normal_run_id FROM p8_context), (SELECT tenant_id FROM p8_context),
   '78000000-0000-4000-8000-000000000019', '78000000-0000-4000-8000-000000000015',
   '78000000-0000-4000-8000-000000000013', '78000000-0000-4000-8000-000000000017',
   'test-v1', '{}'::jsonb, '78000000-0000-4000-8000-00000000000e',
   '78000000-0000-4000-8000-00000000000f', '78000000-0000-4000-8000-000000000011',
   '78000000-0000-4000-8000-000000000010', 'running', 'PROCESSING', 3, false,
   clock_timestamp() - interval '1 minute'),
  ((SELECT reconciliation_run_id FROM p8_context), (SELECT tenant_id FROM p8_context),
   '78000000-0000-4000-8000-000000000019', '78000000-0000-4000-8000-000000000015',
   '78000000-0000-4000-8000-000000000013', '78000000-0000-4000-8000-000000000017',
   'test-v1', '{}'::jsonb, '78000000-0000-4000-8000-00000000000e',
   '78000000-0000-4000-8000-00000000000f', '78000000-0000-4000-8000-000000000011',
   '78000000-0000-4000-8000-000000000010', 'running', 'PROCESSING', 3, false,
   clock_timestamp() - interval '1 minute');

INSERT INTO app.run_attempts (
  id, tenant_id, run_id, attempt_number, kind, state, outcome_class,
  fence_token, worker_lease_expires_at, adapter_version_id,
  provider_mapping_id, provider_credential_id, provider_reference_fingerprint
) VALUES
  ((SELECT normal_attempt_id FROM p8_context), (SELECT tenant_id FROM p8_context),
   (SELECT normal_run_id FROM p8_context), 1, 'submission', 'claimed', NULL,
   (SELECT normal_fence FROM p8_context), clock_timestamp() + interval '2 minutes',
   '78000000-0000-4000-8000-000000000013', '78000000-0000-4000-8000-000000000017',
   '78000000-0000-4000-8000-000000000016', decode(repeat('84', 32), 'hex')),
  ((SELECT source_attempt_id FROM p8_context), (SELECT tenant_id FROM p8_context),
   (SELECT reconciliation_run_id FROM p8_context), 1, 'submission', 'ambiguous',
   'submission_outcome_uncertain', gen_random_uuid(), NULL,
   '78000000-0000-4000-8000-000000000013', '78000000-0000-4000-8000-000000000017',
   '78000000-0000-4000-8000-000000000016', decode(repeat('85', 32), 'hex')),
  ((SELECT reconciliation_attempt_id FROM p8_context), (SELECT tenant_id FROM p8_context),
   (SELECT reconciliation_run_id FROM p8_context), 2, 'reconciliation', 'claimed', NULL,
   (SELECT reconciliation_fence FROM p8_context), clock_timestamp() + interval '2 minutes',
   '78000000-0000-4000-8000-000000000013', '78000000-0000-4000-8000-000000000017',
   '78000000-0000-4000-8000-000000000016', NULL);

INSERT INTO app.run_events (
  tenant_id, run_id, sequence, event_type, source, attempt_id,
  event_idempotency_key, safe_payload
)
SELECT tenant_id, run_id, sequence, event_type, 'job_manager', attempt_id,
       'p8.' || run_id::text || '.' || sequence::text, '{"status":"running"}'::jsonb
FROM (
  SELECT (SELECT tenant_id FROM p8_context) AS tenant_id,
         (SELECT normal_run_id FROM p8_context) AS run_id,
         (SELECT normal_attempt_id FROM p8_context) AS attempt_id,
         sequence, event_type
  FROM (VALUES (1, 'accepted'), (2, 'submitted'), (3, 'result_received'), (4, 'processing')) AS event(sequence, event_type)
  UNION ALL
  SELECT (SELECT tenant_id FROM p8_context),
         (SELECT reconciliation_run_id FROM p8_context),
         (SELECT reconciliation_attempt_id FROM p8_context),
         sequence, event_type
  FROM (VALUES (1, 'accepted'), (2, 'submitted'), (3, 'result_received'), (4, 'processing')) AS event(sequence, event_type)
) AS events;

INSERT INTO app.artifacts (
  id, tenant_id, run_id, attempt_id, kind, artifact_version, object_key,
  content_type, content_encoding, byte_count, checksum, schema_version,
  record_count, state
) VALUES
  ((SELECT normal_artifact_id FROM p8_context), (SELECT tenant_id FROM p8_context),
   (SELECT normal_run_id FROM p8_context), (SELECT normal_attempt_id FROM p8_context),
   'normalized', 1, 'p8/normal/result', 'application/json', NULL, 2,
   decode(repeat('86', 32), 'hex'), 'amazon.product.output.observed-0.1', 0, 'validated'),
  ((SELECT reconciliation_artifact_id FROM p8_context), (SELECT tenant_id FROM p8_context),
   (SELECT reconciliation_run_id FROM p8_context), (SELECT source_attempt_id FROM p8_context),
   'normalized', 1, 'p8/reconciliation/result', 'application/json', NULL, 16,
   decode(repeat('87', 32), 'hex'), 'amazon.product.output.observed-0.1', 3, 'validated');

SET LOCAL ROLE dhumi_job_manager;
SELECT set_config('app.tenant_id', (SELECT other_tenant_id::text FROM p8_context), true);
DO $$
DECLARE rejected boolean := false;
BEGIN
  BEGIN
    PERFORM app.complete_run_execution_with_usage(
      (SELECT normal_run_id FROM p8_context), 3, 'p8.cross-tenant',
      (SELECT normal_attempt_id FROM p8_context), (SELECT normal_fence FROM p8_context),
      'provider_execution_completed', (SELECT normal_artifact_id FROM p8_context),
      'amazon.result_records.observed', 'records', '{"status":"ready"}'::jsonb
    );
  EXCEPTION WHEN check_violation THEN
    rejected := SQLERRM = 'VALIDATED_NORMALIZED_ARTIFACT_REQUIRED';
  END;
  PERFORM pg_temp.assert_true(rejected, 'cross-Tenant Artifact must fail closed');
END;
$$;

SELECT set_config('app.tenant_id', (SELECT tenant_id::text FROM p8_context), true);
DO $$
DECLARE rejected boolean := false;
BEGIN
  BEGIN
    PERFORM app.complete_run_execution_with_usage(
      (SELECT normal_run_id FROM p8_context), 3, 'p8.stale-fence',
      (SELECT normal_attempt_id FROM p8_context), gen_random_uuid(),
      'provider_execution_completed', (SELECT normal_artifact_id FROM p8_context),
      'amazon.result_records.observed', 'records', '{"status":"ready"}'::jsonb
    );
  EXCEPTION WHEN serialization_failure THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'stale fence must roll back completion');
END;
$$;
SELECT pg_temp.assert_true(
  (SELECT internal_status = 'PROCESSING' AND state_version = 3
   FROM app.runs WHERE id = (SELECT normal_run_id FROM p8_context)),
  'failed finalization must leave the Run unchanged'
);

SELECT app.complete_run_execution_with_usage(
  (SELECT normal_run_id FROM p8_context), 3, 'p8.completed',
  (SELECT normal_attempt_id FROM p8_context), (SELECT normal_fence FROM p8_context),
  'provider_execution_completed', (SELECT normal_artifact_id FROM p8_context),
  'amazon.result_records.observed', 'records', '{"status":"ready"}'::jsonb
);
SELECT app.complete_run_reconciliation_with_usage(
  (SELECT reconciliation_run_id FROM p8_context), 3, 'p8.reconciled-completed',
  (SELECT reconciliation_attempt_id FROM p8_context),
  (SELECT reconciliation_fence FROM p8_context),
  (SELECT source_attempt_id FROM p8_context), 'provider_reconciliation_completed',
  (SELECT reconciliation_artifact_id FROM p8_context),
  'amazon.result_records.observed', 'records', '{"status":"ready"}'::jsonb
);
RESET ROLE;

SELECT set_config('app.tenant_id', (SELECT tenant_id::text FROM p8_context), true);
SELECT pg_temp.assert_true(
  app.record_success_usage_observation(
    (SELECT normal_run_id FROM p8_context),
    (SELECT normal_attempt_id FROM p8_context),
    (SELECT normal_artifact_id FROM p8_context),
    'amazon.result_records.observed', 'records'
  ) = (
    SELECT id FROM app.usage_events
    WHERE attempt_id = (SELECT normal_attempt_id FROM p8_context)
      AND meter_code = 'amazon.result_records.observed'
  ),
  'an exact usage replay must reuse the immutable event'
);
DO $$
DECLARE rejected boolean := false;
BEGIN
  BEGIN
    PERFORM app.record_success_usage_observation(
      (SELECT normal_run_id FROM p8_context),
      (SELECT normal_attempt_id FROM p8_context),
      (SELECT normal_artifact_id FROM p8_context),
      'amazon.result_records.observed', 'items'
    );
  EXCEPTION WHEN unique_violation THEN
    rejected := SQLERRM = 'USAGE_FINALIZATION_CONFLICT';
  END;
  PERFORM pg_temp.assert_true(rejected, 'conflicting usage replay must fail closed');
END;
$$;

SELECT pg_temp.assert_true(
  (SELECT internal_status = 'COMPLETED' AND public_status = 'ready' AND state_version = 4
   FROM app.runs WHERE id = (SELECT normal_run_id FROM p8_context))
  AND (SELECT state = 'completed' AND outcome_class = 'provider_execution_completed'
       FROM app.run_attempts WHERE id = (SELECT normal_attempt_id FROM p8_context))
  AND (SELECT count(*) = 1 AND min(quantity) = 0 AND min(unit) = 'records'
       FROM app.usage_events WHERE attempt_id = (SELECT normal_attempt_id FROM p8_context)),
  'normal completion must atomically retain zero usage and finish Run/Attempt'
);
SELECT pg_temp.assert_true(
  (SELECT internal_status = 'COMPLETED' AND public_status = 'ready' AND state_version = 4
   FROM app.runs WHERE id = (SELECT reconciliation_run_id FROM p8_context))
  AND (SELECT state = 'completed' AND outcome_class = 'reconciled_from_durable_result'
       FROM app.run_attempts WHERE id = (SELECT source_attempt_id FROM p8_context))
  AND (SELECT state = 'completed' AND outcome_class = 'provider_reconciliation_completed'
       FROM app.run_attempts WHERE id = (SELECT reconciliation_attempt_id FROM p8_context))
  AND (SELECT count(*) = 1 AND min(quantity) = 3
       FROM app.usage_events WHERE attempt_id = (SELECT source_attempt_id FROM p8_context))
  AND NOT EXISTS (
    SELECT 1 FROM app.usage_events
    WHERE attempt_id = (SELECT reconciliation_attempt_id FROM p8_context)
  ),
  'reconciliation must attribute usage to the original submission Attempt'
);
SELECT pg_temp.assert_true(
  NOT has_function_privilege(
    'dhumi_customer_api',
    'app.complete_run_execution_with_usage(uuid,bigint,text,uuid,uuid,text,uuid,text,text,jsonb)',
    'EXECUTE'
  )
  AND has_function_privilege(
    'dhumi_job_manager',
    'app.complete_run_execution_with_usage(uuid,bigint,text,uuid,uuid,text,uuid,text,text,jsonb)',
    'EXECUTE'
  ),
  'only the existing Job Manager capability may finalize execution usage'
);

ROLLBACK;
