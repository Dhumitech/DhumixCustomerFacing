-- M2: private, review-first Marketplace Dataset catalogue import.
--
-- Provider reads are performed by the separately invoked operator process.
-- This migration creates no public route, public Template pointer, enabled
-- adapter, provider mapping, entitlement, purchase, filter or execution path.

SET ROLE dhumi_owner;

ALTER TABLE app.catalog_candidates
  ADD COLUMN adapter_version_id uuid
    REFERENCES app.adapter_versions(id) ON DELETE RESTRICT,
  ADD COLUMN resource_code text,
  ADD COLUMN provider_resource_name text,
  ADD COLUMN provider_record_count bigint,
  ADD COLUMN catalogue_entry_checksum bytea,
  ADD COLUMN metadata_observed_at timestamptz,
  ADD COLUMN service_template_version_id uuid
    REFERENCES app.service_template_versions(id) ON DELETE RESTRICT;

ALTER TABLE app.catalog_candidates
  ADD CONSTRAINT catalog_candidates_marketplace_contract_check
  CHECK (
    (
      adapter_version_id IS NULL
      AND resource_code IS NULL
      AND provider_resource_name IS NULL
      AND provider_record_count IS NULL
      AND catalogue_entry_checksum IS NULL
      AND metadata_observed_at IS NULL
      AND service_template_version_id IS NULL
    )
    OR
    (
      adapter_version_id IS NOT NULL
      AND resource_code IN ('linkedin.posts', 'linkedin.people.standard')
      AND provider_resource_name IS NOT NULL
      AND length(btrim(provider_resource_name)) BETWEEN 1 AND 256
      AND (provider_record_count IS NULL OR provider_record_count >= 0)
      AND catalogue_entry_checksum IS NOT NULL
      AND octet_length(catalogue_entry_checksum) = 32
      AND metadata_object_key IS NOT NULL
      AND metadata_checksum IS NOT NULL
      AND octet_length(metadata_checksum) = 32
      AND metadata_observed_at IS NOT NULL
    )
  );

CREATE UNIQUE INDEX catalog_candidates_marketplace_observation_identity_idx
  ON app.catalog_candidates (
    adapter_version_id,
    resource_code,
    provider_resource_fingerprint,
    catalogue_entry_checksum,
    metadata_checksum
  )
  WHERE adapter_version_id IS NOT NULL;

CREATE TABLE app.catalog_import_candidate_observations (
  catalog_import_id uuid NOT NULL
    REFERENCES app.catalog_imports(id) ON DELETE RESTRICT,
  catalog_candidate_id uuid NOT NULL
    REFERENCES app.catalog_candidates(id) ON DELETE RESTRICT,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (catalog_import_id, catalog_candidate_id)
);

REVOKE ALL ON app.catalog_import_candidate_observations FROM PUBLIC;

INSERT INTO app.adapter_definitions (code, product_family)
VALUES ('bright_data.marketplace.catalogue', 'marketplace_dataset')
ON CONFLICT (code) DO NOTHING;

INSERT INTO app.adapter_versions (
  adapter_definition_id,
  semantic_version,
  capability_metadata,
  request_schema,
  result_schema,
  error_schema,
  code_artifact_digest,
  state
)
SELECT
  definition.id,
  '1.0.0-m2',
  '{
    "provider": "bright_data",
    "product_family": "marketplace_dataset",
    "operations": ["dataset_list", "dataset_metadata"],
    "network_methods": ["GET"],
    "customer_visible": false,
    "can_filter": false,
    "can_purchase": false,
    "can_execute": false,
    "can_publish": false
  }'::jsonb,
  '{
    "type": "object",
    "additionalProperties": false,
    "required": ["source"],
    "properties": {
      "source": {"type": "string", "enum": ["fixture", "provider"]}
    }
  }'::jsonb,
  '{
    "type": "object",
    "additionalProperties": false,
    "required": ["candidate_count"],
    "properties": {
      "candidate_count": {"type": "integer", "minimum": 0, "maximum": 2}
    }
  }'::jsonb,
  '{
    "type": "object",
    "additionalProperties": false,
    "required": ["code"],
    "properties": {
      "code": {"type": "string"}
    }
  }'::jsonb,
  decode('b47e8192f8c9eed8d14cc972e4a9ef570f4f737550fed6d7c28d5f07364b1993', 'hex'),
  'disabled'
