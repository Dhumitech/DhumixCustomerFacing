-- Privileged, rollback-only proof for Pattern 8B migration 0038.
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

INSERT INTO app.users (id, email_normalized, password_hash) VALUES
  ('7b000000-0000-4000-8000-000000000001', 'pattern8b@example.test', '$argon2id$test'),
  ('7b000000-0000-4000-8000-000000000002', 'pattern8b-other@example.test', '$argon2id$test');
INSERT INTO app.tenants (id, display_name) VALUES
  ('7b000000-0000-4000-8000-000000000003', 'Pattern 8B Tenant'),
  ('7b000000-0000-4000-8000-000000000004', 'Pattern 8B Other Tenant');
INSERT INTO app.tenant_user_access (tenant_id, user_id) VALUES
  ('7b000000-0000-4000-8000-000000000003', '7b000000-0000-4000-8000-000000000001'),
  ('7b000000-0000-4000-8000-000000000004', '7b000000-0000-4000-8000-000000000002');

INSERT INTO app.launch_evidence (
  id, evidence_code, scope_type, scope_key, state, restricted_reference,
  effective_at, approved_by, approved_at
) VALUES
  ('7b000000-0000-4000-8000-000000000005', 'p8b-template', 'template', 'p8b',
   'approved', 'restricted:p8b-template', clock_timestamp() - interval '1 hour',
   'test', clock_timestamp() - interval '1 hour'),
  ('7b000000-0000-4000-8000-000000000006', 'p8b-mapping', 'mapping', 'p8b',
   'approved', 'restricted:p8b-mapping', clock_timestamp() - interval '1 hour',
   'test', clock_timestamp() - interval '1 hour'),
  ('7b000000-0000-4000-8000-000000000007', 'p8b-feature', 'feature', 'p8b',
   'approved', 'restricted:p8b-feature', clock_timestamp() - interval '1 hour',
   'test', clock_timestamp() - interval '1 hour');

INSERT INTO app.feature_flags (
  id, feature_code, environment, state, launch_evidence_id, changed_by, changed_reason
) VALUES (
  '7b000000-0000-4000-8000-000000000008', 'scraper_library', 'test', 'enabled',
  '7b000000-0000-4000-8000-000000000007', 'test', 'rollback-only proof'
);
INSERT INTO app.adapter_definitions (id, code, product_family) VALUES (
  '7b000000-0000-4000-8000-000000000009', 'pattern8b-usage', 'scraper_library'
);
INSERT INTO app.adapter_versions (
  id, adapter_definition_id, semantic_version, code_artifact_digest, state
) VALUES (
  '7b000000-0000-4000-8000-00000000000a',
  '7b000000-0000-4000-8000-000000000009', '1.0.0-test',
  decode(repeat('91', 32), 'hex'), 'enabled'
);
INSERT INTO app.service_templates (id, slug, product_family, state) VALUES (
  '7b000000-0000-4000-8000-00000000000b',
  'pattern8b-usage', 'scraper_library', 'draft'
);
INSERT INTO app.service_template_versions (
  id, service_template_id, version, public_name, public_description,
  input_schema, configuration_schema, output_schema, presentation_metadata,
  availability_copy, availability_state, adapter_version_id,
  launch_evidence_id, effective_at, published_at
) VALUES (
  '7b000000-0000-4000-8000-00000000000c',
  '7b000000-0000-4000-8000-00000000000b', 1,
  'Pattern 8B usage', 'Rollback-only usage-read proof',
  '{"type":"object","additionalProperties":false}'::jsonb,
  '{"type":"object","additionalProperties":false}'::jsonb,
  '{"type":"array","items":{"type":"object"}}'::jsonb,
  '{"domain_slug":"amazon-com","domain_name":"amazon.com","category":"e-commerce","icon_key":"amazon","operation_group":"Amazon products","operation_name":"Collect by URL","display_priority":100}'::jsonb,
  'Test only', 'available', '7b000000-0000-4000-8000-00000000000a',
  '7b000000-0000-4000-8000-000000000005',
  clock_timestamp() - interval '1 hour', clock_timestamp() - interval '1 hour'
);
UPDATE app.service_templates
SET state = 'published',
    current_public_version_id = '7b000000-0000-4000-8000-00000000000c'
WHERE id = '7b000000-0000-4000-8000-00000000000b';

INSERT INTO app.provider_credentials (
  id, provider_code, environment, vault_secret_reference, permission_label,
  state, activated_at
) VALUES (
  '7b000000-0000-4000-8000-00000000000d', 'bright_data', 'test',
  'vault://test-only/p8b', 'test-only', 'active', clock_timestamp()
);
INSERT INTO app.provider_mappings (
  id, service_template_version_id, adapter_version_id, provider_credential_id,
  environment, operation_code, provider_resource_ciphertext,
  provider_resource_fingerprint, output_policy, commercial_config_version,
  config_version, launch_evidence_id, state
) VALUES (
  '7b000000-0000-4000-8000-00000000000e',
  '7b000000-0000-4000-8000-00000000000c',
  '7b000000-0000-4000-8000-00000000000a',
  '7b000000-0000-4000-8000-00000000000d', 'test',
  'amazon.products.collect_by_url', convert_to('private-test-only', 'UTF8'),
  decode(repeat('92', 32), 'hex'), '{}'::jsonb, 'test-v1', 'test-v1',
  '7b000000-0000-4000-8000-000000000006', 'enabled'
);

