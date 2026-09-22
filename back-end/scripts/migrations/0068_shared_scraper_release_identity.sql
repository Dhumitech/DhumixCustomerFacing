-- One protocol release identity is shared by every qualified scraper operation.
-- Draft version 1.0.0 remains immutable and disabled. This migration creates
-- no Template pointer, provider mapping, Service, Run or provider request.
SET ROLE dhumi_owner;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.adapter_versions AS adapter
    JOIN app.adapter_definitions AS definition ON definition.id = adapter.adapter_definition_id
    WHERE definition.code = 'bright_data.scraper_library.shared'
      AND adapter.semantic_version = '1.0.0-shared-scraper-processing'
      AND adapter.state = 'disabled'
      AND adapter.code_artifact_digest = decode('007f1a56c59ec83ff8d6c4e359cc7b6121edf4a6c9d93ad7565d86b178bbca7f','hex')
  ) THEN
    RAISE EXCEPTION 'SHARED_SCRAPER_DRAFT_ADAPTER_MISMATCH' USING ERRCODE = '55000';
  END IF;
END;
$$;

INSERT INTO app.adapter_versions (
  adapter_definition_id, semantic_version, capability_metadata,
  request_schema, result_schema, error_schema, code_artifact_digest, state
)
SELECT definition.id, '1.1.0-shared-scraper-release',
  '{"processing_contract_version":1,"provider":"bright_data","automatic_submission_retries":0,"multipart":false,"operation_qualification_required":true}'::jsonb,
  '{"type":"object"}'::jsonb, '{"type":"array"}'::jsonb, '{"type":"object"}'::jsonb,
  decode('94cc1cb6132f65b60101964647087d967dbd57dae7c3a51610b184151928846a','hex'), 'enabled'
FROM app.adapter_definitions AS definition
WHERE definition.code = 'bright_data.scraper_library.shared'
ON CONFLICT (adapter_definition_id, semantic_version) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.adapter_versions AS adapter
    JOIN app.adapter_definitions AS definition ON definition.id = adapter.adapter_definition_id
    WHERE definition.code = 'bright_data.scraper_library.shared'
      AND adapter.semantic_version = '1.1.0-shared-scraper-release'
      AND adapter.state = 'enabled'
      AND adapter.code_artifact_digest = decode('94cc1cb6132f65b60101964647087d967dbd57dae7c3a51610b184151928846a','hex')
  ) THEN
    RAISE EXCEPTION 'SHARED_SCRAPER_RELEASE_ADAPTER_MISMATCH' USING ERRCODE = '55000';
  END IF;
END;
$$;

-- Admission must inspect the public semantic pin, not private adapter schemas.
GRANT SELECT (semantic_version) ON app.adapter_versions TO dhumi_admission;
GRANT SELECT (adapter_definition_id) ON app.adapter_versions TO dhumi_admission;
GRANT SELECT (id, code) ON app.adapter_definitions TO dhumi_admission;

