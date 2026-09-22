-- Backend Release Closure: controlled, operator-only publication of one
-- independently qualified Amazon operation.
--
-- This migration performs no provider call, creates no LOGIN/capability role,
-- and adds no public HTTP route. Immutable qualification records remain
-- unchanged. Publication creates a new immutable release Adapter, Template
-- version and Mapping, then atomically advances only the mutable release gates.

SET ROLE dhumi_owner;

-- The SECURITY DEFINER release function needs narrowly bounded access through
-- the forced-RLS catalogue tables. The non-login owner remains the only role
-- covered by these policies; the runtime operator receives EXECUTE only.
CREATE POLICY service_templates_amazon_release_definer_select
  ON app.service_templates
  FOR SELECT
  TO dhumi_owner
  USING (
    product_family = 'scraper_library'
    AND slug ~ '^amazon-[a-z0-9-]{3,92}$'
  );

CREATE POLICY service_templates_amazon_release_definer_update
  ON app.service_templates
  FOR UPDATE
  TO dhumi_owner
  USING (
    product_family = 'scraper_library'
    AND slug ~ '^amazon-[a-z0-9-]{3,92}$'
    AND state IN ('draft', 'published')
  )
  WITH CHECK (
    product_family = 'scraper_library'
    AND slug ~ '^amazon-[a-z0-9-]{3,92}$'
    AND state = 'published'
    AND current_public_version_id IS NOT NULL
  );

CREATE POLICY service_template_versions_amazon_release_definer_select
  ON app.service_template_versions
  FOR SELECT
  TO dhumi_owner
  USING (
    version IN (2, 3)
    AND EXISTS (
      SELECT 1
      FROM app.launch_evidence AS evidence
      WHERE evidence.id = launch_evidence_id
        AND evidence.scope_type = 'service_template_version'
        AND evidence.scope_key ~ '^amazon\.[a-z0-9_.]{3,120}:[23]$'
    )
  );

CREATE POLICY service_template_versions_amazon_release_definer_insert
  ON app.service_template_versions
  FOR INSERT
  TO dhumi_owner
  WITH CHECK (
    version = 3
    AND availability_state = 'available'
    AND effective_at IS NOT NULL
    AND published_at IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM app.launch_evidence AS evidence
      WHERE evidence.id = launch_evidence_id
        AND evidence.scope_type = 'service_template_version'
        AND evidence.scope_key ~ '^amazon\.[a-z0-9_.]{3,120}:3$'
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
        AND adapter.semantic_version = '1.1.0-pattern8-release'
        AND adapter.state = 'enabled'
    )
  );

CREATE POLICY audit_events_amazon_release_definer_insert
  ON app.audit_events
  FOR INSERT
  TO dhumi_owner
  WITH CHECK (
    tenant_id IS NULL
    AND actor_user_id IS NULL
    AND actor_api_key_id IS NULL
    AND request_id IS NULL
    AND ip_fingerprint IS NULL
    AND action = 'provider.operation.publish'
    AND target_type = 'provider_qualification'
    AND target_id IS NOT NULL
  );

