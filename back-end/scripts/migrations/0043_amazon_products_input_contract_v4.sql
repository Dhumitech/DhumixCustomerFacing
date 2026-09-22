-- Publish the strict Amazon products Collect-by-URL input contract as an
-- immutable v4 Template. The function clones only the already-approved v3
-- release mapping and its authenticated-encryption lineage. It performs no
-- provider call, creates no identity and never mutates an existing version or
-- a Tenant-owned Service pin.

SET ROLE dhumi_owner;

-- Migration 0041 admits release v2/v3 records through FORCE RLS. This policy
-- adds only the corresponding v4 read surface for the same NOLOGIN definer.
CREATE POLICY service_template_versions_amazon_input_v4_definer_select
  ON app.service_template_versions
  FOR SELECT
  TO dhumi_owner
  USING (
    version = 4
    AND EXISTS (
      SELECT 1
      FROM app.launch_evidence AS evidence
      WHERE evidence.id = launch_evidence_id
        AND evidence.scope_type = 'service_template_version'
        AND evidence.scope_key = 'amazon.products.collect_by_url:4'
    )
  );

CREATE POLICY service_template_versions_amazon_input_v4_definer_insert
  ON app.service_template_versions
  FOR INSERT
  TO dhumi_owner
  WITH CHECK (
    version = 4
    AND availability_state = 'available'
    AND effective_at IS NOT NULL
    AND published_at IS NOT NULL
    AND input_schema #>> '{properties,targets,minItems}' = '1'
    AND input_schema #>> '{properties,targets,maxItems}' = '20'
    AND input_schema #>> '{properties,targets,items,properties,zipcode,pattern}' =
      '^[0-9]{5}$'
    AND input_schema #> '{properties,targets,items,properties,language,enum}' =
      '["EN"]'::jsonb
    AND EXISTS (
      SELECT 1
      FROM app.launch_evidence AS evidence
      WHERE evidence.id = launch_evidence_id
        AND evidence.scope_type = 'service_template_version'
        AND evidence.scope_key = 'amazon.products.collect_by_url:4'
        AND evidence.state = 'approved'
        AND evidence.effective_at IS NOT NULL
        AND evidence.effective_at <= clock_timestamp()
        AND (evidence.expires_at IS NULL OR evidence.expires_at > clock_timestamp())
    )
    AND EXISTS (
      SELECT 1
      FROM app.adapter_versions AS adapter
      JOIN app.adapter_definitions AS definition
        ON definition.id = adapter.adapter_definition_id
      WHERE adapter.id = adapter_version_id
        AND definition.code = 'bright_data.amazon.scraper_library'
        AND adapter.state = 'enabled'
    )
  );

CREATE POLICY audit_events_amazon_input_v4_definer_insert
  ON app.audit_events
  FOR INSERT
  TO dhumi_owner
  WITH CHECK (
    tenant_id IS NULL
    AND actor_user_id IS NULL
    AND actor_api_key_id IS NULL
    AND request_id IS NULL
    AND ip_fingerprint IS NULL
    AND action = 'provider.operation.input_contract.publish'
    AND target_type = 'service_template_version'
    AND target_id IS NOT NULL
  );

CREATE FUNCTION app.publish_amazon_products_input_contract_v4(
  p_expected_environment text,
  p_restricted_reference text,
  p_evidence_hash bytea,
  p_reviewer text,
  p_reason text,
  p_expires_at timestamptz DEFAULT NULL
)
RETURNS TABLE (
  operation_code text,
  template_slug text,
  template_version integer,
  environment text,
  release_outcome text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
  current_template app.service_templates%ROWTYPE;
  source_version app.service_template_versions%ROWTYPE;
  source_mapping app.provider_mappings%ROWTYPE;
  source_mapping_evidence app.launch_evidence%ROWTYPE;
  source_template_evidence app.launch_evidence%ROWTYPE;
  source_adapter app.adapter_versions%ROWTYPE;
  source_credential app.provider_credentials%ROWTYPE;
  release_template_evidence_id uuid;
  release_template_version_id uuid;
  release_mapping_evidence_id uuid;
  release_mapping_id uuid;
  strict_input_schema jsonb := '{
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "urn:dhumi:schema:amazon:products:collect-by-url:input:v2",
    "type": "object",
    "additionalProperties": false,
    "required": ["targets"],
    "properties": {
      "targets": {
        "type": "array",
        "minItems": 1,
        "maxItems": 20,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["url"],
          "properties": {
            "url": {"type": "string", "format": "uri"},
            "zipcode": {
              "type": "string",
              "pattern": "^[0-9]{5}$"
            },
            "language": {"type": "string", "enum": ["EN"]},
            "all_variations": {"type": "boolean"}
          }
        }
      }
    }
  }'::jsonb;
  release_version_number constant integer := 4;
  released_at timestamptz := clock_timestamp();
  replayed boolean := false;
