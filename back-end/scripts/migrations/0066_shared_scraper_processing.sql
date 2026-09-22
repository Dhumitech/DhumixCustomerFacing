-- Versioned shared Scraper processing seam. No retailer is released here.
-- Existing adapter bytes, Template pointers, Services and mappings stay intact.
SET ROLE dhumi_owner;

INSERT INTO app.adapter_definitions (code, product_family)
VALUES ('bright_data.scraper_library.shared', 'scraper_library')
ON CONFLICT (code) DO NOTHING;

INSERT INTO app.adapter_versions (
  adapter_definition_id, semantic_version, capability_metadata,
  request_schema, result_schema, error_schema, code_artifact_digest, state
)
SELECT definition.id, '1.0.0-shared-scraper-processing',
  '{"processing_contract_version":1,"provider":"bright_data","automatic_submission_retries":0,"multipart":false,"operation_qualification_required":true}'::jsonb,
  '{"type":"object"}'::jsonb, '{"type":"array"}'::jsonb, '{"type":"object"}'::jsonb,
  decode('007f1a56c59ec83ff8d6c4e359cc7b6121edf4a6c9d93ad7565d86b178bbca7f', 'hex'), 'disabled'
FROM app.adapter_definitions AS definition
WHERE definition.code = 'bright_data.scraper_library.shared';

-- FORCE RLS also applies to a SECURITY DEFINER's NOLOGIN owner. These read-only
-- policies follow the shared protocol pin. Public Template identity reads are
-- family-scoped; querying version rows from that policy would recurse through
-- the existing version-to-Template RLS policy. Tenant-owned rows stay scoped.
CREATE POLICY template_versions_shared_scraper_owner_read ON app.service_template_versions
  FOR SELECT TO dhumi_owner USING (EXISTS (
    SELECT 1 FROM app.adapter_versions AS adapter
    JOIN app.adapter_definitions AS definition ON definition.id = adapter.adapter_definition_id
    WHERE adapter.id = app.service_template_versions.adapter_version_id AND definition.code = 'bright_data.scraper_library.shared'
      AND definition.product_family = 'scraper_library'
  ));
CREATE POLICY templates_shared_scraper_owner_read ON app.service_templates
  FOR SELECT TO dhumi_owner USING (product_family = 'scraper_library');
CREATE POLICY service_versions_shared_scraper_owner_read ON app.service_versions
  FOR SELECT TO dhumi_owner USING (tenant_id = app.current_tenant_id() AND EXISTS (
    SELECT 1 FROM app.service_template_versions AS version WHERE version.id = app.service_versions.service_template_version_id
      AND EXISTS (SELECT 1 FROM app.adapter_versions AS adapter
        JOIN app.adapter_definitions AS definition ON definition.id = adapter.adapter_definition_id
        WHERE adapter.id = version.adapter_version_id AND definition.code = 'bright_data.scraper_library.shared')
  ));
CREATE POLICY artifacts_shared_scraper_owner_read ON app.artifacts
  FOR SELECT TO dhumi_owner USING (tenant_id = app.current_tenant_id() AND kind = 'raw' AND EXISTS (
    SELECT 1 FROM app.runs AS run JOIN app.adapter_versions AS adapter ON adapter.id = run.adapter_version_id
    JOIN app.adapter_definitions AS definition ON definition.id = adapter.adapter_definition_id
    WHERE run.id = app.artifacts.run_id AND run.tenant_id = app.artifacts.tenant_id AND definition.code = 'bright_data.scraper_library.shared'
  ));

CREATE FUNCTION app.resolve_provider_executor_identity(p_run_id uuid, p_attempt_id uuid, p_fence_token uuid)
RETURNS TABLE (adapter_code text, adapter_version text, adapter_digest text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT definition.code, adapter.semantic_version, encode(adapter.code_artifact_digest, 'hex')
  FROM app.runs AS run
  JOIN app.run_attempts AS attempt ON attempt.tenant_id = run.tenant_id AND attempt.run_id = run.id
    AND attempt.adapter_version_id = run.adapter_version_id AND attempt.provider_mapping_id = run.provider_mapping_id
  JOIN app.adapter_versions AS adapter ON adapter.id = run.adapter_version_id
  JOIN app.adapter_definitions AS definition ON definition.id = adapter.adapter_definition_id
  WHERE run.tenant_id = app.require_tenant_context() AND run.id = p_run_id
    AND attempt.id = p_attempt_id AND attempt.state = 'claimed'
    AND attempt.kind IN ('submission','reconciliation')
    AND p_fence_token IS NOT NULL AND attempt.fence_token = p_fence_token
    AND attempt.worker_lease_expires_at > clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'RUN_EXECUTOR_IDENTITY_NOT_AVAILABLE' USING ERRCODE = 'P0002'; END IF;
END;
$$;

CREATE FUNCTION app.resolve_shared_scraper_admission_contract(p_template_version_id uuid, p_mapping_id uuid)
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
    AND adapter.semantic_version = '1.0.0-shared-scraper-processing'
    AND adapter.code_artifact_digest = decode('007f1a56c59ec83ff8d6c4e359cc7b6121edf4a6c9d93ad7565d86b178bbca7f','hex')
    AND adapter.state = 'enabled' AND mapping.state = 'enabled'
    AND template.state = 'published' AND version.availability_state = 'available';
  IF NOT FOUND THEN RAISE EXCEPTION 'SCRAPER_ADMISSION_CONTRACT_NOT_AVAILABLE' USING ERRCODE = 'P0002'; END IF;
END;
$$;

CREATE FUNCTION app.resolve_shared_scraper_execution_plan(
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
    AND adapter.semantic_version = '1.0.0-shared-scraper-processing'
    AND adapter.code_artifact_digest = decode('007f1a56c59ec83ff8d6c4e359cc7b6121edf4a6c9d93ad7565d86b178bbca7f','hex')
    AND (
      (p_phase = 'normalization' AND run.internal_status = 'PROCESSING'
        AND (attempt.kind = 'reconciliation' OR source.id = attempt.id)
        AND EXISTS (SELECT 1 FROM app.artifacts AS artifact WHERE artifact.tenant_id = run.tenant_id
          AND artifact.run_id = run.id AND artifact.attempt_id = source.id AND artifact.kind = 'raw' AND artifact.state = 'durable'))
      OR
      (p_phase IN ('submission','reconciliation') AND run.internal_status = 'SUBMITTED'
        AND adapter.state = 'enabled' AND mapping.state = 'enabled'
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

REVOKE ALL ON FUNCTION app.resolve_provider_executor_identity(uuid,uuid,uuid),
  app.resolve_shared_scraper_admission_contract(uuid,uuid),
  app.resolve_shared_scraper_execution_plan(uuid,uuid,uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_provider_executor_identity(uuid,uuid,uuid),
  app.resolve_shared_scraper_execution_plan(uuid,uuid,uuid,text,uuid) TO dhumi_job_manager;
GRANT EXECUTE ON FUNCTION app.resolve_shared_scraper_admission_contract(uuid,uuid) TO dhumi_admission;
RESET ROLE;