CREATE OR REPLACE FUNCTION app.resolve_shared_scraper_admission_contract(p_template_version_id uuid, p_mapping_id uuid)
RETURNS TABLE (adapter_code text, adapter_digest text, operation_code text,
  input_schema jsonb, output_schema jsonb, processing jsonb, contract_hash text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  PERFORM app.require_tenant_context();
  RETURN QUERY
  SELECT definition.code, encode(adapter.code_artifact_digest,'hex'), mapping.operation_code,
    version.input_schema, version.output_schema,
    mapping.output_policy->'scraper_processing', mapping.output_policy->>'scraper_contract_sha256'
  FROM app.service_template_versions AS version
  JOIN app.service_templates AS template ON template.id = version.service_template_id
  JOIN app.adapter_versions AS adapter ON adapter.id = version.adapter_version_id
  JOIN app.adapter_definitions AS definition ON definition.id = adapter.adapter_definition_id
  JOIN app.provider_mappings AS mapping ON mapping.service_template_version_id = version.id AND mapping.adapter_version_id = adapter.id
  WHERE version.id = p_template_version_id AND mapping.id = p_mapping_id
    AND definition.code = 'bright_data.scraper_library.shared' AND definition.product_family = 'scraper_library'
    AND adapter.semantic_version = '1.1.0-shared-scraper-release'
    AND adapter.code_artifact_digest = decode('94cc1cb6132f65b60101964647087d967dbd57dae7c3a51610b184151928846a','hex')
    AND adapter.state = 'enabled' AND mapping.state = 'enabled'
    AND template.state = 'published' AND version.availability_state = 'available';
  IF NOT FOUND THEN RAISE EXCEPTION 'SCRAPER_ADMISSION_CONTRACT_NOT_AVAILABLE' USING ERRCODE = 'P0002'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION app.resolve_shared_scraper_execution_plan(
  p_run_id uuid, p_attempt_id uuid, p_fence_token uuid, p_phase text, p_source_attempt_id uuid
)
RETURNS TABLE (
  adapter_code text, adapter_version text, adapter_digest text,
  operation_code text, input_schema jsonb, output_schema jsonb, output_policy jsonb,
  validated_input jsonb, provider_environment text, provider_resource_aad_mapping_id uuid,
  provider_resource_ciphertext bytea, provider_resource_fingerprint bytea, vault_secret_reference text,
  source_attempt_id uuid, source_provider_reference_ciphertext bytea, source_provider_reference_fingerprint bytea
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF p_phase IS NULL OR p_phase NOT IN ('submission','normalization','reconciliation') THEN
    RAISE EXCEPTION 'SCRAPER_EXECUTION_PHASE_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT definition.code, adapter.semantic_version, encode(adapter.code_artifact_digest,'hex'),
    mapping.operation_code, version.input_schema, version.output_schema, mapping.output_policy,
    run.validated_input, credential.environment, mapping.provider_resource_aad_mapping_id,
    CASE WHEN p_phase = 'normalization' THEN NULL ELSE mapping.provider_resource_ciphertext END,
    CASE WHEN p_phase = 'normalization' THEN NULL ELSE mapping.provider_resource_fingerprint END,
    CASE WHEN p_phase = 'normalization' THEN NULL ELSE credential.vault_secret_reference END,
    source.id,
    CASE WHEN p_phase = 'reconciliation' THEN source.provider_reference_ciphertext ELSE NULL END,
    CASE WHEN p_phase = 'reconciliation' THEN source.provider_reference_fingerprint ELSE NULL END
  FROM app.runs AS run
  JOIN app.run_attempts AS attempt ON attempt.tenant_id = run.tenant_id AND attempt.run_id = run.id
    AND attempt.adapter_version_id = run.adapter_version_id AND attempt.provider_mapping_id = run.provider_mapping_id
  JOIN app.run_attempts AS source ON source.tenant_id = run.tenant_id AND source.run_id = run.id
    AND source.kind = 'submission' AND source.adapter_version_id = run.adapter_version_id AND source.provider_mapping_id = run.provider_mapping_id
  JOIN app.service_versions AS service_version ON service_version.id = run.service_version_id AND service_version.tenant_id = run.tenant_id
  JOIN app.service_template_versions AS version ON version.id = run.service_template_version_id
    AND version.id = service_version.service_template_version_id AND version.adapter_version_id = run.adapter_version_id
  JOIN app.adapter_versions AS adapter ON adapter.id = run.adapter_version_id
  JOIN app.adapter_definitions AS definition ON definition.id = adapter.adapter_definition_id
  JOIN app.provider_mappings AS mapping ON mapping.id = run.provider_mapping_id AND mapping.adapter_version_id = run.adapter_version_id
    AND mapping.service_template_version_id = version.id AND mapping.commercial_config_version = run.commercial_config_version
  JOIN app.provider_mappings AS aad_mapping ON aad_mapping.id = mapping.provider_resource_aad_mapping_id
    AND aad_mapping.operation_code = mapping.operation_code AND aad_mapping.environment = mapping.environment
    AND aad_mapping.provider_credential_id = mapping.provider_credential_id AND aad_mapping.config_version = mapping.config_version
    AND aad_mapping.provider_resource_ciphertext = mapping.provider_resource_ciphertext
    AND aad_mapping.provider_resource_fingerprint = mapping.provider_resource_fingerprint
  JOIN app.provider_credentials AS credential ON credential.id = mapping.provider_credential_id
    AND credential.id = attempt.provider_credential_id AND credential.id = source.provider_credential_id
    AND credential.environment = mapping.environment AND credential.provider_code = 'bright_data'
  WHERE run.tenant_id = app.require_tenant_context() AND run.id = p_run_id
    AND attempt.id = p_attempt_id AND attempt.state = 'claimed' AND attempt.kind IN ('submission','reconciliation')
    AND p_fence_token IS NOT NULL AND attempt.fence_token = p_fence_token AND attempt.worker_lease_expires_at > clock_timestamp()
    AND source.id = p_source_attempt_id
    AND definition.code = 'bright_data.scraper_library.shared' AND definition.product_family = 'scraper_library'
    AND adapter.semantic_version = '1.1.0-shared-scraper-release'
    AND adapter.code_artifact_digest = decode('94cc1cb6132f65b60101964647087d967dbd57dae7c3a51610b184151928846a','hex')
    AND (
      (p_phase = 'normalization' AND run.internal_status = 'PROCESSING'
        AND (attempt.kind = 'reconciliation' OR source.id = attempt.id)
        AND EXISTS (SELECT 1 FROM app.artifacts AS artifact WHERE artifact.tenant_id = run.tenant_id
          AND artifact.run_id = run.id AND artifact.attempt_id = source.id AND artifact.kind = 'raw' AND artifact.state = 'durable'))
      OR
      (p_phase IN ('submission','reconciliation') AND run.internal_status = 'SUBMITTED'
        AND adapter.state = 'enabled' AND mapping.state = 'enabled'
        AND EXISTS (
          SELECT 1 FROM app.launch_evidence AS commercial_evidence
          WHERE commercial_evidence.id::text = mapping.output_policy->'scraper_spending'->>'evidenceId'
            AND commercial_evidence.scope_type = 'scraper_commercial'
            AND commercial_evidence.scope_key = mapping.id::text
            AND commercial_evidence.state = 'approved'
            AND commercial_evidence.approved_by IS NOT NULL AND commercial_evidence.approved_at IS NOT NULL
            AND commercial_evidence.effective_at IS NOT NULL
            AND commercial_evidence.effective_at <= clock_timestamp()
            AND (commercial_evidence.expires_at IS NULL OR commercial_evidence.expires_at > clock_timestamp())
            AND commercial_evidence.evidence_hash = sha256(convert_to(
              ((mapping.output_policy->'scraper_spending') - 'evidenceId')::text, 'UTF8'))
        )
        AND credential.state = 'active' AND credential.activated_at IS NOT NULL AND credential.activated_at <= clock_timestamp()
        AND (credential.expires_at IS NULL OR credential.expires_at > clock_timestamp()) AND credential.retired_at IS NULL
        AND (
          (p_phase = 'submission' AND attempt.kind = 'submission' AND source.id = attempt.id)
          OR (p_phase = 'reconciliation' AND attempt.kind = 'reconciliation' AND source.state = 'ambiguous'
            AND source.provider_reference_ciphertext IS NOT NULL AND source.provider_reference_fingerprint IS NOT NULL)
        ))
    );
  IF NOT FOUND THEN RAISE EXCEPTION 'SHARED_SCRAPER_EXECUTION_PLAN_NOT_AVAILABLE' USING ERRCODE = 'P0002'; END IF;
END;
$$;

-- Existing narrow EXECUTE grants remain on these replaced function signatures.
RESET ROLE;