BEGIN
  IF p_expected_environment NOT IN ('local', 'test')
     OR length(p_restricted_reference) NOT BETWEEN 8 AND 1024
     OR p_evidence_hash IS NULL OR octet_length(p_evidence_hash) <> 32
     OR p_reviewer !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$'
     OR p_reason !~ '^[a-z0-9][a-z0-9_.:-]{2,127}$'
     OR (p_expires_at IS NOT NULL AND p_expires_at <= released_at) THEN
    RAISE EXCEPTION 'AMAZON_INPUT_V4_RELEASE_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT template.*
  INTO current_template
  FROM app.service_templates AS template
  WHERE template.product_family = 'scraper_library'
    AND template.slug = 'amazon-products-collect-by-url'
  FOR UPDATE;

  IF NOT FOUND OR current_template.state <> 'published' THEN
    RAISE EXCEPTION 'AMAZON_INPUT_V4_TEMPLATE_NOT_PUBLISHED' USING ERRCODE = '55000';
  END IF;

  SELECT version.*
  INTO source_version
  FROM app.service_template_versions AS version
  WHERE version.service_template_id = current_template.id
    AND version.version = 3;

  IF NOT FOUND
     OR source_version.availability_state <> 'available'
     OR source_version.effective_at IS NULL
     OR source_version.effective_at > released_at
     OR source_version.published_at IS NULL
     OR source_version.published_at > released_at THEN
    RAISE EXCEPTION 'AMAZON_INPUT_V4_SOURCE_TEMPLATE_INVALID' USING ERRCODE = '55000';
  END IF;

  SELECT evidence.*
  INTO source_template_evidence
  FROM app.launch_evidence AS evidence
  WHERE evidence.id = source_version.launch_evidence_id;

  IF NOT FOUND
     OR source_template_evidence.state <> 'approved'
     OR source_template_evidence.effective_at IS NULL
     OR source_template_evidence.effective_at > released_at
     OR (source_template_evidence.expires_at IS NOT NULL
         AND source_template_evidence.expires_at <= released_at) THEN
    RAISE EXCEPTION 'AMAZON_INPUT_V4_SOURCE_EVIDENCE_INVALID' USING ERRCODE = '55000';
  END IF;

  SELECT mapping.*
  INTO source_mapping
  FROM app.provider_mappings AS mapping
  WHERE mapping.service_template_version_id = source_version.id
    AND mapping.environment = p_expected_environment
    AND mapping.operation_code = 'amazon.products.collect_by_url'
    AND mapping.state = 'enabled';

  IF NOT FOUND OR source_mapping.provider_resource_aad_mapping_id IS NULL THEN
    RAISE EXCEPTION 'AMAZON_INPUT_V4_SOURCE_MAPPING_INVALID' USING ERRCODE = '55000';
  END IF;

  SELECT evidence.*
  INTO source_mapping_evidence
  FROM app.launch_evidence AS evidence
  WHERE evidence.id = source_mapping.launch_evidence_id;

  IF NOT FOUND
     OR source_mapping_evidence.state <> 'approved'
     OR source_mapping_evidence.effective_at IS NULL
     OR source_mapping_evidence.effective_at > released_at
     OR (source_mapping_evidence.expires_at IS NOT NULL
         AND source_mapping_evidence.expires_at <= released_at) THEN
    RAISE EXCEPTION 'AMAZON_INPUT_V4_SOURCE_MAPPING_EVIDENCE_INVALID'
      USING ERRCODE = '55000';
  END IF;

  SELECT adapter.*
  INTO source_adapter
  FROM app.adapter_versions AS adapter
  JOIN app.adapter_definitions AS definition
    ON definition.id = adapter.adapter_definition_id
  WHERE adapter.id = source_version.adapter_version_id
    AND adapter.id = source_mapping.adapter_version_id
    AND definition.code = 'bright_data.amazon.scraper_library'
    AND adapter.state = 'enabled';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'AMAZON_INPUT_V4_SOURCE_ADAPTER_INVALID' USING ERRCODE = '55000';
  END IF;

  SELECT credential.*
  INTO source_credential
  FROM app.provider_credentials AS credential
  JOIN app.launch_evidence AS evidence
    ON evidence.id = credential.launch_evidence_id
  WHERE credential.id = source_mapping.provider_credential_id
    AND credential.provider_code = 'bright_data'
    AND credential.environment = p_expected_environment
    AND credential.state = 'active'
    AND credential.activated_at IS NOT NULL
    AND credential.retired_at IS NULL
    AND (credential.expires_at IS NULL OR credential.expires_at > released_at)
    AND evidence.state = 'approved'
    AND evidence.effective_at IS NOT NULL
    AND evidence.effective_at <= released_at
    AND (evidence.expires_at IS NULL OR evidence.expires_at > released_at);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'AMAZON_INPUT_V4_SOURCE_CREDENTIAL_INVALID' USING ERRCODE = '55000';
  END IF;

  INSERT INTO app.launch_evidence (
    evidence_code, scope_type, scope_key, state, restricted_reference,
    evidence_hash, effective_at, expires_at, approved_by, approved_at
  ) VALUES (
    'amazon.template.amazon.products.collect_by_url.v4',
    'service_template_version', 'amazon.products.collect_by_url:4', 'approved',
    p_restricted_reference, p_evidence_hash, released_at, p_expires_at,
    p_reviewer, released_at
  )
  ON CONFLICT (evidence_code, scope_type, scope_key) DO NOTHING;

  SELECT evidence.id
  INTO release_template_evidence_id
  FROM app.launch_evidence AS evidence
  WHERE evidence.evidence_code = 'amazon.template.amazon.products.collect_by_url.v4'
    AND evidence.scope_type = 'service_template_version'
    AND evidence.scope_key = 'amazon.products.collect_by_url:4'
    AND evidence.state = 'approved'
    AND evidence.restricted_reference = p_restricted_reference
    AND evidence.evidence_hash = p_evidence_hash
    AND evidence.approved_by = p_reviewer
    AND evidence.effective_at IS NOT NULL
    AND evidence.effective_at <= released_at
    AND (evidence.expires_at IS NULL OR evidence.expires_at > released_at);

  IF release_template_evidence_id IS NULL THEN
    RAISE EXCEPTION 'AMAZON_INPUT_V4_TEMPLATE_EVIDENCE_CONFLICT'
      USING ERRCODE = '55000';
  END IF;

  SELECT version.id
  INTO release_template_version_id
  FROM app.service_template_versions AS version
  WHERE version.service_template_id = current_template.id
    AND version.version = release_version_number;

  IF release_template_version_id IS NULL THEN
    INSERT INTO app.service_template_versions (
      service_template_id, version, public_name, public_description,
      input_schema, configuration_schema, output_schema, presentation_metadata,
      availability_copy, availability_state, adapter_version_id,
      launch_evidence_id, effective_at, published_at
    ) VALUES (
      current_template.id, release_version_number,
      U&'Amazon products \2014 Collect by URL',
      U&'Amazon products \2014 Collect by URL through Dhumi.',
      strict_input_schema, source_version.configuration_schema,
      source_version.output_schema, source_version.presentation_metadata,
      source_version.availability_copy, 'available', source_adapter.id,
      release_template_evidence_id, released_at, released_at
    )
    RETURNING id INTO release_template_version_id;
  ELSIF NOT EXISTS (
    SELECT 1
    FROM app.service_template_versions AS version
    WHERE version.id = release_template_version_id
      AND version.public_name = U&'Amazon products \2014 Collect by URL'
      AND version.public_description =
        U&'Amazon products \2014 Collect by URL through Dhumi.'
      AND version.input_schema = strict_input_schema
      AND version.configuration_schema = source_version.configuration_schema
      AND version.output_schema = source_version.output_schema
      AND version.presentation_metadata = source_version.presentation_metadata
      AND version.availability_copy = source_version.availability_copy
      AND version.availability_state = 'available'
      AND version.adapter_version_id = source_adapter.id
      AND version.launch_evidence_id = release_template_evidence_id
      AND version.effective_at IS NOT NULL
      AND version.published_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'AMAZON_INPUT_V4_TEMPLATE_VERSION_CONFLICT'
      USING ERRCODE = '55000';
  END IF;

  SELECT mapping.id
  INTO release_mapping_id
  FROM app.provider_mappings AS mapping
  WHERE mapping.service_template_version_id = release_template_version_id
    AND mapping.environment = p_expected_environment
    AND mapping.state = 'enabled';

  IF release_mapping_id IS NULL THEN
    release_mapping_id := gen_random_uuid();
    INSERT INTO app.launch_evidence (
      evidence_code, scope_type, scope_key, state, restricted_reference,
      evidence_hash, effective_at, expires_at, approved_by, approved_at
    ) VALUES (
      'amazon.mapping.amazon.products.collect_by_url.' ||
        p_expected_environment || '.v4.' || release_mapping_id::text,
      'provider_mapping', release_mapping_id::text, 'approved',
      p_restricted_reference, p_evidence_hash, released_at, p_expires_at,
      p_reviewer, released_at
    )
    RETURNING id INTO release_mapping_evidence_id;

    INSERT INTO app.provider_mappings (
      id, service_template_version_id, adapter_version_id,
      provider_credential_id, environment, operation_code,
      provider_resource_ciphertext, provider_resource_fingerprint,
      output_policy, commercial_config_version, config_version,
      launch_evidence_id, state, provider_resource_aad_mapping_id
    ) VALUES (
      release_mapping_id, release_template_version_id, source_adapter.id,
      source_credential.id, p_expected_environment,
      'amazon.products.collect_by_url',
      source_mapping.provider_resource_ciphertext,
      source_mapping.provider_resource_fingerprint,
      source_mapping.output_policy, source_mapping.commercial_config_version,
      source_mapping.config_version, release_mapping_evidence_id, 'enabled',
      source_mapping.provider_resource_aad_mapping_id
    );
  ELSIF NOT EXISTS (
    SELECT 1
    FROM app.provider_mappings AS mapping
    JOIN app.launch_evidence AS evidence ON evidence.id = mapping.launch_evidence_id
    WHERE mapping.id = release_mapping_id
      AND mapping.adapter_version_id = source_adapter.id
      AND mapping.provider_credential_id = source_credential.id
      AND mapping.operation_code = source_mapping.operation_code
      AND mapping.provider_resource_ciphertext = source_mapping.provider_resource_ciphertext
      AND mapping.provider_resource_fingerprint = source_mapping.provider_resource_fingerprint
      AND mapping.output_policy = source_mapping.output_policy
      AND mapping.commercial_config_version = source_mapping.commercial_config_version
      AND mapping.config_version = source_mapping.config_version
      AND mapping.provider_resource_aad_mapping_id =
        source_mapping.provider_resource_aad_mapping_id
      AND evidence.state = 'approved'
      AND evidence.effective_at IS NOT NULL
      AND evidence.effective_at <= released_at
      AND (evidence.expires_at IS NULL OR evidence.expires_at > released_at)
  ) THEN
    RAISE EXCEPTION 'AMAZON_INPUT_V4_MAPPING_CONFLICT' USING ERRCODE = '55000';
  ELSE
    replayed := true;
  END IF;

  IF current_template.current_public_version_id = source_version.id THEN
    UPDATE app.service_templates
    SET current_public_version_id = release_template_version_id,
        updated_at = released_at
    WHERE id = current_template.id;
  ELSIF current_template.current_public_version_id = release_template_version_id THEN
    replayed := true;
  ELSE
    RAISE EXCEPTION 'AMAZON_INPUT_V4_PUBLICATION_CONFLICT' USING ERRCODE = '55000';
  END IF;

  IF NOT replayed THEN
    INSERT INTO app.audit_events (
      action, target_type, target_id, outcome, reason, safe_diff
    ) VALUES (
      'provider.operation.input_contract.publish', 'service_template_version',
      release_template_version_id, 'published', p_reason,
      jsonb_build_object(
        'operation_code', 'amazon.products.collect_by_url',
        'environment', p_expected_environment,
        'template_slug', current_template.slug,
        'from_template_version', 3,
        'to_template_version', release_version_number,
        'reviewer', p_reviewer
      )
    );
  END IF;

  RETURN QUERY SELECT
    'amazon.products.collect_by_url'::text,
    current_template.slug,
    release_version_number,
    p_expected_environment,
    CASE WHEN replayed THEN 'replayed' ELSE 'published' END;
END;
$$;

REVOKE ALL ON FUNCTION app.publish_amazon_products_input_contract_v4(
  text, text, bytea, text, text, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.publish_amazon_products_input_contract_v4(
  text, text, bytea, text, text, timestamptz
) TO dhumi_operator;

RESET ROLE;