INSERT INTO app.services (
  id, tenant_id, service_template_id, name, state, current_version
) VALUES
  ('7b000000-0000-4000-8000-00000000000f',
   '7b000000-0000-4000-8000-000000000003',
   '7b000000-0000-4000-8000-00000000000b', 'Pattern 8B Service', 'active', 1),
  ('7b000000-0000-4000-8000-000000000010',
   '7b000000-0000-4000-8000-000000000004',
   '7b000000-0000-4000-8000-00000000000b', 'Pattern 8B Other Service', 'active', 1);
INSERT INTO app.service_versions (
  id, tenant_id, service_id, version, service_template_version_id,
  validated_configuration, schema_hash, created_by_user_id
) VALUES
  ('7b000000-0000-4000-8000-000000000011',
   '7b000000-0000-4000-8000-000000000003',
   '7b000000-0000-4000-8000-00000000000f', 1,
   '7b000000-0000-4000-8000-00000000000c', '{}'::jsonb,
   decode(repeat('93', 32), 'hex'), '7b000000-0000-4000-8000-000000000001'),
  ('7b000000-0000-4000-8000-000000000012',
   '7b000000-0000-4000-8000-000000000004',
   '7b000000-0000-4000-8000-000000000010', 1,
   '7b000000-0000-4000-8000-00000000000c', '{}'::jsonb,
   decode(repeat('94', 32), 'hex'), '7b000000-0000-4000-8000-000000000002');

INSERT INTO app.runs (
  id, tenant_id, service_version_id, service_template_version_id,
  adapter_version_id, provider_mapping_id, commercial_config_version,
  validated_input, template_launch_evidence_id, mapping_launch_evidence_id,
  feature_flag_id, feature_launch_evidence_id
) VALUES
  ('7b000000-0000-4000-8000-000000000013',
   '7b000000-0000-4000-8000-000000000003',
   '7b000000-0000-4000-8000-000000000011',
   '7b000000-0000-4000-8000-00000000000c',
   '7b000000-0000-4000-8000-00000000000a',
   '7b000000-0000-4000-8000-00000000000e', 'test-v1', '{}'::jsonb,
   '7b000000-0000-4000-8000-000000000005',
   '7b000000-0000-4000-8000-000000000006',
   '7b000000-0000-4000-8000-000000000008',
   '7b000000-0000-4000-8000-000000000007'),
  ('7b000000-0000-4000-8000-000000000014',
   '7b000000-0000-4000-8000-000000000004',
   '7b000000-0000-4000-8000-000000000012',
   '7b000000-0000-4000-8000-00000000000c',
   '7b000000-0000-4000-8000-00000000000a',
   '7b000000-0000-4000-8000-00000000000e', 'test-v1', '{}'::jsonb,
   '7b000000-0000-4000-8000-000000000005',
   '7b000000-0000-4000-8000-000000000006',
   '7b000000-0000-4000-8000-000000000008',
   '7b000000-0000-4000-8000-000000000007');

INSERT INTO app.usage_events (
  id, tenant_id, run_id, service_template_version_id, adapter_version_id,
  meter_code, quantity, unit, outcome, source, reconciliation_state,
  provider_reference_fingerprint, evidence_reference, observed_at
) VALUES
  ('7b000000-0000-4000-8000-000000000015',
   '7b000000-0000-4000-8000-000000000003',
   '7b000000-0000-4000-8000-000000000013',
   '7b000000-0000-4000-8000-00000000000c',
   '7b000000-0000-4000-8000-00000000000a',
   'amazon.result_records.observed', 93, 'records', 'succeeded', 'artifact',
   'observed', decode(repeat('95', 32), 'hex'), 'artifact:private-one',
   '2026-08-30T08:57:06.123456Z'),
  ('7b000000-0000-4000-8000-000000000016',
   '7b000000-0000-4000-8000-000000000003',
   '7b000000-0000-4000-8000-000000000013',
   '7b000000-0000-4000-8000-00000000000c',
   '7b000000-0000-4000-8000-00000000000a',
   'amazon.result_records.observed', 1, 'records', 'succeeded', 'artifact',
   'observed', decode(repeat('96', 32), 'hex'), 'artifact:private-two',
   '2026-08-30T08:57:06.123456Z'),
  ('7b000000-0000-4000-8000-000000000017',
   '7b000000-0000-4000-8000-000000000003',
   '7b000000-0000-4000-8000-000000000013',
   '7b000000-0000-4000-8000-00000000000c',
   '7b000000-0000-4000-8000-00000000000a',
   'amazon.result_records.observed', 1, 'records', 'succeeded', 'artifact',
   'observed', NULL, 'artifact:private-three',
   '2026-08-30T08:57:06.123455Z'),
  ('7b000000-0000-4000-8000-000000000018',
   '7b000000-0000-4000-8000-000000000003',
   '7b000000-0000-4000-8000-000000000013',
   '7b000000-0000-4000-8000-00000000000c',
   '7b000000-0000-4000-8000-00000000000a',
   'amazon.result_records.observed', 500, 'records', 'succeeded', 'artifact',
   'observed', NULL, 'artifact:excluded-upper-bound',
   '2026-09-01T00:00:00.000000Z'),
  ('7b000000-0000-4000-8000-000000000019',
   '7b000000-0000-4000-8000-000000000004',
   '7b000000-0000-4000-8000-000000000014',
   '7b000000-0000-4000-8000-00000000000c',
   '7b000000-0000-4000-8000-00000000000a',
   'amazon.result_records.observed', 999, 'records', 'succeeded', 'artifact',
   'observed', NULL, 'artifact:other-tenant',
   '2026-08-30T08:57:06.123456Z');