FROM app.adapter_definitions AS definition
WHERE definition.code = 'bright_data.marketplace.catalogue'
ON CONFLICT (adapter_definition_id, semantic_version) DO NOTHING;

-- FORCE RLS applies to these two tables. These policies admit only the draft
-- LinkedIn identities and coming-soon versions created by the M2 reviewer.
CREATE POLICY service_templates_marketplace_m2_definer_select
  ON app.service_templates
  FOR SELECT
  TO dhumi_owner
  USING (
    product_family = 'marketplace_dataset'
    AND slug IN ('linkedin-posts', 'linkedin-people')
    AND state = 'draft'
    AND current_public_version_id IS NULL
  );

CREATE POLICY service_templates_marketplace_m2_definer_insert
  ON app.service_templates
  FOR INSERT
  TO dhumi_owner
  WITH CHECK (
    product_family = 'marketplace_dataset'
    AND slug IN ('linkedin-posts', 'linkedin-people')
    AND state = 'draft'
    AND current_public_version_id IS NULL
  );

CREATE POLICY service_template_versions_marketplace_m2_definer_select
  ON app.service_template_versions
  FOR SELECT
  TO dhumi_owner
  USING (
    availability_state = 'coming_soon'
    AND effective_at IS NULL
    AND published_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM app.adapter_versions AS adapter
      JOIN app.adapter_definitions AS definition
        ON definition.id = adapter.adapter_definition_id
      WHERE adapter.id = adapter_version_id
        AND adapter.semantic_version = '1.0.0-m2'
        AND adapter.state = 'disabled'
        AND definition.code = 'bright_data.marketplace.catalogue'
    )
  );

CREATE POLICY service_template_versions_marketplace_m2_definer_insert
  ON app.service_template_versions
  FOR INSERT
  TO dhumi_owner
  WITH CHECK (
    availability_state = 'coming_soon'
    AND effective_at IS NULL
    AND published_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM app.adapter_versions AS adapter
      JOIN app.adapter_definitions AS definition
        ON definition.id = adapter.adapter_definition_id
      WHERE adapter.id = adapter_version_id
        AND adapter.semantic_version = '1.0.0-m2'
        AND adapter.state = 'disabled'
        AND definition.code = 'bright_data.marketplace.catalogue'
    )
    AND EXISTS (
      SELECT 1
      FROM app.launch_evidence AS evidence
      WHERE evidence.id = launch_evidence_id
        AND evidence.scope_type = 'service_template_version'
        AND evidence.state = 'pending'
        AND evidence.effective_at IS NULL
        AND evidence.approved_at IS NULL
    )
  );

