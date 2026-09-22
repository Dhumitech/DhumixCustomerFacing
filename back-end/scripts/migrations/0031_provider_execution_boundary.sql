-- Pattern 5: expose one fenced private provider plan to the existing Job
-- Manager identity and persist protected provider references without granting
-- direct credential-table or Attempt mutation privileges.

SET ROLE dhumi_owner;

CREATE FUNCTION app.resolve_provider_execution_plan(
  p_run_id uuid,
  p_attempt_id uuid,
  p_fence_token uuid
)
RETURNS TABLE (
  mapping_id uuid,
  validated_input jsonb,
  operation_code text,
  provider_resource_ciphertext bytea,
  provider_resource_fingerprint bytea,
  output_policy jsonb,
  mapping_config_version text,
  provider_code text,
  provider_environment text,
  vault_secret_reference text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  resolved_tenant_id uuid;
BEGIN
  resolved_tenant_id := app.require_tenant_context();

  RETURN QUERY
  SELECT
    mapping.id,
    run.validated_input,
    mapping.operation_code,
    mapping.provider_resource_ciphertext,
    mapping.provider_resource_fingerprint,
    mapping.output_policy,
    mapping.config_version,
    credential.provider_code,
    credential.environment,
    credential.vault_secret_reference
  FROM app.runs AS run
  JOIN app.run_attempts AS attempt
    ON attempt.tenant_id = run.tenant_id
   AND attempt.run_id = run.id
  JOIN app.provider_mappings AS mapping
    ON mapping.id = run.provider_mapping_id
   AND mapping.id = attempt.provider_mapping_id
   AND mapping.adapter_version_id = run.adapter_version_id
   AND mapping.adapter_version_id = attempt.adapter_version_id
   AND mapping.service_template_version_id = run.service_template_version_id
   AND mapping.commercial_config_version = run.commercial_config_version
  JOIN app.provider_credentials AS credential
    ON credential.id = mapping.provider_credential_id
   AND credential.id = attempt.provider_credential_id
   AND credential.environment = mapping.environment
  WHERE run.tenant_id = resolved_tenant_id
    AND run.id = p_run_id
    AND run.internal_status = 'SUBMITTED'
    AND attempt.id = p_attempt_id
    AND attempt.kind = 'submission'
    AND attempt.state = 'claimed'
    AND attempt.fence_token = p_fence_token
    AND attempt.worker_lease_expires_at > clock_timestamp()
    AND mapping.state = 'enabled'
    AND credential.state = 'active'
    AND credential.activated_at IS NOT NULL
    AND credential.activated_at <= clock_timestamp()
    AND (credential.expires_at IS NULL OR credential.expires_at > clock_timestamp())
    AND credential.retired_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RUN_PROVIDER_EXECUTION_PLAN_NOT_AVAILABLE'
      USING ERRCODE = 'P0002';
  END IF;
END;
$$;

CREATE FUNCTION app.record_provider_reference_fenced(
  p_run_id uuid,
  p_attempt_id uuid,
  p_fence_token uuid,
  p_provider_reference_ciphertext bytea,
  p_provider_reference_fingerprint bytea
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  resolved_tenant_id uuid;
  current_attempt app.run_attempts%ROWTYPE;
BEGIN
  resolved_tenant_id := app.require_tenant_context();

  IF p_provider_reference_ciphertext IS NULL
     OR octet_length(p_provider_reference_ciphertext) < 30
     OR octet_length(p_provider_reference_ciphertext) > 4096
     OR p_provider_reference_fingerprint IS NULL
     OR octet_length(p_provider_reference_fingerprint) <> 32 THEN
    RAISE EXCEPTION 'RUN_PROVIDER_REFERENCE_INVALID'
      USING ERRCODE = '22023';
  END IF;

  SELECT attempt.*
    INTO current_attempt
  FROM app.run_attempts AS attempt
  WHERE attempt.tenant_id = resolved_tenant_id
    AND attempt.run_id = p_run_id
    AND attempt.id = p_attempt_id
  FOR UPDATE;

  IF NOT FOUND
     OR current_attempt.kind <> 'submission'
     OR current_attempt.state <> 'claimed'
     OR current_attempt.fence_token <> p_fence_token
     OR current_attempt.worker_lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'RUN_ATTEMPT_FENCE_REJECTED'
      USING ERRCODE = 'P0001';
  END IF;

  IF current_attempt.provider_reference_fingerprint IS NOT NULL THEN
    IF current_attempt.provider_reference_fingerprint = p_provider_reference_fingerprint THEN
      RETURN true;
    END IF;
    RAISE EXCEPTION 'RUN_PROVIDER_REFERENCE_CONFLICT'
      USING ERRCODE = '23505';
  END IF;

  UPDATE app.run_attempts AS attempt
  SET
    provider_reference_ciphertext = p_provider_reference_ciphertext,
    provider_reference_fingerprint = p_provider_reference_fingerprint,
    updated_at = clock_timestamp()
  WHERE attempt.id = current_attempt.id
    AND attempt.tenant_id = resolved_tenant_id
    AND attempt.fence_token = p_fence_token
    AND attempt.state = 'claimed'
    AND attempt.worker_lease_expires_at > clock_timestamp();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RUN_ATTEMPT_FENCE_REJECTED'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN true;
END;
$$;

CREATE FUNCTION app.resolve_provider_reconciliation_plan(
  p_run_id uuid,
  p_reconciliation_attempt_id uuid,
  p_reconciliation_fence_token uuid
)
RETURNS TABLE (
  source_attempt_id uuid,
  mapping_id uuid,
  source_provider_reference_ciphertext bytea,
  source_provider_reference_fingerprint bytea,
  validated_input jsonb,
  operation_code text,
  provider_resource_ciphertext bytea,
  provider_resource_fingerprint bytea,
  output_policy jsonb,
  mapping_config_version text,
  provider_code text,
  provider_environment text,
  vault_secret_reference text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  resolved_tenant_id uuid;
BEGIN
  resolved_tenant_id := app.require_tenant_context();

  RETURN QUERY
  WITH reconciliation_attempt AS (
    SELECT attempt.*
    FROM app.run_attempts AS attempt
    WHERE attempt.tenant_id = resolved_tenant_id
      AND attempt.run_id = p_run_id
      AND attempt.id = p_reconciliation_attempt_id
      AND attempt.kind = 'reconciliation'
      AND attempt.state = 'claimed'
      AND attempt.fence_token = p_reconciliation_fence_token
      AND attempt.worker_lease_expires_at > clock_timestamp()
  ), source_attempt AS (
    SELECT attempt.*
    FROM app.run_attempts AS attempt
    WHERE attempt.tenant_id = resolved_tenant_id
      AND attempt.run_id = p_run_id
      AND attempt.kind = 'submission'
      AND attempt.provider_reference_ciphertext IS NOT NULL
      AND attempt.provider_reference_fingerprint IS NOT NULL
    ORDER BY attempt.attempt_number DESC, attempt.started_at DESC, attempt.id DESC
    LIMIT 1
  )
  SELECT
    source_attempt.id,
    mapping.id,
    source_attempt.provider_reference_ciphertext,
    source_attempt.provider_reference_fingerprint,
    run.validated_input,
    mapping.operation_code,
    mapping.provider_resource_ciphertext,
    mapping.provider_resource_fingerprint,
    mapping.output_policy,
    mapping.config_version,
    credential.provider_code,
    credential.environment,
    credential.vault_secret_reference
  FROM reconciliation_attempt
  CROSS JOIN source_attempt
  JOIN app.runs AS run
    ON run.tenant_id = resolved_tenant_id
   AND run.id = p_run_id
  JOIN app.provider_mappings AS mapping
    ON mapping.id = run.provider_mapping_id
   AND mapping.id = reconciliation_attempt.provider_mapping_id
   AND mapping.id = source_attempt.provider_mapping_id
   AND mapping.adapter_version_id = run.adapter_version_id
   AND mapping.adapter_version_id = reconciliation_attempt.adapter_version_id
   AND mapping.adapter_version_id = source_attempt.adapter_version_id
   AND mapping.service_template_version_id = run.service_template_version_id
   AND mapping.commercial_config_version = run.commercial_config_version
  JOIN app.provider_credentials AS credential
    ON credential.id = mapping.provider_credential_id
   AND credential.id = reconciliation_attempt.provider_credential_id
   AND credential.id = source_attempt.provider_credential_id
   AND credential.environment = mapping.environment
  WHERE run.internal_status = 'SUBMITTED'
    AND mapping.state = 'enabled'
    AND credential.state = 'active'
    AND credential.activated_at IS NOT NULL
    AND credential.activated_at <= clock_timestamp()
    AND (credential.expires_at IS NULL OR credential.expires_at > clock_timestamp())
    AND credential.retired_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RUN_PROVIDER_RECONCILIATION_PLAN_NOT_AVAILABLE'
      USING ERRCODE = 'P0002';
  END IF;
END;
$$;

CREATE FUNCTION app.is_run_cancellation_requested_fenced(
  p_run_id uuid,
  p_attempt_id uuid,
  p_fence_token uuid
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM app.runs AS run
    JOIN app.run_attempts AS attempt
      ON attempt.tenant_id = run.tenant_id
     AND attempt.run_id = run.id
    WHERE run.tenant_id = app.require_tenant_context()
      AND run.id = p_run_id
      AND attempt.id = p_attempt_id
      AND attempt.state = 'claimed'
      AND attempt.fence_token = p_fence_token
      AND attempt.worker_lease_expires_at > clock_timestamp()
      AND EXISTS (
        SELECT 1
        FROM app.run_events AS event
        WHERE event.tenant_id = run.tenant_id
          AND event.run_id = run.id
          AND event.event_type = 'cancellation_requested'
      )
  );
$$;

REVOKE ALL ON FUNCTION app.resolve_provider_execution_plan(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.record_provider_reference_fenced(uuid, uuid, uuid, bytea, bytea)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_provider_reconciliation_plan(uuid, uuid, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app.is_run_cancellation_requested_fenced(uuid, uuid, uuid)
  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.resolve_provider_execution_plan(uuid, uuid, uuid),
  app.record_provider_reference_fenced(uuid, uuid, uuid, bytea, bytea),
  app.resolve_provider_reconciliation_plan(uuid, uuid, uuid),
  app.is_run_cancellation_requested_fenced(uuid, uuid, uuid)
  TO dhumi_job_manager;

-- Pattern 5 deliberately creates no LOGIN or capability role. Direct access to
-- the credential registry remains revoked; the existing Job Manager can only
-- resolve the one exact credential reference pinned to its live fenced Run.
REVOKE SELECT ON app.provider_credentials FROM dhumi_job_manager;

RESET ROLE;
