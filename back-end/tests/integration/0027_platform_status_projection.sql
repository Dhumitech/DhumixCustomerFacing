-- Privileged, rollback-only proof for Pattern 8 Priority 3 migration 0039.
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

INSERT INTO app.launch_evidence (
  id, evidence_code, scope_type, scope_key, state, restricted_reference,
  effective_at, approved_by, approved_at
) VALUES
  ('7c000000-0000-4000-8000-000000000001', 'p8c-feature', 'feature', 'p8c-feature',
   'approved', 'restricted:p8c-feature', statement_timestamp() - interval '1 hour',
   'test', statement_timestamp() - interval '1 hour'),
  ('7c000000-0000-4000-8000-000000000002', 'p8c-template-a', 'service_template_version', 'p8c-a:1',
   'approved', 'restricted:p8c-template-a', statement_timestamp() - interval '1 hour',
   'test', statement_timestamp() - interval '1 hour'),
  ('7c000000-0000-4000-8000-000000000003', 'p8c-template-b', 'service_template_version', 'p8c-b:1',
   'approved', 'restricted:p8c-template-b', statement_timestamp() - interval '1 hour',
   'test', statement_timestamp() - interval '1 hour'),
  ('7c000000-0000-4000-8000-000000000004', 'p8c-mapping', 'provider_mapping', 'p8c-mapping',
   'approved', 'restricted:p8c-mapping', statement_timestamp() - interval '1 hour',
   'test', statement_timestamp() - interval '1 hour');

INSERT INTO app.feature_flags (
  id, feature_code, environment, state, launch_evidence_id, changed_by, changed_reason
) VALUES (
  '7c000000-0000-4000-8000-000000000005', 'scraper_library', 'test', 'enabled',
  '7c000000-0000-4000-8000-000000000001', 'test', 'rollback-only status proof'
);

INSERT INTO app.adapter_definitions (id, code, product_family) VALUES (
  '7c000000-0000-4000-8000-000000000006',
  'pattern8-platform-status', 'scraper_library'
);
INSERT INTO app.adapter_versions (
  id, adapter_definition_id, semantic_version, code_artifact_digest, state
) VALUES (
  '7c000000-0000-4000-8000-000000000007',
  '7c000000-0000-4000-8000-000000000006', '1.0.0-test',
  decode(repeat('7c', 32), 'hex'), 'enabled'
);

INSERT INTO app.service_templates (id, slug, product_family, state) VALUES
  ('7c000000-0000-4000-8000-000000000008', 'pattern8-status-operational', 'scraper_library', 'draft'),
  ('7c000000-0000-4000-8000-000000000009', 'pattern8-status-disabled', 'scraper_library', 'draft');

INSERT INTO app.service_template_versions (
  id, service_template_id, version, public_name, public_description,
  input_schema, configuration_schema, output_schema, presentation_metadata,
  availability_copy, availability_state, adapter_version_id,
  launch_evidence_id, effective_at, published_at
) VALUES
  (
    '7c000000-0000-4000-8000-00000000000a',
    '7c000000-0000-4000-8000-000000000008', 1,
    'Pattern 8 status operational', 'Rollback-only status proof',
    '{"type":"object","additionalProperties":false}'::jsonb,
    '{"type":"object","additionalProperties":false}'::jsonb,
    '{"type":"array","items":{"type":"object"}}'::jsonb,
    '{"domain_slug":"status-proof","domain_name":"Status proof","category":"test","icon_key":"status-proof","operation_group":"Status","operation_name":"Operational","display_priority":100}'::jsonb,
    'Available', 'available', '7c000000-0000-4000-8000-000000000007',
    '7c000000-0000-4000-8000-000000000002',
    statement_timestamp() - interval '1 hour', statement_timestamp() - interval '1 hour'
  ),
  (
    '7c000000-0000-4000-8000-00000000000b',
    '7c000000-0000-4000-8000-000000000009', 1,
    'Pattern 8 status disabled', 'Rollback-only status proof',
    '{"type":"object","additionalProperties":false}'::jsonb,
    '{"type":"object","additionalProperties":false}'::jsonb,
    '{"type":"array","items":{"type":"object"}}'::jsonb,
    '{"domain_slug":"status-proof","domain_name":"Status proof","category":"test","icon_key":"status-proof","operation_group":"Status","operation_name":"Disabled","display_priority":110}'::jsonb,
    'Unavailable', 'available', '7c000000-0000-4000-8000-000000000007',
    '7c000000-0000-4000-8000-000000000003',
    statement_timestamp() - interval '1 hour', statement_timestamp() - interval '1 hour'
  );