CREATE FUNCTION app.publish_qualified_amazon_operation_v1(
  p_expected_environment text,
  p_qualification_id uuid,
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
  attempt app.provider_qualification_attempts%ROWTYPE;
  accepted_mapping app.provider_mappings%ROWTYPE;
  mapping_evidence app.launch_evidence%ROWTYPE;
  staged_version app.service_template_versions%ROWTYPE;
  staged_adapter app.adapter_versions%ROWTYPE;
  current_template app.service_templates%ROWTYPE;
  credential app.provider_credentials%ROWTYPE;
  release_adapter_id uuid;
  release_template_evidence_id uuid;
  release_template_version_id uuid;
  release_mapping_id uuid;
  release_mapping_evidence_id uuid;
  release_credential_evidence_id uuid;
  release_feature_evidence_id uuid;
  release_feature_id uuid;
  expected_contract jsonb;
  release_version_number constant integer := 3;
  released_at timestamptz := clock_timestamp();
  replayed boolean := false;
BEGIN
  IF p_expected_environment NOT IN ('local', 'test')
     OR p_qualification_id IS NULL
     OR length(p_restricted_reference) NOT BETWEEN 8 AND 1024
     OR p_evidence_hash IS NULL OR octet_length(p_evidence_hash) <> 32
     OR p_reviewer !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$'
     OR p_reason !~ '^[a-z0-9][a-z0-9_.:-]{2,127}$'
     OR (p_expires_at IS NOT NULL AND p_expires_at <= released_at) THEN
    RAISE EXCEPTION 'AMAZON_RELEASE_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT qualification.*
  INTO attempt
  FROM app.provider_qualification_attempts AS qualification
  WHERE qualification.id = p_qualification_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'AMAZON_RELEASE_QUALIFICATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF attempt.environment <> p_expected_environment THEN
    RAISE EXCEPTION 'AMAZON_RELEASE_ENVIRONMENT_MISMATCH' USING ERRCODE = '22023';
  END IF;
  IF attempt.state <> 'succeeded' OR attempt.review_state <> 'approved'
     OR attempt.provider_mapping_id IS NULL
     OR attempt.launch_evidence_id IS NULL THEN
    RAISE EXCEPTION 'AMAZON_RELEASE_NOT_ACCEPTED' USING ERRCODE = '55000';
  END IF;

  SELECT mapping.*
  INTO accepted_mapping
  FROM app.provider_mappings AS mapping
  WHERE mapping.id = attempt.provider_mapping_id;

  IF NOT FOUND
     OR accepted_mapping.state <> 'disabled'
     OR accepted_mapping.service_template_version_id <> attempt.service_template_version_id
     OR accepted_mapping.adapter_version_id <> attempt.adapter_version_id
     OR accepted_mapping.provider_credential_id <> attempt.provider_credential_id
     OR accepted_mapping.environment <> attempt.environment
     OR accepted_mapping.operation_code <> attempt.operation_code
     OR accepted_mapping.launch_evidence_id <> attempt.launch_evidence_id THEN
    RAISE EXCEPTION 'AMAZON_RELEASE_ACCEPTED_MAPPING_INVALID' USING ERRCODE = '55000';
  END IF;

  SELECT evidence.*
  INTO mapping_evidence
  FROM app.launch_evidence AS evidence
  WHERE evidence.id = accepted_mapping.launch_evidence_id;

  IF NOT FOUND
     OR mapping_evidence.state <> 'approved'
     OR mapping_evidence.effective_at IS NULL
     OR mapping_evidence.effective_at > released_at
     OR (mapping_evidence.expires_at IS NOT NULL AND mapping_evidence.expires_at <= released_at) THEN
    RAISE EXCEPTION 'AMAZON_RELEASE_MAPPING_EVIDENCE_INVALID' USING ERRCODE = '55000';
  END IF;

  SELECT version.*
  INTO staged_version
  FROM app.service_template_versions AS version
  WHERE version.id = attempt.service_template_version_id;

  IF NOT FOUND
     OR staged_version.version <> 2
     OR staged_version.adapter_version_id <> attempt.adapter_version_id
     OR staged_version.effective_at IS NOT NULL
     OR staged_version.published_at IS NOT NULL
     OR staged_version.availability_state <> 'coming_soon' THEN
    RAISE EXCEPTION 'AMAZON_RELEASE_STAGED_TEMPLATE_INVALID' USING ERRCODE = '55000';
  END IF;

  SELECT adapter.*
  INTO staged_adapter
  FROM app.adapter_versions AS adapter
  WHERE adapter.id = attempt.adapter_version_id;

  expected_contract := staged_adapter.capability_metadata #> ARRAY[
    'output_contracts', attempt.operation_code
  ];
  IF NOT FOUND
     OR staged_adapter.state <> 'disabled'
     OR expected_contract ->> 'state' IS DISTINCT FROM 'precise'
     OR staged_version.output_schema ->> '$id' IS DISTINCT FROM
       'urn:dhumi:schema:' || (expected_contract ->> 'normalized_schema_version')
     OR accepted_mapping.output_policy ->> 'normalizer_code' IS DISTINCT FROM
       (expected_contract ->> 'normalizer_code')
     OR accepted_mapping.output_policy -> 'normalizer_version' IS DISTINCT FROM
       (expected_contract -> 'normalizer_version')
     OR accepted_mapping.output_policy ->> 'normalized_schema_version' IS DISTINCT FROM
       (expected_contract ->> 'normalized_schema_version') THEN
    RAISE EXCEPTION 'AMAZON_RELEASE_OUTPUT_CONTRACT_INVALID' USING ERRCODE = '55000';
  END IF;

  SELECT template.*
  INTO current_template
  FROM app.service_templates AS template
  WHERE template.id = staged_version.service_template_id
    AND template.product_family = 'scraper_library'
    AND template.slug ~ '^amazon-[a-z0-9-]{3,92}$'
  FOR UPDATE;

  IF NOT FOUND OR current_template.state NOT IN ('draft', 'published') THEN
    RAISE EXCEPTION 'AMAZON_RELEASE_TEMPLATE_INVALID' USING ERRCODE = '55000';
  END IF;

  SELECT provider_credential.*
  INTO credential
  FROM app.provider_credentials AS provider_credential
  WHERE provider_credential.id = attempt.provider_credential_id
    AND provider_credential.provider_code = 'bright_data'
    AND provider_credential.environment = attempt.environment
    AND provider_credential.vault_secret_reference = 'BRIGHTDATA_API_KEY'
    AND provider_credential.state IN ('inactive', 'active')
  FOR UPDATE;

  IF NOT FOUND
     OR credential.retired_at IS NOT NULL
     OR (credential.expires_at IS NOT NULL AND credential.expires_at <= released_at) THEN
    RAISE EXCEPTION 'AMAZON_RELEASE_CREDENTIAL_INVALID' USING ERRCODE = '55000';
  END IF;

  -- Create one immutable enabled release adapter. The qualification adapter
  -- remains disabled and unchanged, so later operations can qualify against it.
  SELECT adapter.id
  INTO release_adapter_id
  FROM app.adapter_versions AS adapter
  WHERE adapter.adapter_definition_id = staged_adapter.adapter_definition_id
    AND adapter.semantic_version = '1.1.0-pattern8-release';

  IF release_adapter_id IS NULL THEN
    INSERT INTO app.adapter_versions (
      adapter_definition_id, semantic_version, capability_metadata,
      request_schema, result_schema, error_schema, code_artifact_digest, state
    ) VALUES (
      staged_adapter.adapter_definition_id, '1.1.0-pattern8-release',
      staged_adapter.capability_metadata, staged_adapter.request_schema,
      staged_adapter.result_schema, staged_adapter.error_schema,
      staged_adapter.code_artifact_digest, 'enabled'
    )
    RETURNING id INTO release_adapter_id;
  ELSIF NOT EXISTS (
    SELECT 1
    FROM app.adapter_versions AS adapter
    WHERE adapter.id = release_adapter_id
      AND adapter.state = 'enabled'
      AND adapter.capability_metadata = staged_adapter.capability_metadata
      AND adapter.request_schema = staged_adapter.request_schema
      AND adapter.result_schema = staged_adapter.result_schema
      AND adapter.error_schema = staged_adapter.error_schema
      AND adapter.code_artifact_digest = staged_adapter.code_artifact_digest
  ) THEN
    RAISE EXCEPTION 'AMAZON_RELEASE_ADAPTER_CONFLICT' USING ERRCODE = '55000';
  END IF;

  IF credential.state = 'inactive' THEN
    INSERT INTO app.launch_evidence (
      evidence_code, scope_type, scope_key, state, restricted_reference,
      evidence_hash, effective_at, expires_at, approved_by, approved_at
    ) VALUES (
      'bright_data.credential.' || attempt.environment || '.release.v1',
      'provider_credential', 'bright_data:' || attempt.environment || ':BRIGHTDATA_API_KEY',
      'approved', p_restricted_reference, p_evidence_hash, released_at,
      p_expires_at, p_reviewer, released_at
    )
    RETURNING id INTO release_credential_evidence_id;

    UPDATE app.provider_credentials
    SET owner_metadata = jsonb_build_object('use', 'job_manager_execution'),
        permission_label = 'scraper_execution', state = 'active',
        launch_evidence_id = release_credential_evidence_id,
        activated_at = released_at, updated_at = released_at
    WHERE id = credential.id;
  ELSIF credential.activated_at IS NULL OR NOT EXISTS (
    SELECT 1 FROM app.launch_evidence AS evidence
    WHERE evidence.id = credential.launch_evidence_id
      AND evidence.state = 'approved'
      AND evidence.effective_at IS NOT NULL
      AND evidence.effective_at <= released_at
      AND (evidence.expires_at IS NULL OR evidence.expires_at > released_at)
  ) THEN
    RAISE EXCEPTION 'AMAZON_RELEASE_ACTIVE_CREDENTIAL_EVIDENCE_INVALID' USING ERRCODE = '55000';
  END IF;

  INSERT INTO app.launch_evidence (
    evidence_code, scope_type, scope_key, state, restricted_reference,
    evidence_hash, effective_at, expires_at, approved_by, approved_at
  ) VALUES (
    'feature.scraper_library.' || attempt.environment || '.release.v1',
    'feature_flag', 'scraper_library:' || attempt.environment,
    'approved', p_restricted_reference, p_evidence_hash, released_at,
    p_expires_at, p_reviewer, released_at
  )
  ON CONFLICT (evidence_code, scope_type, scope_key) DO NOTHING;

  SELECT evidence.id
  INTO release_feature_evidence_id
  FROM app.launch_evidence AS evidence
  WHERE evidence.evidence_code =
      'feature.scraper_library.' || attempt.environment || '.release.v1'
    AND evidence.scope_type = 'feature_flag'
    AND evidence.scope_key = 'scraper_library:' || attempt.environment
    AND evidence.state = 'approved'
    AND evidence.effective_at IS NOT NULL
    AND evidence.effective_at <= released_at
    AND (evidence.expires_at IS NULL OR evidence.expires_at > released_at);

  IF release_feature_evidence_id IS NULL THEN
    RAISE EXCEPTION 'AMAZON_RELEASE_FEATURE_EVIDENCE_CONFLICT' USING ERRCODE = '55000';
  END IF;

  INSERT INTO app.feature_flags (
    feature_code, environment, state, launch_evidence_id, expires_at,
    changed_by, changed_reason
  ) VALUES (
    'scraper_library', attempt.environment, 'enabled', release_feature_evidence_id,
    p_expires_at, p_reviewer, p_reason
  )
  ON CONFLICT ON CONSTRAINT feature_flags_feature_code_environment_key DO UPDATE
  SET state = 'enabled', launch_evidence_id = EXCLUDED.launch_evidence_id,
      expires_at = EXCLUDED.expires_at, changed_by = EXCLUDED.changed_by,
      changed_reason = EXCLUDED.changed_reason, updated_at = released_at
  RETURNING id INTO release_feature_id;

  INSERT INTO app.launch_evidence (
    evidence_code, scope_type, scope_key, state, restricted_reference,
    evidence_hash, effective_at, expires_at, approved_by, approved_at
  ) VALUES (
    'amazon.template.' || attempt.operation_code || '.v3',
    'service_template_version', attempt.operation_code || ':3', 'approved',
    p_restricted_reference, p_evidence_hash, released_at, p_expires_at,
    p_reviewer, released_at
  )
  ON CONFLICT (evidence_code, scope_type, scope_key) DO NOTHING;

  SELECT evidence.id
  INTO release_template_evidence_id
  FROM app.launch_evidence AS evidence
  WHERE evidence.evidence_code = 'amazon.template.' || attempt.operation_code || '.v3'
    AND evidence.scope_type = 'service_template_version'
    AND evidence.scope_key = attempt.operation_code || ':3'
    AND evidence.state = 'approved'
    AND evidence.restricted_reference = p_restricted_reference
    AND evidence.evidence_hash = p_evidence_hash
    AND evidence.approved_by = p_reviewer
    AND evidence.effective_at IS NOT NULL
    AND evidence.effective_at <= released_at
    AND (evidence.expires_at IS NULL OR evidence.expires_at > released_at);

  IF release_template_evidence_id IS NULL THEN
    RAISE EXCEPTION 'AMAZON_RELEASE_TEMPLATE_EVIDENCE_CONFLICT' USING ERRCODE = '55000';
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
      current_template.id, release_version_number, staged_version.public_name,
      staged_version.public_name || ' through Dhumi.', staged_version.input_schema,
      staged_version.configuration_schema, staged_version.output_schema,
      staged_version.presentation_metadata, 'Available', 'available',
      release_adapter_id, release_template_evidence_id, released_at, released_at
    )
    RETURNING id INTO release_template_version_id;
  ELSIF NOT EXISTS (
    SELECT 1
    FROM app.service_template_versions AS version
    WHERE version.id = release_template_version_id
      AND version.input_schema = staged_version.input_schema
      AND version.configuration_schema = staged_version.configuration_schema
      AND version.output_schema = staged_version.output_schema
      AND version.presentation_metadata = staged_version.presentation_metadata
      AND version.adapter_version_id = release_adapter_id
      AND version.launch_evidence_id = release_template_evidence_id
      AND version.availability_state = 'available'
      AND version.effective_at IS NOT NULL
      AND version.published_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'AMAZON_RELEASE_TEMPLATE_VERSION_CONFLICT' USING ERRCODE = '55000';
  END IF;

  SELECT mapping.id
  INTO release_mapping_id
  FROM app.provider_mappings AS mapping
  WHERE mapping.service_template_version_id = release_template_version_id
    AND mapping.environment = attempt.environment
    AND mapping.state = 'enabled';

  IF release_mapping_id IS NULL THEN
    release_mapping_id := gen_random_uuid();
    INSERT INTO app.launch_evidence (
      evidence_code, scope_type, scope_key, state, restricted_reference,
      evidence_hash, effective_at, expires_at, approved_by, approved_at
    ) VALUES (
      'amazon.mapping.' || attempt.operation_code || '.' || attempt.environment ||
        '.release.' || release_mapping_id::text,
      'provider_mapping', release_mapping_id::text, 'approved',
      p_restricted_reference, p_evidence_hash, released_at, p_expires_at,
      p_reviewer, released_at
    ) RETURNING id INTO release_mapping_evidence_id;

    INSERT INTO app.provider_mappings (
      id, service_template_version_id, adapter_version_id,
      provider_credential_id, environment, operation_code,
      provider_resource_ciphertext, provider_resource_fingerprint,
      output_policy, commercial_config_version, config_version,
      launch_evidence_id, state
    ) VALUES (
      release_mapping_id, release_template_version_id, release_adapter_id,
      credential.id, attempt.environment, attempt.operation_code,
      accepted_mapping.provider_resource_ciphertext,
      accepted_mapping.provider_resource_fingerprint,
      accepted_mapping.output_policy, accepted_mapping.commercial_config_version,
      accepted_mapping.config_version, release_mapping_evidence_id, 'enabled'
    );
  ELSIF NOT EXISTS (
    SELECT 1
    FROM app.provider_mappings AS mapping
    JOIN app.launch_evidence AS evidence ON evidence.id = mapping.launch_evidence_id
    WHERE mapping.id = release_mapping_id
      AND mapping.adapter_version_id = release_adapter_id
      AND mapping.provider_credential_id = credential.id
      AND mapping.operation_code = attempt.operation_code
      AND mapping.provider_resource_ciphertext = accepted_mapping.provider_resource_ciphertext
      AND mapping.provider_resource_fingerprint = accepted_mapping.provider_resource_fingerprint
      AND mapping.output_policy = accepted_mapping.output_policy
      AND mapping.commercial_config_version = accepted_mapping.commercial_config_version
      AND mapping.config_version = accepted_mapping.config_version
      AND evidence.state = 'approved'
      AND evidence.effective_at IS NOT NULL
      AND evidence.effective_at <= released_at
      AND (evidence.expires_at IS NULL OR evidence.expires_at > released_at)
  ) THEN
    RAISE EXCEPTION 'AMAZON_RELEASE_MAPPING_CONFLICT' USING ERRCODE = '55000';
  ELSE
    replayed := true;
  END IF;

  IF current_template.state = 'published' THEN
    IF current_template.current_public_version_id <> release_template_version_id THEN
      RAISE EXCEPTION 'AMAZON_RELEASE_PUBLICATION_CONFLICT' USING ERRCODE = '55000';
    END IF;
    replayed := true;
  ELSE
    UPDATE app.service_templates
    SET state = 'published', current_public_version_id = release_template_version_id,
        updated_at = released_at
    WHERE id = current_template.id;
  END IF;

  IF NOT replayed THEN
    INSERT INTO app.audit_events (
      action, target_type, target_id, outcome, reason, safe_diff
    ) VALUES (
      'provider.operation.publish', 'provider_qualification', attempt.id,
      'published', p_reason, jsonb_build_object(
        'operation_code', attempt.operation_code,
        'environment', attempt.environment,
        'template_slug', current_template.slug,
        'template_version', release_version_number,
        'reviewer', p_reviewer
      )
    );
  END IF;

  RETURN QUERY SELECT
    attempt.operation_code,
    current_template.slug,
    release_version_number,
    attempt.environment,
    CASE WHEN replayed THEN 'replayed' ELSE 'published' END;
END;
$$;

REVOKE ALL ON FUNCTION app.publish_qualified_amazon_operation_v1(
  text, uuid, text, bytea, text, text, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.publish_qualified_amazon_operation_v1(
  text, uuid, text, bytea, text, text, timestamptz
) TO dhumi_operator;

RESET ROLE;
