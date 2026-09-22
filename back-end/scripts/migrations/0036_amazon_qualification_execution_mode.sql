-- Pattern 7 correction: bind every provider qualification and accepted mapping
-- to the exact private Bright Data submission endpoint that was qualified.
-- Existing attempts predate explicit selection and are classified as scrape,
-- which was the only endpoint used by the v1 operator. No role is created.

SET ROLE dhumi_owner;

ALTER TABLE app.provider_qualification_attempts
  ADD COLUMN provider_execution_mode text NOT NULL DEFAULT 'scrape',
  ADD CONSTRAINT provider_qualification_execution_mode_check
    CHECK (provider_execution_mode IN ('scrape', 'trigger'));

CREATE FUNCTION app.begin_amazon_provider_qualification_v2(
  p_qualification_id uuid,
  p_candidate_id uuid,
  p_operation_code text,
  p_environment text,
  p_provider_execution_mode text,
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
     OR p_provider_execution_mode NOT IN ('scrape', 'trigger')
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
    id, operation_code, environment, provider_execution_mode,
    service_template_version_id, adapter_version_id, provider_credential_id,
    catalog_candidate_id, request_object_key, request_checksum, created_by
  ) VALUES (
    p_qualification_id, p_operation_code, p_environment, p_provider_execution_mode,
    candidate_plan.service_template_version_id, candidate_plan.adapter_version_id,
    candidate_plan.provider_credential_id, p_candidate_id, p_request_object_key,
    p_request_checksum, p_actor
  );

  INSERT INTO app.audit_events (action, target_type, target_id, outcome, safe_diff)
  VALUES (
    'provider.qualification.begin', 'provider_qualification', p_qualification_id,
    'accepted', jsonb_build_object(
      'actor', p_actor,
      'operation_code', p_operation_code,
      'provider_execution_mode', p_provider_execution_mode
    )
  );
  RETURN true;
END;
$$;

CREATE FUNCTION app.resolve_amazon_qualification_acceptance_plan_v2(
  p_qualification_id uuid
)
RETURNS TABLE (
  candidate_id uuid,
  operation_code text,
  environment text,
  provider_execution_mode text,
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
    attempt.provider_execution_mode,
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

CREATE FUNCTION app.accept_amazon_provider_qualification_v2(
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
  policy_execution_mode text;
BEGIN
  policy_execution_mode := p_output_policy #>> '{provider_submission,endpoint}';

  IF p_mapping_id IS NULL
     OR p_mapping_ciphertext IS NULL OR octet_length(p_mapping_ciphertext) < 30
     OR p_mapping_fingerprint IS NULL OR octet_length(p_mapping_fingerprint) <> 32
     OR jsonb_typeof(p_output_policy) <> 'object'
     OR NOT (p_output_policy ? 'provider_submission'
             AND p_output_policy ? 'provider_request'
             AND p_output_policy ? 'snapshot'
             AND p_output_policy ? 'normalizer_code'
             AND p_output_policy ? 'normalizer_version'
             AND p_output_policy ? 'normalized_schema_version')
     OR jsonb_typeof(p_output_policy->'provider_submission') <> 'object'
     OR COALESCE(policy_execution_mode, '') NOT IN ('scrape', 'trigger')
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
  WHERE id = p_qualification_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'QUALIFICATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF current_attempt.state <> 'succeeded' OR current_attempt.review_state <> 'pending' THEN
    RAISE EXCEPTION 'QUALIFICATION_ACCEPTANCE_STATE_CONFLICT' USING ERRCODE = '55000';
  END IF;
  IF policy_execution_mode <> current_attempt.provider_execution_mode THEN
    RAISE EXCEPTION 'QUALIFICATION_EXECUTION_MODE_MISMATCH' USING ERRCODE = '22023';
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
      'provider_execution_mode', current_attempt.provider_execution_mode,
      'mapping_state', 'disabled'
    )
  );

  RETURN QUERY SELECT p_mapping_id, resolved_evidence_id;
END;
$$;

-- The v1 functions remain for historical migration compatibility, but the
-- runtime operator can no longer create or accept endpoint-unbound attempts.
REVOKE EXECUTE ON FUNCTION app.begin_amazon_provider_qualification(
  uuid, uuid, text, text, text, bytea, text
) FROM dhumi_operator;
REVOKE EXECUTE ON FUNCTION app.resolve_amazon_qualification_acceptance_plan(uuid)
  FROM dhumi_operator;
REVOKE EXECUTE ON FUNCTION app.accept_amazon_provider_qualification(
  uuid, uuid, bytea, bytea, jsonb, text, text, text, bytea, text, timestamptz
) FROM dhumi_operator;

REVOKE ALL ON FUNCTION app.begin_amazon_provider_qualification_v2(
  uuid, uuid, text, text, text, text, bytea, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_amazon_qualification_acceptance_plan_v2(uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app.accept_amazon_provider_qualification_v2(
  uuid, uuid, bytea, bytea, jsonb, text, text, text, bytea, text, timestamptz
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.begin_amazon_provider_qualification_v2(
  uuid, uuid, text, text, text, text, bytea, text
) TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.resolve_amazon_qualification_acceptance_plan_v2(uuid)
  TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.accept_amazon_provider_qualification_v2(
  uuid, uuid, bytea, bytea, jsonb, text, text, text, bytea, text, timestamptz
) TO dhumi_operator;

RESET ROLE;
