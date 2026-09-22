-- Pattern 7: restricted account discovery and independently reviewed Amazon
-- qualification evidence. This migration creates no LOGIN/role, public route,
-- provider call, customer-visible Template or enabled provider mapping.

SET ROLE dhumi_owner;

ALTER TABLE app.catalog_imports
  ADD COLUMN environment text,
  ADD COLUMN evidence_object_key text,
  ADD COLUMN evidence_checksum bytea,
  ADD COLUMN candidate_count integer;

ALTER TABLE app.catalog_imports
  ADD CONSTRAINT catalog_imports_pattern7_evidence_check
  CHECK (
    environment IS NULL
    OR (
      environment IN ('local', 'test', 'staging', 'production')
      AND candidate_count IS NOT NULL
      AND candidate_count BETWEEN 0 AND 10000
      AND (
        state IN ('queued', 'running')
        OR (
          state = 'completed'
          AND evidence_object_key IS NOT NULL
          AND evidence_checksum IS NOT NULL
          AND octet_length(evidence_checksum) = 32
        )
        OR (
          state = 'failed'
          AND safe_error_code IS NOT NULL
        )
      )
    )
  );

CREATE TABLE app.provider_qualification_attempts (
  id uuid PRIMARY KEY,
  operation_code text NOT NULL
    CHECK (operation_code ~ '^amazon\.[a-z0-9_.]{3,120}$'),
  environment text NOT NULL
    CHECK (environment IN ('local', 'test', 'staging', 'production')),
  service_template_version_id uuid NOT NULL
    REFERENCES app.service_template_versions(id) ON DELETE RESTRICT,
  adapter_version_id uuid NOT NULL
    REFERENCES app.adapter_versions(id) ON DELETE RESTRICT,
  provider_credential_id uuid NOT NULL
    REFERENCES app.provider_credentials(id) ON DELETE RESTRICT,
  catalog_candidate_id uuid NOT NULL
    REFERENCES app.catalog_candidates(id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'running'
    CHECK (state IN ('running', 'succeeded', 'failed', 'uncertain')),
  submission_mode text
    CHECK (submission_mode IN ('inline', 'snapshot')),
  request_object_key text NOT NULL,
  request_checksum bytea NOT NULL CHECK (octet_length(request_checksum) = 32),
  response_object_key text,
  response_checksum bytea,
  response_content_type text,
  response_byte_count bigint CHECK (response_byte_count IS NULL OR response_byte_count >= 0),
  record_count integer CHECK (record_count IS NULL OR record_count >= 0),
  provider_snapshot_ciphertext bytea,
  provider_snapshot_fingerprint bytea,
  safe_error_code text,
  review_state text NOT NULL DEFAULT 'pending'
    CHECK (review_state IN ('pending', 'approved', 'rejected')),
  launch_evidence_id uuid REFERENCES app.launch_evidence(id) ON DELETE RESTRICT,
  provider_mapping_id uuid REFERENCES app.provider_mappings(id) ON DELETE RESTRICT,
  created_by text NOT NULL,
  reviewed_by text,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT provider_qualification_terminal_evidence_check CHECK (
    (state = 'running'
      AND completed_at IS NULL
      AND submission_mode IS NULL
      AND response_object_key IS NULL
      AND response_checksum IS NULL
      AND safe_error_code IS NULL)
    OR
    (state = 'succeeded'
      AND completed_at IS NOT NULL
      AND submission_mode IS NOT NULL
      AND response_object_key IS NOT NULL
      AND response_checksum IS NOT NULL
      AND octet_length(response_checksum) = 32
      AND response_content_type IS NOT NULL
      AND response_byte_count IS NOT NULL
      AND record_count IS NOT NULL
      AND safe_error_code IS NULL)
    OR
    (state IN ('failed', 'uncertain')
      AND completed_at IS NOT NULL
      AND safe_error_code IS NOT NULL)
  ),
  CONSTRAINT provider_qualification_snapshot_check CHECK (
    (provider_snapshot_ciphertext IS NULL AND provider_snapshot_fingerprint IS NULL)
    OR
    (submission_mode = 'snapshot'
      AND provider_snapshot_ciphertext IS NOT NULL
      AND octet_length(provider_snapshot_ciphertext) >= 30
      AND provider_snapshot_fingerprint IS NOT NULL
      AND octet_length(provider_snapshot_fingerprint) = 32)
  ),
  CONSTRAINT provider_qualification_review_check CHECK (
    (review_state = 'pending'
      AND launch_evidence_id IS NULL
      AND provider_mapping_id IS NULL
      AND reviewed_by IS NULL
      AND reviewed_at IS NULL)
    OR
    (review_state = 'approved'
      AND state = 'succeeded'
      AND launch_evidence_id IS NOT NULL
      AND provider_mapping_id IS NOT NULL
      AND reviewed_by IS NOT NULL
      AND reviewed_at IS NOT NULL)
    OR
    (review_state = 'rejected'
      AND launch_evidence_id IS NULL
      AND provider_mapping_id IS NULL
      AND reviewed_by IS NOT NULL
      AND reviewed_at IS NOT NULL)
  ),
  UNIQUE (provider_mapping_id)
);

CREATE INDEX provider_qualification_by_operation_environment_idx
  ON app.provider_qualification_attempts (operation_code, environment, created_at DESC);

CREATE FUNCTION app.begin_amazon_scraper_catalog_import(
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
     OR length(p_restricted_reference) NOT BETWEEN 8 AND 1024 THEN
    RAISE EXCEPTION 'QUALIFICATION_IMPORT_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT version.id
    INTO resolved_adapter_version_id
  FROM app.adapter_versions AS version
  JOIN app.adapter_definitions AS definition
    ON definition.id = version.adapter_definition_id
  WHERE definition.code = 'bright_data.amazon.scraper_library'
    AND version.semantic_version = '1.0.0-pattern6';

  IF resolved_adapter_version_id IS NULL THEN
    RAISE EXCEPTION 'QUALIFICATION_ADAPTER_NOT_AVAILABLE' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO app.launch_evidence (
    evidence_code, scope_type, scope_key, state, restricted_reference
  ) VALUES (
    'bright_data.credential.' || p_environment || '.qualification',
    'provider_credential',
    'bright_data:' || p_environment || ':BRIGHTDATA_API_KEY',
    'pending',
    p_restricted_reference
  )
  ON CONFLICT (evidence_code, scope_type, scope_key) DO NOTHING;

  SELECT evidence.id
    INTO resolved_evidence_id
  FROM app.launch_evidence AS evidence
  WHERE evidence.evidence_code = 'bright_data.credential.' || p_environment || '.qualification'
    AND evidence.scope_type = 'provider_credential'
    AND evidence.scope_key = 'bright_data:' || p_environment || ':BRIGHTDATA_API_KEY'
    AND evidence.state IN ('pending', 'approved');

  IF resolved_evidence_id IS NULL THEN
    RAISE EXCEPTION 'QUALIFICATION_CREDENTIAL_EVIDENCE_NOT_AVAILABLE' USING ERRCODE = 'P0002';
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
    jsonb_build_object('use', 'pattern7_qualification'),
    'scraper_qualification',
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

  IF resolved_credential_id IS NULL THEN
    RAISE EXCEPTION 'QUALIFICATION_CREDENTIAL_NOT_AVAILABLE' USING ERRCODE = 'P0002';
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
    action, target_type, target_id, outcome, safe_diff
  ) VALUES (
    'provider.catalog_import.begin',
    'catalog_import',
    p_import_id,
    'accepted',
    jsonb_build_object('actor', p_actor, 'environment', p_environment)
  );

  RETURN QUERY SELECT p_import_id, resolved_adapter_version_id, resolved_credential_id;
END;
$$;

CREATE FUNCTION app.complete_amazon_scraper_catalog_import(
  p_import_id uuid,
  p_candidates jsonb,
  p_evidence_object_key text,
  p_evidence_checksum bytea,
  p_actor text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  current_import app.catalog_imports%ROWTYPE;
  candidate jsonb;
  resolved_count integer;
  candidate_id uuid;
  candidate_ciphertext bytea;
  candidate_fingerprint bytea;
BEGIN
  IF jsonb_typeof(p_candidates) <> 'array'
     OR jsonb_array_length(p_candidates) > 10000
     OR p_evidence_object_key !~ '^qualification/catalog-imports/[0-9a-f-]{36}/scrapers\.json$'
     OR p_evidence_checksum IS NULL
     OR octet_length(p_evidence_checksum) <> 32
     OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$' THEN
    RAISE EXCEPTION 'QUALIFICATION_IMPORT_EVIDENCE_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO current_import
  FROM app.catalog_imports
  WHERE id = p_import_id
  FOR UPDATE;

  IF NOT FOUND OR current_import.environment IS NULL THEN
    RAISE EXCEPTION 'QUALIFICATION_IMPORT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF current_import.state = 'completed' THEN
    IF current_import.evidence_object_key = p_evidence_object_key
       AND current_import.evidence_checksum = p_evidence_checksum
       AND current_import.candidate_count = jsonb_array_length(p_candidates) THEN
      RETURN current_import.candidate_count;
    END IF;
    RAISE EXCEPTION 'QUALIFICATION_IMPORT_REPLAY_CONFLICT' USING ERRCODE = '23505';
  END IF;

  IF current_import.state <> 'running' THEN
    RAISE EXCEPTION 'QUALIFICATION_IMPORT_STATE_CONFLICT' USING ERRCODE = '55000';
  END IF;

  FOR candidate IN SELECT value FROM jsonb_array_elements(p_candidates)
  LOOP
    IF jsonb_typeof(candidate) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(candidate)) <> 3
       OR NOT (candidate ? 'id' AND candidate ? 'ciphertext_hex' AND candidate ? 'fingerprint_hex') THEN
      RAISE EXCEPTION 'QUALIFICATION_CANDIDATE_INVALID' USING ERRCODE = '22023';
    END IF;
    BEGIN
      candidate_id := (candidate->>'id')::uuid;
      candidate_ciphertext := decode(candidate->>'ciphertext_hex', 'hex');
      candidate_fingerprint := decode(candidate->>'fingerprint_hex', 'hex');
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'QUALIFICATION_CANDIDATE_INVALID' USING ERRCODE = '22023';
    END;
    IF octet_length(candidate_ciphertext) < 30
       OR octet_length(candidate_fingerprint) <> 32 THEN
      RAISE EXCEPTION 'QUALIFICATION_CANDIDATE_INVALID' USING ERRCODE = '22023';
    END IF;
    INSERT INTO app.catalog_candidates (
      id,
      catalog_import_id,
      provider_resource_ciphertext,
      provider_resource_fingerprint,
      metadata_object_key,
      metadata_checksum,
      review_state
    ) VALUES (
      candidate_id,
      p_import_id,
      candidate_ciphertext,
      candidate_fingerprint,
      p_evidence_object_key,
      p_evidence_checksum,
      'pending'
    );
  END LOOP;

  resolved_count := jsonb_array_length(p_candidates);
  UPDATE app.catalog_imports
  SET state = 'completed',
      completed_at = clock_timestamp(),
      evidence_object_key = p_evidence_object_key,
      evidence_checksum = p_evidence_checksum,
      candidate_count = resolved_count,
      safe_error_code = NULL
  WHERE id = p_import_id;

  INSERT INTO app.audit_events (
    action, target_type, target_id, outcome, safe_diff
  ) VALUES (
    'provider.catalog_import.complete',
    'catalog_import',
    p_import_id,
    'completed',
    jsonb_build_object('actor', p_actor, 'candidate_count', resolved_count)
  );

  RETURN resolved_count;
END;
$$;

CREATE FUNCTION app.fail_amazon_scraper_catalog_import(
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
  IF p_safe_error_code !~ '^[A-Z][A-Z0-9_]{2,63}$'
     OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$' THEN
    RAISE EXCEPTION 'QUALIFICATION_IMPORT_FAILURE_INVALID' USING ERRCODE = '22023';
  END IF;
  UPDATE app.catalog_imports
  SET state = 'failed', completed_at = clock_timestamp(), safe_error_code = p_safe_error_code
  WHERE id = p_import_id AND state = 'running' AND environment IS NOT NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'QUALIFICATION_IMPORT_STATE_CONFLICT' USING ERRCODE = '55000';
  END IF;
  INSERT INTO app.audit_events (action, target_type, target_id, outcome, reason, safe_diff)
  VALUES (
    'provider.catalog_import.fail', 'catalog_import', p_import_id, 'failed',
    p_safe_error_code, jsonb_build_object('actor', p_actor)
  );
  RETURN true;
END;
$$;

CREATE FUNCTION app.review_amazon_scraper_catalog_candidate(
  p_candidate_id uuid,
  p_decision text,
  p_actor text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  target_state text;
  current_state text;
BEGIN
  IF p_decision NOT IN ('approve', 'reject')
     OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$' THEN
    RAISE EXCEPTION 'QUALIFICATION_CANDIDATE_REVIEW_INVALID' USING ERRCODE = '22023';
  END IF;
  target_state := CASE p_decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END;
  SELECT review_state INTO current_state
  FROM app.catalog_candidates WHERE id = p_candidate_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'QUALIFICATION_CANDIDATE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF current_state = target_state THEN RETURN true; END IF;
  IF current_state <> 'pending' THEN
    RAISE EXCEPTION 'QUALIFICATION_CANDIDATE_REVIEW_CONFLICT' USING ERRCODE = '55000';
  END IF;
  UPDATE app.catalog_candidates
  SET review_state = target_state, reviewed_by = p_actor, reviewed_at = clock_timestamp()
  WHERE id = p_candidate_id;
  INSERT INTO app.audit_events (action, target_type, target_id, outcome, safe_diff)
  VALUES (
    'provider.catalog_candidate.review', 'catalog_candidate', p_candidate_id,
    target_state, jsonb_build_object('actor', p_actor)
  );
  RETURN true;
END;
$$;

CREATE FUNCTION app.resolve_amazon_qualification_candidate(
  p_candidate_id uuid,
  p_operation_code text,
  p_environment text
)
RETURNS TABLE (
  candidate_ciphertext bytea,
  candidate_fingerprint bytea,
  service_template_version_id uuid,
  adapter_version_id uuid,
  provider_credential_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT
    candidate.provider_resource_ciphertext,
    candidate.provider_resource_fingerprint,
    version.id,
    catalog_import.adapter_version_id,
    catalog_import.provider_credential_id
  FROM app.catalog_candidates AS candidate
  JOIN app.catalog_imports AS catalog_import
    ON catalog_import.id = candidate.catalog_import_id
  JOIN app.service_template_versions AS version
    ON version.adapter_version_id = catalog_import.adapter_version_id
  JOIN app.launch_evidence AS evidence ON evidence.id = version.launch_evidence_id
  WHERE candidate.id = p_candidate_id
    AND candidate.review_state = 'approved'
    AND catalog_import.state = 'completed'
    AND catalog_import.environment = p_environment
    AND evidence.scope_type = 'service_template_version'
    AND evidence.scope_key = p_operation_code || ':1';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'QUALIFICATION_CANDIDATE_NOT_AVAILABLE' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

CREATE FUNCTION app.begin_amazon_provider_qualification(
  p_qualification_id uuid,
  p_candidate_id uuid,
  p_operation_code text,
  p_environment text,
  p_request_object_key text,
  p_request_checksum bytea,
  p_actor text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  candidate_plan record;
BEGIN
  IF p_qualification_id IS NULL
     OR p_request_object_key !~ '^qualification/operations/[0-9a-f-]{36}/request\.json$'
     OR p_request_checksum IS NULL OR octet_length(p_request_checksum) <> 32
     OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$' THEN
    RAISE EXCEPTION 'QUALIFICATION_BEGIN_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO candidate_plan
  FROM app.resolve_amazon_qualification_candidate(
    p_candidate_id, p_operation_code, p_environment
  );
  INSERT INTO app.provider_qualification_attempts (
    id, operation_code, environment, service_template_version_id,
    adapter_version_id, provider_credential_id, catalog_candidate_id,
    request_object_key, request_checksum, created_by
  ) VALUES (
    p_qualification_id, p_operation_code, p_environment,
    candidate_plan.service_template_version_id,
    candidate_plan.adapter_version_id,
    candidate_plan.provider_credential_id,
    p_candidate_id, p_request_object_key, p_request_checksum, p_actor
  );
  INSERT INTO app.audit_events (action, target_type, target_id, outcome, safe_diff)
  VALUES (
    'provider.qualification.begin', 'provider_qualification', p_qualification_id,
    'accepted', jsonb_build_object('actor', p_actor, 'operation_code', p_operation_code)
  );
  RETURN true;
END;
$$;

CREATE FUNCTION app.resolve_amazon_qualification_acceptance_plan(
  p_qualification_id uuid
)
RETURNS TABLE (
  candidate_id uuid,
  operation_code text,
  environment text,
  candidate_ciphertext bytea,
  candidate_fingerprint bytea
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT
    attempt.catalog_candidate_id,
    attempt.operation_code,
    attempt.environment,
    candidate.provider_resource_ciphertext,
    candidate.provider_resource_fingerprint
  FROM app.provider_qualification_attempts AS attempt
  JOIN app.catalog_candidates AS candidate
    ON candidate.id = attempt.catalog_candidate_id
  WHERE attempt.id = p_qualification_id
    AND attempt.state = 'succeeded'
    AND attempt.review_state = 'pending'
    AND candidate.review_state = 'approved';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'QUALIFICATION_ACCEPTANCE_PLAN_NOT_AVAILABLE' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

CREATE FUNCTION app.complete_amazon_provider_qualification(
  p_qualification_id uuid,
  p_state text,
  p_submission_mode text,
  p_response_object_key text,
  p_response_checksum bytea,
  p_response_content_type text,
  p_response_byte_count bigint,
  p_record_count integer,
  p_snapshot_ciphertext bytea,
  p_snapshot_fingerprint bytea,
  p_safe_error_code text,
  p_actor text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  current_attempt app.provider_qualification_attempts%ROWTYPE;
BEGIN
  IF p_state NOT IN ('succeeded', 'failed', 'uncertain')
     OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$' THEN
    RAISE EXCEPTION 'QUALIFICATION_COMPLETION_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO current_attempt
  FROM app.provider_qualification_attempts
  WHERE id = p_qualification_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'QUALIFICATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF current_attempt.state <> 'running' THEN
    RAISE EXCEPTION 'QUALIFICATION_STATE_CONFLICT' USING ERRCODE = '55000';
  END IF;
  UPDATE app.provider_qualification_attempts
  SET state = p_state,
      submission_mode = p_submission_mode,
      response_object_key = p_response_object_key,
      response_checksum = p_response_checksum,
      response_content_type = p_response_content_type,
      response_byte_count = p_response_byte_count,
      record_count = p_record_count,
      provider_snapshot_ciphertext = p_snapshot_ciphertext,
      provider_snapshot_fingerprint = p_snapshot_fingerprint,
      safe_error_code = p_safe_error_code,
      completed_at = clock_timestamp()
  WHERE id = p_qualification_id;
  INSERT INTO app.audit_events (action, target_type, target_id, outcome, reason, safe_diff)
  VALUES (
    'provider.qualification.complete', 'provider_qualification', p_qualification_id,
    p_state, p_safe_error_code,
    jsonb_build_object('actor', p_actor, 'submission_mode', p_submission_mode)
  );
  RETURN true;
END;
$$;

CREATE FUNCTION app.accept_amazon_provider_qualification(
  p_qualification_id uuid,
  p_mapping_id uuid,
  p_mapping_ciphertext bytea,
  p_mapping_fingerprint bytea,
  p_output_policy jsonb,
  p_commercial_config_version text,
  p_config_version text,
  p_restricted_reference text,
  p_evidence_hash bytea,
  p_reviewer text,
  p_expires_at timestamptz DEFAULT NULL
)
RETURNS TABLE (provider_mapping_id uuid, launch_evidence_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  current_attempt app.provider_qualification_attempts%ROWTYPE;
  resolved_evidence_id uuid;
BEGIN
  IF p_mapping_id IS NULL
     OR p_mapping_ciphertext IS NULL OR octet_length(p_mapping_ciphertext) < 30
     OR p_mapping_fingerprint IS NULL OR octet_length(p_mapping_fingerprint) <> 32
     OR jsonb_typeof(p_output_policy) <> 'object'
     OR NOT (p_output_policy ? 'provider_request'
             AND p_output_policy ? 'snapshot'
             AND p_output_policy ? 'normalizer_code'
             AND p_output_policy ? 'normalizer_version'
             AND p_output_policy ? 'normalized_schema_version')
     OR p_commercial_config_version !~ '^[A-Za-z0-9_.:-]{1,128}$'
     OR p_config_version !~ '^[A-Za-z0-9_.:-]{1,128}$'
     OR length(p_restricted_reference) NOT BETWEEN 8 AND 1024
     OR p_evidence_hash IS NULL OR octet_length(p_evidence_hash) <> 32
     OR p_reviewer !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$'
     OR (p_expires_at IS NOT NULL AND p_expires_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'QUALIFICATION_ACCEPTANCE_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO current_attempt
  FROM app.provider_qualification_attempts
  WHERE id = p_qualification_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'QUALIFICATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF current_attempt.state <> 'succeeded' OR current_attempt.review_state <> 'pending' THEN
    RAISE EXCEPTION 'QUALIFICATION_ACCEPTANCE_STATE_CONFLICT' USING ERRCODE = '55000';
  END IF;
  INSERT INTO app.launch_evidence (
    evidence_code, scope_type, scope_key, state, restricted_reference,
    evidence_hash, effective_at, expires_at, approved_by, approved_at
  ) VALUES (
    'amazon.mapping.' || current_attempt.operation_code || '.' ||
      current_attempt.environment || '.' || p_qualification_id::text,
    'provider_mapping', p_mapping_id::text, 'approved', p_restricted_reference,
    p_evidence_hash, clock_timestamp(), p_expires_at, p_reviewer, clock_timestamp()
  ) RETURNING id INTO resolved_evidence_id;
  INSERT INTO app.provider_mappings (
    id, service_template_version_id, adapter_version_id,
    provider_credential_id, environment, operation_code,
    provider_resource_ciphertext, provider_resource_fingerprint,
    output_policy, commercial_config_version, config_version,
    launch_evidence_id, state
  ) VALUES (
    p_mapping_id, current_attempt.service_template_version_id,
    current_attempt.adapter_version_id, current_attempt.provider_credential_id,
    current_attempt.environment, current_attempt.operation_code,
    p_mapping_ciphertext, p_mapping_fingerprint, p_output_policy,
    p_commercial_config_version, p_config_version, resolved_evidence_id,
    'disabled'
  );
  UPDATE app.provider_qualification_attempts
  SET review_state = 'approved', launch_evidence_id = resolved_evidence_id,
      provider_mapping_id = p_mapping_id, reviewed_by = p_reviewer,
      reviewed_at = clock_timestamp()
  WHERE id = p_qualification_id;
  INSERT INTO app.audit_events (action, target_type, target_id, outcome, safe_diff)
  VALUES (
    'provider.qualification.accept', 'provider_qualification', p_qualification_id,
    'approved', jsonb_build_object(
      'reviewer', p_reviewer,
      'operation_code', current_attempt.operation_code,
      'mapping_state', 'disabled'
    )
  );
  RETURN QUERY SELECT p_mapping_id, resolved_evidence_id;
END;
$$;

CREATE FUNCTION app.reject_amazon_provider_qualification(
  p_qualification_id uuid,
  p_reason text,
  p_reviewer text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF p_reason !~ '^[A-Z][A-Z0-9_]{2,63}$'
     OR p_reviewer !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$' THEN
    RAISE EXCEPTION 'QUALIFICATION_REJECTION_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  UPDATE app.provider_qualification_attempts
  SET review_state = 'rejected', reviewed_by = p_reviewer,
      reviewed_at = clock_timestamp()
  WHERE id = p_qualification_id AND review_state = 'pending' AND state <> 'running';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'QUALIFICATION_REJECTION_STATE_CONFLICT' USING ERRCODE = '55000';
  END IF;
  INSERT INTO app.audit_events (action, target_type, target_id, outcome, reason, safe_diff)
  VALUES (
    'provider.qualification.reject', 'provider_qualification', p_qualification_id,
    'rejected', p_reason, jsonb_build_object('reviewer', p_reviewer)
  );
  RETURN true;
END;
$$;

REVOKE ALL ON TABLE app.provider_qualification_attempts FROM PUBLIC;

REVOKE ALL ON FUNCTION app.begin_amazon_scraper_catalog_import(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.complete_amazon_scraper_catalog_import(uuid, jsonb, text, bytea, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.fail_amazon_scraper_catalog_import(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.review_amazon_scraper_catalog_candidate(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_amazon_qualification_candidate(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.begin_amazon_provider_qualification(uuid, uuid, text, text, text, bytea, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_amazon_qualification_acceptance_plan(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.complete_amazon_provider_qualification(uuid, text, text, text, bytea, text, bigint, integer, bytea, bytea, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.accept_amazon_provider_qualification(uuid, uuid, bytea, bytea, jsonb, text, text, text, bytea, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.reject_amazon_provider_qualification(uuid, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.begin_amazon_scraper_catalog_import(uuid, text, text, text) TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.complete_amazon_scraper_catalog_import(uuid, jsonb, text, bytea, text) TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.fail_amazon_scraper_catalog_import(uuid, text, text) TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.review_amazon_scraper_catalog_candidate(uuid, text, text) TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.resolve_amazon_qualification_candidate(uuid, text, text) TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.begin_amazon_provider_qualification(uuid, uuid, text, text, text, bytea, text) TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.resolve_amazon_qualification_acceptance_plan(uuid) TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.complete_amazon_provider_qualification(uuid, text, text, text, bytea, text, bigint, integer, bytea, bytea, text, text) TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.accept_amazon_provider_qualification(uuid, uuid, bytea, bytea, jsonb, text, text, text, bytea, text, timestamptz) TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.reject_amazon_provider_qualification(uuid, text, text) TO dhumi_operator;

RESET ROLE;