UPDATE app.service_templates
SET state = 'published',
    current_public_version_id = '7c000000-0000-4000-8000-00000000000a'
WHERE id = '7c000000-0000-4000-8000-000000000008';
UPDATE app.service_templates
SET state = 'disabled',
    current_public_version_id = '7c000000-0000-4000-8000-00000000000b'
WHERE id = '7c000000-0000-4000-8000-000000000009';

INSERT INTO app.provider_credentials (
  id, provider_code, environment, vault_secret_reference, permission_label,
  state, activated_at
) VALUES (
  '7c000000-0000-4000-8000-00000000000c', 'bright_data', 'test',
  'vault://test-only/p8c', 'test-only', 'active', statement_timestamp() - interval '1 hour'
);
INSERT INTO app.provider_mappings (
  id, service_template_version_id, adapter_version_id, provider_credential_id,
  environment, operation_code, provider_resource_ciphertext,
  provider_resource_fingerprint, output_policy, commercial_config_version,
  config_version, launch_evidence_id, state
) VALUES (
  '7c000000-0000-4000-8000-00000000000d',
  '7c000000-0000-4000-8000-00000000000a',
  '7c000000-0000-4000-8000-000000000007',
  '7c000000-0000-4000-8000-00000000000c', 'test',
  'pattern8.status.operational', decode(repeat('8c', 48), 'hex'),
  decode(repeat('9c', 32), 'hex'), '{}'::jsonb, 'test-v1', 'test-v1',
  '7c000000-0000-4000-8000-000000000004', 'enabled'
);

SET LOCAL ROLE dhumi_customer_api;

SELECT pg_temp.assert_true(
  (SELECT array_agg(family ORDER BY CASE family
      WHEN 'scraper_library' THEN 1 ELSE 2 END)
   FROM app.get_platform_status('test'))
    = ARRAY['scraper_library', 'marketplace_dataset']::text[],
  'the global projection must return both accepted product families'
);
SELECT pg_temp.assert_true(
  (SELECT state = 'degraded'
   FROM app.get_platform_status('test')
   WHERE family = 'scraper_library'),
  'one executable and one disabled selected operation must be degraded'
);
SELECT pg_temp.assert_true(
  (SELECT state = 'not_enabled'
   FROM app.get_platform_status('test')
   WHERE family = 'marketplace_dataset'),
  'a missing current feature release must be not_enabled'
);
SELECT pg_temp.assert_true(
  (SELECT COUNT(DISTINCT updated_at) = 1
   FROM app.get_platform_status('test')),
  'both product rows must share one atomic database evaluation time'
);

DO $$
DECLARE denied boolean := false;
BEGIN
  BEGIN
    PERFORM 1 FROM app.provider_mappings LIMIT 1;
  EXCEPTION WHEN insufficient_privilege THEN
    denied := true;
  END;
  PERFORM pg_temp.assert_true(
    denied,
    'direct private table read must be denied'
  );
END;
$$;

RESET ROLE;
UPDATE app.provider_credentials
SET state = 'inactive'
WHERE id = '7c000000-0000-4000-8000-00000000000c';
SET LOCAL ROLE dhumi_customer_api;
SELECT pg_temp.assert_true(
  (SELECT state = 'unavailable'
   FROM app.get_platform_status('test')
   WHERE family = 'scraper_library'),
  'an enabled feature with selected but no executable operations must be unavailable'
);

RESET ROLE;
UPDATE app.feature_flags
SET state = 'disabled'
WHERE id = '7c000000-0000-4000-8000-000000000005';
SET LOCAL ROLE dhumi_customer_api;
SELECT pg_temp.assert_true(
  (SELECT state = 'not_enabled'
   FROM app.get_platform_status('test')
   WHERE family = 'scraper_library'),
  'a disabled feature must override catalogue state as not_enabled'
);

DO $$
DECLARE rejected boolean := false;
BEGIN
  BEGIN
    PERFORM * FROM app.get_platform_status('provider-environment');
  EXCEPTION WHEN invalid_parameter_value THEN
    rejected := SQLERRM = 'PLATFORM_STATUS_ENVIRONMENT_INVALID';
  END;
  PERFORM pg_temp.assert_true(rejected, 'an undeclared environment must fail closed');
END;
$$;

RESET ROLE;
ROLLBACK;
