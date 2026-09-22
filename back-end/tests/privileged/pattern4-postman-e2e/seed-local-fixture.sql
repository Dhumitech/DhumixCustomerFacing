\set ON_ERROR_STOP on

BEGIN;

INSERT INTO app.launch_evidence (
  id, evidence_code, scope_type, scope_key, state, restricted_reference,
  effective_at, approved_by, approved_at
) VALUES
  ('76000000-0000-4000-8000-000000000001', 'pattern4-local-template',
   'template', '76000000-0000-4000-8000-000000000008', 'approved',
   'restricted:pattern4-local-template', clock_timestamp() - interval '1 hour',
   'pattern4-local-fixture', clock_timestamp() - interval '1 hour'),
  ('76000000-0000-4000-8000-000000000002', 'pattern4-local-mapping',
   'mapping', '76000000-0000-4000-8000-00000000000a', 'approved',
   'restricted:pattern4-local-mapping', clock_timestamp() - interval '1 hour',
   'pattern4-local-fixture', clock_timestamp() - interval '1 hour'),
  ('76000000-0000-4000-8000-000000000003', 'pattern4-local-feature',
   'feature', '76000000-0000-4000-8000-000000000004', 'approved',
   'restricted:pattern4-local-feature', clock_timestamp() - interval '1 hour',
   'pattern4-local-fixture', clock_timestamp() - interval '1 hour')
ON CONFLICT (id) DO NOTHING;

INSERT INTO app.feature_flags (
  id, feature_code, environment, state, launch_evidence_id,
  changed_by, changed_reason
) VALUES (
  '76000000-0000-4000-8000-000000000004', 'scraper_library', 'local',
  'enabled', '76000000-0000-4000-8000-000000000003',
  'pattern4-local-fixture', 'Local durable execution verification'
)
ON CONFLICT (feature_code, environment) DO UPDATE
SET state = 'enabled',
    launch_evidence_id = EXCLUDED.launch_evidence_id,
    expires_at = NULL,
    changed_by = EXCLUDED.changed_by,
    changed_reason = EXCLUDED.changed_reason,
    updated_at = clock_timestamp();

INSERT INTO app.adapter_definitions (id, code, product_family)
VALUES (
  '76000000-0000-4000-8000-000000000005',
  'pattern4-controlled-local', 'scraper_library'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO app.adapter_versions (
  id, adapter_definition_id, semantic_version, capability_metadata,
  request_schema, result_schema, error_schema, code_artifact_digest, state
) VALUES (
  '76000000-0000-4000-8000-000000000006',
  '76000000-0000-4000-8000-000000000005', '1.0.0-local',
  '{"execution_mode":"pattern4_controlled"}'::jsonb,
  '{"type":"object","additionalProperties":false}'::jsonb,
  '{"type":"object"}'::jsonb,
  '{"type":"object"}'::jsonb,
  decode(repeat('76', 32), 'hex'), 'enabled'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO app.service_templates (id, slug, product_family, state)
VALUES (
  '76000000-0000-4000-8000-000000000007',
  'pattern4-controlled-local', 'scraper_library', 'draft'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO app.service_template_versions (
  id, service_template_id, version, public_name, public_description,
  input_schema, configuration_schema, output_schema, presentation_metadata,
  availability_copy, availability_state, adapter_version_id,
  launch_evidence_id, effective_at, published_at
) VALUES (
  '76000000-0000-4000-8000-000000000008',
  '76000000-0000-4000-8000-000000000007', 1,
  'Pattern 4 controlled local',
  'Local-only durable execution test. It does not call Bright Data.',
  '{"type":"object","additionalProperties":false}'::jsonb,
  '{"type":"object","additionalProperties":false}'::jsonb,
  '{"type":"object"}'::jsonb,
  '{"domain_slug":"amazon","domain_name":"Amazon","category":"web-data","icon_key":"amazon","operation_group":"Products","operation_name":"Pattern 4 controlled local","display_priority":990}'::jsonb,
  'Local verification only', 'available',
  '76000000-0000-4000-8000-000000000006',
  '76000000-0000-4000-8000-000000000001',
  clock_timestamp() - interval '1 hour',
  clock_timestamp() - interval '1 hour'
)
ON CONFLICT (id) DO NOTHING;

UPDATE app.service_templates
SET state = 'published',
    current_public_version_id = '76000000-0000-4000-8000-000000000008',
    updated_at = clock_timestamp()
WHERE id = '76000000-0000-4000-8000-000000000007';

INSERT INTO app.provider_credentials (
  id, provider_code, environment, vault_secret_reference, permission_label,
  state, activated_at
) VALUES (
  '76000000-0000-4000-8000-000000000009', 'bright_data', 'local',
  'env://pattern4-controlled-no-provider-call', 'local-controlled-only',
  'active', clock_timestamp() - interval '1 hour'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO app.provider_mappings (
  id, service_template_version_id, adapter_version_id, provider_credential_id,
  environment, operation_code, provider_resource_ciphertext,
  provider_resource_fingerprint, output_policy, commercial_config_version,
  config_version, launch_evidence_id, state
) VALUES (
  '76000000-0000-4000-8000-00000000000a',
  '76000000-0000-4000-8000-000000000008',
  '76000000-0000-4000-8000-000000000006',
  '76000000-0000-4000-8000-000000000009', 'local',
  'test.pattern4.controlled_execution',
  convert_to('pattern4-controlled-no-provider-call', 'UTF8'),
  decode(repeat('77', 32), 'hex'),
  '{"result_kind":"normalized"}'::jsonb,
  'pattern4-local-v1', 'pattern4-local-v1',
  '76000000-0000-4000-8000-000000000002', 'enabled'
)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM app.service_templates AS template
    JOIN app.service_template_versions AS version
      ON version.id = template.current_public_version_id
    JOIN app.provider_mappings AS mapping
      ON mapping.service_template_version_id = version.id
     AND mapping.environment = 'local'
     AND mapping.state = 'enabled'
    JOIN app.feature_flags AS feature
      ON feature.feature_code = 'scraper_library'
     AND feature.environment = 'local'
     AND feature.state = 'enabled'
    WHERE template.id = '76000000-0000-4000-8000-000000000007'
      AND template.slug = 'pattern4-controlled-local'
      AND template.state = 'published'
      AND version.availability_state = 'available'
  ) THEN
    RAISE EXCEPTION 'Pattern 4 local Postman fixture failed validation';
  END IF;
END;
$$;

COMMIT;