CREATE FUNCTION app.begin_marketplace_catalog_import(
  p_import_id uuid,
  p_environment text,
  p_actor text,
  p_restricted_reference text
)
RETURNS TABLE (
  import_id uuid,
  adapter_version_id uuid,
  provider_credential_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  resolved_adapter_version_id uuid;
  resolved_evidence_id uuid;
  resolved_credential_id uuid;
BEGIN
  IF p_import_id IS NULL
     OR p_environment NOT IN ('local', 'test')
     OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$'
     OR length(p_restricted_reference) NOT BETWEEN 8 AND 1024
     OR btrim(p_restricted_reference) <> p_restricted_reference THEN
    RAISE EXCEPTION 'MARKETPLACE_IMPORT_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT version.id
  INTO resolved_adapter_version_id
  FROM app.adapter_versions AS version
  JOIN app.adapter_definitions AS definition
    ON definition.id = version.adapter_definition_id
  WHERE definition.code = 'bright_data.marketplace.catalogue'
    AND version.semantic_version = '1.0.0-m2'
    AND version.state = 'disabled';

  IF resolved_adapter_version_id IS NULL THEN
    RAISE EXCEPTION 'MARKETPLACE_IMPORT_ADAPTER_NOT_AVAILABLE' USING ERRCODE = 'P0002';
  END IF;

  SELECT credential.id
  INTO resolved_credential_id
  FROM app.provider_credentials AS credential
  WHERE credential.provider_code = 'bright_data'
    AND credential.environment = p_environment
    AND credential.vault_secret_reference = 'BRIGHTDATA_API_KEY'
    AND credential.state IN ('inactive', 'active');

  IF resolved_credential_id IS NULL THEN
    INSERT INTO app.launch_evidence (
      evidence_code,
      scope_type,
      scope_key,
      state,
      restricted_reference
    ) VALUES (
      'bright_data.credential.' || p_environment || '.marketplace_catalogue',
      'provider_credential',
      'bright_data:' || p_environment || ':BRIGHTDATA_API_KEY',
      'pending',
      p_restricted_reference
    )
    ON CONFLICT (evidence_code, scope_type, scope_key) DO NOTHING;

    SELECT evidence.id
    INTO resolved_evidence_id
    FROM app.launch_evidence AS evidence
    WHERE evidence.evidence_code =
          'bright_data.credential.' || p_environment || '.marketplace_catalogue'
      AND evidence.scope_type = 'provider_credential'
      AND evidence.scope_key = 'bright_data:' || p_environment || ':BRIGHTDATA_API_KEY'
      AND evidence.state IN ('pending', 'approved');

    IF resolved_evidence_id IS NULL THEN
      RAISE EXCEPTION 'MARKETPLACE_IMPORT_CREDENTIAL_EVIDENCE_NOT_AVAILABLE'
        USING ERRCODE = 'P0002';
    END IF;

    INSERT INTO app.provider_credentials (
      provider_code,
      environment,
      vault_secret_reference,
      owner_metadata,
      permission_label,
      state,
      launch_evidence_id
    ) VALUES (
      'bright_data',
      p_environment,
      'BRIGHTDATA_API_KEY',
      '{"use":"marketplace_catalogue_read"}'::jsonb,
      'marketplace_catalogue_read',
      'inactive',
      resolved_evidence_id
    )
    ON CONFLICT (provider_code, environment, vault_secret_reference) DO NOTHING;

    SELECT credential.id
    INTO resolved_credential_id
    FROM app.provider_credentials AS credential
    WHERE credential.provider_code = 'bright_data'
      AND credential.environment = p_environment
      AND credential.vault_secret_reference = 'BRIGHTDATA_API_KEY'
      AND credential.state IN ('inactive', 'active');
  END IF;

  IF resolved_credential_id IS NULL THEN
    RAISE EXCEPTION 'MARKETPLACE_IMPORT_CREDENTIAL_NOT_AVAILABLE' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO app.catalog_imports (
    id,
    adapter_version_id,
    provider_credential_id,
    state,
    started_at,
    environment,
    candidate_count
  ) VALUES (
    p_import_id,
    resolved_adapter_version_id,
    resolved_credential_id,
    'running',
    clock_timestamp(),
    p_environment,
    0
  );

  INSERT INTO app.audit_events (
    action,
    target_type,
    target_id,
    outcome,
    safe_diff
  ) VALUES (
    'provider.catalog_import.begin',
    'catalog_import',
    p_import_id,
    'accepted',
    jsonb_build_object(
      'actor', p_actor,
      'environment', p_environment,
      'product_family', 'marketplace_dataset',
      'source_operations', jsonb_build_array('dataset_list', 'dataset_metadata')
    )
  );

  RETURN QUERY
  SELECT p_import_id, resolved_adapter_version_id, resolved_credential_id;
END;
$$;

CREATE FUNCTION app.complete_marketplace_catalog_import(
  p_import_id uuid,
  p_candidates jsonb,
  p_evidence_object_key text,
  p_evidence_checksum bytea,
  p_actor text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  current_import app.catalog_imports%ROWTYPE;
  candidate jsonb;
  resolved_results jsonb := '[]'::jsonb;
  resolved_candidate_id uuid;
  supplied_candidate_id uuid;
  candidate_ciphertext bytea;
  candidate_fingerprint bytea;
  candidate_catalogue_checksum bytea;
  candidate_metadata_checksum bytea;
  candidate_offer_code text;
  candidate_provider_name text;
  candidate_record_count bigint;
  candidate_metadata_object_key text;
  candidate_metadata_observed_at timestamptz;
  expected_metadata_file text;
  disposition text;
BEGIN
  IF p_import_id IS NULL
     OR jsonb_typeof(p_candidates) <> 'array'
     OR jsonb_array_length(p_candidates) <> 2
     OR p_evidence_object_key <> 'qualification/catalog-imports/' ||
          p_import_id::text || '/marketplace-dataset-list.json'
     OR p_evidence_checksum IS NULL
     OR octet_length(p_evidence_checksum) <> 32
     OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$' THEN
    RAISE EXCEPTION 'MARKETPLACE_IMPORT_EVIDENCE_INVALID' USING ERRCODE = '22023';
  END IF;

  IF (SELECT count(DISTINCT value->>'offer_code')
      FROM jsonb_array_elements(p_candidates)) <> 2
     OR NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_candidates)
       WHERE value->>'offer_code' = 'linkedin.posts'
     )
     OR NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_candidates)
       WHERE value->>'offer_code' = 'linkedin.people.standard'
     ) THEN
    RAISE EXCEPTION 'MARKETPLACE_IMPORT_OFFERS_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT import.*
  INTO current_import
  FROM app.catalog_imports AS import
  JOIN app.adapter_versions AS adapter ON adapter.id = import.adapter_version_id
  JOIN app.adapter_definitions AS definition
    ON definition.id = adapter.adapter_definition_id
  WHERE import.id = p_import_id
    AND definition.code = 'bright_data.marketplace.catalogue'
    AND adapter.semantic_version = '1.0.0-m2'
  FOR UPDATE OF import;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MARKETPLACE_IMPORT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF current_import.state = 'completed' THEN
    IF current_import.evidence_object_key = p_evidence_object_key
       AND current_import.evidence_checksum = p_evidence_checksum
       AND current_import.candidate_count = 2 THEN
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'candidate_id', candidate_row.id,
            'offer_code', candidate_row.resource_code,
            'disposition', 'existing'
          )
          ORDER BY candidate_row.resource_code
        ),
        '[]'::jsonb
      )
      INTO resolved_results
      FROM app.catalog_import_candidate_observations AS observation
      JOIN app.catalog_candidates AS candidate_row
        ON candidate_row.id = observation.catalog_candidate_id
      WHERE observation.catalog_import_id = p_import_id;

      IF jsonb_array_length(resolved_results) = 2 THEN
        RETURN resolved_results;
      END IF;
    END IF;
    RAISE EXCEPTION 'MARKETPLACE_IMPORT_REPLAY_CONFLICT' USING ERRCODE = '23505';
  END IF;

  IF current_import.state <> 'running' THEN
    RAISE EXCEPTION 'MARKETPLACE_IMPORT_STATE_CONFLICT' USING ERRCODE = '55000';
  END IF;

  FOR candidate IN SELECT value FROM jsonb_array_elements(p_candidates)
  LOOP
    IF jsonb_typeof(candidate) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(candidate)) <> 10
       OR NOT (
         candidate ?& ARRAY[
           'id',
           'offer_code',
           'provider_name',
           'record_count',
           'catalogue_entry_checksum_hex',
           'ciphertext_hex',
           'fingerprint_hex',
           'metadata_object_key',
           'metadata_checksum_hex',
           'metadata_observed_at'
         ]
       ) THEN
      RAISE EXCEPTION 'MARKETPLACE_CANDIDATE_INVALID' USING ERRCODE = '22023';
    END IF;

    BEGIN
      supplied_candidate_id := (candidate->>'id')::uuid;
      candidate_offer_code := candidate->>'offer_code';
      candidate_provider_name := candidate->>'provider_name';
      candidate_record_count := (candidate->>'record_count')::bigint;
      candidate_catalogue_checksum :=
        decode(candidate->>'catalogue_entry_checksum_hex', 'hex');
      candidate_ciphertext := decode(candidate->>'ciphertext_hex', 'hex');
      candidate_fingerprint := decode(candidate->>'fingerprint_hex', 'hex');
      candidate_metadata_object_key := candidate->>'metadata_object_key';
      candidate_metadata_checksum := decode(candidate->>'metadata_checksum_hex', 'hex');
      candidate_metadata_observed_at := (candidate->>'metadata_observed_at')::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'MARKETPLACE_CANDIDATE_INVALID' USING ERRCODE = '22023';
    END;

    expected_metadata_file := CASE candidate_offer_code
      WHEN 'linkedin.posts' THEN 'linkedin-posts.json'
      WHEN 'linkedin.people.standard' THEN 'linkedin-people-standard.json'
      ELSE NULL
    END;

    IF supplied_candidate_id IS NULL
       OR expected_metadata_file IS NULL
       OR length(btrim(candidate_provider_name)) NOT BETWEEN 1 AND 256
       OR (candidate_record_count IS NOT NULL AND candidate_record_count < 0)
       OR octet_length(candidate_catalogue_checksum) <> 32
       OR octet_length(candidate_ciphertext) < 30
       OR octet_length(candidate_fingerprint) <> 32
       OR candidate_metadata_object_key <>
          'qualification/catalog-imports/' || p_import_id::text ||
          '/metadata/' || expected_metadata_file
       OR octet_length(candidate_metadata_checksum) <> 32
       OR candidate_metadata_observed_at IS NULL THEN
      RAISE EXCEPTION 'MARKETPLACE_CANDIDATE_INVALID' USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        current_import.adapter_version_id::text || ':' || candidate_offer_code || ':' ||
        encode(candidate_fingerprint, 'hex') || ':' ||
        encode(candidate_catalogue_checksum, 'hex') || ':' ||
        encode(candidate_metadata_checksum, 'hex'),
        0
      )
    );

    SELECT candidate_row.id
    INTO resolved_candidate_id
    FROM app.catalog_candidates AS candidate_row
    WHERE candidate_row.adapter_version_id = current_import.adapter_version_id
      AND candidate_row.resource_code = candidate_offer_code
      AND candidate_row.provider_resource_fingerprint = candidate_fingerprint
      AND candidate_row.catalogue_entry_checksum = candidate_catalogue_checksum
      AND candidate_row.metadata_checksum = candidate_metadata_checksum;

    IF resolved_candidate_id IS NULL THEN
      INSERT INTO app.catalog_candidates (
        id,
        catalog_import_id,
        adapter_version_id,
        resource_code,
        provider_resource_name,
        provider_record_count,
        catalogue_entry_checksum,
        provider_resource_ciphertext,
        provider_resource_fingerprint,
        metadata_object_key,
        metadata_checksum,
        metadata_observed_at,
        review_state
      ) VALUES (
        supplied_candidate_id,
        p_import_id,
        current_import.adapter_version_id,
        candidate_offer_code,
        candidate_provider_name,
        candidate_record_count,
        candidate_catalogue_checksum,
        candidate_ciphertext,
        candidate_fingerprint,
        candidate_metadata_object_key,
        candidate_metadata_checksum,
        candidate_metadata_observed_at,
        'pending'
      )
      RETURNING id INTO resolved_candidate_id;
      disposition := 'created';
    ELSE
      disposition := 'existing';
    END IF;

    INSERT INTO app.catalog_import_candidate_observations (
      catalog_import_id,
      catalog_candidate_id
    ) VALUES (p_import_id, resolved_candidate_id);

    resolved_results := resolved_results || jsonb_build_array(
      jsonb_build_object(
        'candidate_id', resolved_candidate_id,
        'offer_code', candidate_offer_code,
        'disposition', disposition
      )
    );
  END LOOP;

  UPDATE app.catalog_imports
  SET state = 'completed',
      completed_at = clock_timestamp(),
      evidence_object_key = p_evidence_object_key,
      evidence_checksum = p_evidence_checksum,
      candidate_count = 2,
      safe_error_code = NULL
  WHERE id = p_import_id;

  INSERT INTO app.audit_events (
    action,
    target_type,
    target_id,
    outcome,
    safe_diff
  ) VALUES (
    'provider.catalog_import.complete',
    'catalog_import',
    p_import_id,
    'completed',
    jsonb_build_object(
      'actor', p_actor,
      'candidate_count', 2,
      'product_family', 'marketplace_dataset'
    )
  );

  RETURN resolved_results;