SELECT pg_temp.assert_true(
  NOT has_table_privilege('dhumi_customer_api', 'app.usage_events', 'SELECT'),
  'customer capability must not retain direct usage_events SELECT'
);
SELECT pg_temp.assert_true(
  has_function_privilege(
    'dhumi_customer_api',
    'app.get_usage_summary(timestamptz,timestamptz)',
    'EXECUTE'
  )
  AND has_function_privilege(
    'dhumi_customer_api',
    'app.list_usage_events(timestamptz,timestamptz,timestamptz,uuid,integer)',
    'EXECUTE'
  ),
  'customer capability must execute only the usage read functions'
);
SELECT pg_temp.assert_true(
  position('provider' IN pg_get_function_result(
    'app.list_usage_events(timestamptz,timestamptz,timestamptz,uuid,integer)'::regprocedure
  )) = 0
  AND position('evidence' IN pg_get_function_result(
    'app.list_usage_events(timestamptz,timestamptz,timestamptz,uuid,integer)'::regprocedure
  )) = 0,
  'public database result type must omit provider and evidence fields'
);

SET LOCAL ROLE dhumi_customer_api;
SELECT set_config('app.tenant_id', '7b000000-0000-4000-8000-000000000003', true);

SELECT pg_temp.assert_true(
  (SELECT count(*) = 1
          AND min(meter_code) = 'amazon.result_records.observed'
          AND min(quantity) = 95
          AND min(unit) = 'records'
          AND min(reconciliation_state) = 'observed'
   FROM app.get_usage_summary(
     '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z'
   )),
  'summary must aggregate only owned Artifact observations in [from,to)'
);
SELECT pg_temp.assert_true(
  (SELECT array_agg(id ORDER BY observed_at DESC, id DESC) = ARRAY[
     '7b000000-0000-4000-8000-000000000016'::uuid,
     '7b000000-0000-4000-8000-000000000015'::uuid
   ]
   FROM app.list_usage_events(
     '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', NULL, NULL, 2
   )),
  'first page must preserve exact timestamp/id descending order'
);
SELECT pg_temp.assert_true(
  (SELECT array_agg(id ORDER BY observed_at DESC, id DESC) = ARRAY[
     '7b000000-0000-4000-8000-000000000017'::uuid
   ]
   FROM app.list_usage_events(
     '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z',
     '2026-08-30T08:57:06.123456Z',
     '7b000000-0000-4000-8000-000000000015', 2
   )),
  'microsecond keyset cursor must return the next older event without a gap'
);
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM app.list_usage_events(
      '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', NULL, NULL, 101
    ) AS event
    WHERE event.id IN (
      '7b000000-0000-4000-8000-000000000018'::uuid,
      '7b000000-0000-4000-8000-000000000019'::uuid
    )
  ),
  'upper-bound and cross-Tenant events must remain invisible'
);

DO $$
DECLARE denied boolean := false;
BEGIN
  BEGIN
    PERFORM 1 FROM app.usage_events LIMIT 1;
  EXCEPTION WHEN insufficient_privilege THEN
    denied := true;
  END;
  PERFORM pg_temp.assert_true(denied, 'direct table read must be denied');
END;
$$;

SELECT set_config('app.tenant_id', '', true);
DO $$
DECLARE denied boolean := false;
BEGIN
  BEGIN
    PERFORM * FROM app.get_usage_summary(
      '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z'
    );
  EXCEPTION WHEN insufficient_privilege THEN
    denied := SQLERRM = 'TENANT_CONTEXT_REQUIRED';
  END;
  PERFORM pg_temp.assert_true(denied, 'missing Tenant context must fail closed');
END;
$$;

RESET ROLE;
ROLLBACK;