END;
$$;

CREATE FUNCTION app.fail_marketplace_catalog_import(
  p_import_id uuid,
  p_safe_error_code text,
  p_actor text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF p_import_id IS NULL
     OR p_safe_error_code !~ '^[A-Z][A-Z0-9_]{2,63}$'
     OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$' THEN
    RAISE EXCEPTION 'MARKETPLACE_IMPORT_FAILURE_INVALID' USING ERRCODE = '22023';
  END IF;

  UPDATE app.catalog_imports AS import
  SET state = 'failed',
      completed_at = clock_timestamp(),
      safe_error_code = p_safe_error_code
  WHERE import.id = p_import_id
    AND import.state = 'running'
    AND EXISTS (
      SELECT 1
      FROM app.adapter_versions AS adapter
      JOIN app.adapter_definitions AS definition
        ON definition.id = adapter.adapter_definition_id
      WHERE adapter.id = import.adapter_version_id
        AND definition.code = 'bright_data.marketplace.catalogue'
        AND adapter.semantic_version = '1.0.0-m2'
    );

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MARKETPLACE_IMPORT_STATE_CONFLICT' USING ERRCODE = '55000';
  END IF;

  INSERT INTO app.audit_events (
    action,
    target_type,
    target_id,
    outcome,
    reason,
    safe_diff
  ) VALUES (
    'provider.catalog_import.fail',
    'catalog_import',
    p_import_id,
    'failed',
    p_safe_error_code,
    jsonb_build_object('actor', p_actor, 'product_family', 'marketplace_dataset')
  );
  RETURN true;
END;
$$;

CREATE FUNCTION app.review_marketplace_catalog_candidate(
  p_candidate_id uuid,
  p_decision text,
  p_actor text
)
RETURNS TABLE (
  candidate_id uuid,
  review_state text,
  template_slug text,
  template_version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  candidate_row app.catalog_candidates%ROWTYPE;
  target_review_state text;
  resolved_template_id uuid;
  resolved_template_version_id uuid;
  resolved_template_slug text;
  resolved_template_name text;
  resolved_operation_name text;
  resolved_template_version integer;
  resolved_launch_evidence_id uuid;
  resolved_at timestamptz := clock_timestamp();
BEGIN
  IF p_candidate_id IS NULL
     OR p_decision NOT IN ('approve', 'reject')
     OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$' THEN
    RAISE EXCEPTION 'MARKETPLACE_CANDIDATE_REVIEW_INVALID' USING ERRCODE = '22023';
  END IF;

  target_review_state := CASE p_decision
    WHEN 'approve' THEN 'approved'
    ELSE 'rejected'
  END;

  SELECT candidate.*
  INTO candidate_row
  FROM app.catalog_candidates AS candidate
  JOIN app.adapter_versions AS adapter ON adapter.id = candidate.adapter_version_id
  JOIN app.adapter_definitions AS definition
    ON definition.id = adapter.adapter_definition_id
  WHERE candidate.id = p_candidate_id
    AND definition.code = 'bright_data.marketplace.catalogue'
    AND adapter.semantic_version = '1.0.0-m2'
  FOR UPDATE OF candidate;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MARKETPLACE_CANDIDATE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  resolved_template_slug := CASE candidate_row.resource_code
    WHEN 'linkedin.posts' THEN 'linkedin-posts'
    WHEN 'linkedin.people.standard' THEN 'linkedin-people'
    ELSE NULL
  END;
  resolved_template_name := CASE candidate_row.resource_code
    WHEN 'linkedin.posts' THEN 'LinkedIn Posts'
    WHEN 'linkedin.people.standard' THEN 'LinkedIn People'
    ELSE NULL
  END;
  resolved_operation_name := CASE candidate_row.resource_code
    WHEN 'linkedin.posts' THEN 'Posts'
    WHEN 'linkedin.people.standard' THEN 'People'
    ELSE NULL
  END;

  IF resolved_template_slug IS NULL THEN
    RAISE EXCEPTION 'MARKETPLACE_CANDIDATE_RESOURCE_INVALID' USING ERRCODE = '22023';
  END IF;

  IF candidate_row.review_state = target_review_state THEN
    IF target_review_state = 'approved' THEN
      SELECT template.slug, version.version
      INTO resolved_template_slug, resolved_template_version
      FROM app.service_template_versions AS version
      JOIN app.service_templates AS template
        ON template.id = version.service_template_id
      WHERE version.id = candidate_row.service_template_version_id;
    ELSE
      resolved_template_slug := NULL;
      resolved_template_version := NULL;
    END IF;
    RETURN QUERY SELECT
      candidate_row.id,
      candidate_row.review_state,
      resolved_template_slug,
      resolved_template_version;
    RETURN;
  END IF;

  IF candidate_row.review_state <> 'pending' THEN
    RAISE EXCEPTION 'MARKETPLACE_CANDIDATE_REVIEW_CONFLICT' USING ERRCODE = '55000';
  END IF;

  IF target_review_state = 'rejected' THEN
    UPDATE app.catalog_candidates
    SET review_state = 'rejected',
        reviewed_by = p_actor,
        reviewed_at = resolved_at
    WHERE id = candidate_row.id;

    INSERT INTO app.audit_events (
      action, target_type, target_id, outcome, safe_diff
    ) VALUES (
      'provider.catalog_candidate.review',
      'catalog_candidate',
      candidate_row.id,
      'rejected',
      jsonb_build_object(
        'actor', p_actor,
        'resource_code', candidate_row.resource_code,
        'public_template_created', false
      )
    );

    RETURN QUERY SELECT candidate_row.id, 'rejected'::text, NULL::text, NULL::integer;
    RETURN;
  END IF;

  INSERT INTO app.service_templates (
    slug,
    product_family,
    state,
    current_public_version_id
  ) VALUES (
    resolved_template_slug,
    'marketplace_dataset',
    'draft',
    NULL
  )
  ON CONFLICT (slug) DO NOTHING
  RETURNING id INTO resolved_template_id;

  IF resolved_template_id IS NULL THEN
    SELECT template.id
    INTO resolved_template_id
    FROM app.service_templates AS template
    WHERE template.slug = resolved_template_slug
      AND template.product_family = 'marketplace_dataset'
      AND template.state = 'draft'
      AND template.current_public_version_id IS NULL
    FOR UPDATE;
  END IF;

  IF resolved_template_id IS NULL THEN
    RAISE EXCEPTION 'MARKETPLACE_DRAFT_TEMPLATE_CONFLICT' USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(max(version.version), 0) + 1
  INTO resolved_template_version
  FROM app.service_template_versions AS version
  WHERE version.service_template_id = resolved_template_id;

  INSERT INTO app.launch_evidence (
    evidence_code,
    scope_type,
    scope_key,
    state,
    restricted_reference,
    evidence_hash
  ) VALUES (
    'marketplace.template_candidate.' || candidate_row.id::text,
    'service_template_version',
    candidate_row.id::text,
    'pending',
    candidate_row.metadata_object_key,
    candidate_row.metadata_checksum
  )
  RETURNING id INTO resolved_launch_evidence_id;

  INSERT INTO app.service_template_versions (
    service_template_id,
    version,
    public_name,
    public_description,
    input_schema,
    configuration_schema,
    output_schema,
    presentation_metadata,
    availability_copy,
    availability_state,
    adapter_version_id,
    launch_evidence_id,
    effective_at,
    published_at
  ) VALUES (
    resolved_template_id,
    resolved_template_version,
    resolved_template_name,
    resolved_template_name ||
      ' dataset candidate reviewed by Dhumi. Sample and purchase access are not enabled.',
    '{"type":"object","additionalProperties":false}'::jsonb,
    '{"type":"object","additionalProperties":false}'::jsonb,
    '{
      "$schema":"https://json-schema.org/draft/2020-12/schema",
      "type":"array",
      "items":{"type":"object"},
      "$comment":"M2 records provider metadata evidence only; a public output contract requires M3 acceptance."
    }'::jsonb,
    jsonb_build_object(
      'domain_slug', 'linkedin',
      'domain_name', 'LinkedIn',
      'category', 'social-media',
      'icon_key', 'linkedin',
      'operation_group', 'LinkedIn datasets',
      'operation_name', resolved_operation_name,
      'display_priority',
        CASE candidate_row.resource_code WHEN 'linkedin.posts' THEN 100 ELSE 110 END
    ),
    'Coming soon',
    'coming_soon',
    candidate_row.adapter_version_id,
    resolved_launch_evidence_id,
    NULL,
    NULL
  )
  RETURNING id INTO resolved_template_version_id;

  UPDATE app.catalog_candidates
  SET review_state = 'approved',
      reviewed_by = p_actor,
      reviewed_at = resolved_at,
      service_template_version_id = resolved_template_version_id
  WHERE id = candidate_row.id;

  INSERT INTO app.audit_events (
    action, target_type, target_id, outcome, safe_diff
  ) VALUES (
    'provider.catalog_candidate.review',
    'catalog_candidate',
    candidate_row.id,
    'approved',
    jsonb_build_object(
      'actor', p_actor,
      'resource_code', candidate_row.resource_code,
      'template_slug', resolved_template_slug,
      'template_version', resolved_template_version,
      'public_template_created', false
    )
  );

  RETURN QUERY SELECT
    candidate_row.id,
    'approved'::text,
    resolved_template_slug,
    resolved_template_version;
END;
$$;

REVOKE ALL ON FUNCTION app.begin_marketplace_catalog_import(uuid, text, text, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app.complete_marketplace_catalog_import(uuid, jsonb, text, bytea, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app.fail_marketplace_catalog_import(uuid, text, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app.review_marketplace_catalog_candidate(uuid, text, text)
  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.begin_marketplace_catalog_import(uuid, text, text, text)
  TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.complete_marketplace_catalog_import(uuid, jsonb, text, bytea, text)
  TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.fail_marketplace_catalog_import(uuid, text, text)
  TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.review_marketplace_catalog_candidate(uuid, text, text)
  TO dhumi_operator;

RESET ROLE;
