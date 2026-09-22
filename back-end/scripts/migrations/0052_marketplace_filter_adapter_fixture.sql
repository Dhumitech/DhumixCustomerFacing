-- M7: customer-disabled Marketplace Filter/Snapshot adapter contract.
--
-- The only executable transport admitted by this version is fixture. This
-- migration creates no public Template pointer, provider mapping, entitlement,
-- Service, Run, outbox event, API route, database LOGIN, or provider request.

SET ROLE dhumi_owner;

INSERT INTO app.adapter_definitions (code, product_family)
VALUES ('bright_data.marketplace.filter', 'marketplace_dataset')
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
  '1.0.0-m7-fixture',
  '{
    "provider":"bright_data",
    "product_family":"marketplace_dataset",
    "operation":"filter",
    "transport":"fixture",
    "provider_http_enabled":false,
    "customer_visible":false,
    "can_purchase":false,
    "can_execute":false,
    "can_publish":false,
    "automatic_submission_retries":0
  }'::jsonb,
  '{
    "$schema":"https://json-schema.org/draft/2020-12/schema",
    "type":"object",
    "additionalProperties":false,
    "required":["dataset_id","records_limit","filter"],
    "properties":{
      "dataset_id":{"type":"string","minLength":1,"maxLength":512},
      "records_limit":{"type":"integer","minimum":1},
      "filter":{"type":"object"}
    }
  }'::jsonb,
  '{
    "$schema":"https://json-schema.org/draft/2020-12/schema",
    "type":"object",
    "additionalProperties":false,
    "required":["snapshot_id"],
    "properties":{"snapshot_id":{"type":"string","minLength":1,"maxLength":512}}
  }'::jsonb,
  '{
    "$schema":"https://json-schema.org/draft/2020-12/schema",
    "type":"object",
    "additionalProperties":false,
    "required":["code"],
    "properties":{"code":{"type":"string"}}
  }'::jsonb,
  -- SHA-256 over the ordered M7 execution source set documented in ADR 0011.
  decode('a5545e0016e38071abf59bf01a3520ebb529d7e1f14f367f10dde9b9e534e2ab', 'hex'),
  'disabled'
FROM app.adapter_definitions AS definition
WHERE definition.code = 'bright_data.marketplace.filter'
ON CONFLICT (adapter_definition_id, semantic_version) DO NOTHING;

ALTER TABLE app.run_attempts
  ADD COLUMN provider_dataset_size bigint CHECK (provider_dataset_size >= 0),
  ADD COLUMN provider_file_size bigint CHECK (provider_file_size >= 0),
  ADD COLUMN provider_cost_micros bigint CHECK (provider_cost_micros >= 0),
  ADD COLUMN provider_cost_currency text
    CHECK (provider_cost_currency IS NULL OR provider_cost_currency ~ '^[A-Z]{3}$'),
  ADD COLUMN provider_metadata_observed_at timestamptz;

ALTER TABLE app.run_attempts
  ADD CONSTRAINT run_attempts_provider_observation_coherence_check
  CHECK (
    (provider_metadata_observed_at IS NULL
      AND provider_dataset_size IS NULL
      AND provider_file_size IS NULL
      AND provider_cost_micros IS NULL
      AND provider_cost_currency IS NULL)
    OR
    (provider_metadata_observed_at IS NOT NULL
      AND (provider_cost_micros IS NULL OR provider_cost_currency IS NOT NULL))
  );

CREATE FUNCTION app.resolve_provider_executor_kind(
  p_run_id uuid,
  p_attempt_id uuid,
  p_fence_token uuid
)
RETURNS TABLE (adapter_code text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  resolved_tenant_id uuid := app.require_tenant_context();
BEGIN
  RETURN QUERY
  SELECT definition.code
  FROM app.runs AS run
  JOIN app.run_attempts AS attempt
    ON attempt.tenant_id = run.tenant_id
   AND attempt.run_id = run.id
   AND attempt.adapter_version_id = run.adapter_version_id
  JOIN app.adapter_versions AS adapter ON adapter.id = run.adapter_version_id
  JOIN app.adapter_definitions AS definition
    ON definition.id = adapter.adapter_definition_id
  WHERE run.id = p_run_id
    AND run.tenant_id = resolved_tenant_id
    AND attempt.id = p_attempt_id
    AND attempt.state = 'claimed'
    AND attempt.kind IN ('submission', 'reconciliation')
    AND p_fence_token IS NOT NULL
    AND attempt.fence_token = p_fence_token
    AND attempt.worker_lease_expires_at > clock_timestamp()
    AND definition.code IN (
      'bright_data.amazon.scraper_library',
      'bright_data.marketplace.filter'
    );
END;
$$;

-- Extend the existing durable poll checkpoint with the exact Marketplace
-- Snapshot states documented by GET /datasets/snapshots/{id}.
CREATE OR REPLACE FUNCTION app.checkpoint_provider_poll_fenced(
  p_run_id uuid, p_attempt_id uuid, p_fence_token uuid, p_source_attempt_id uuid,
  p_max_elapsed_ms integer, p_status text DEFAULT NULL,
  p_failure boolean DEFAULT NULL, p_delay_ms bigint DEFAULT 0
)
RETURNS TABLE (remaining_ms bigint, wait_ms bigint, consecutive_failures integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  tenant uuid := app.require_tenant_context();
  owner_attempt app.run_attempts%ROWTYPE;
  source_attempt app.run_attempts%ROWTYPE;
  observed_at timestamptz := clock_timestamp();
BEGIN
  IF p_max_elapsed_ms IS NULL OR p_delay_ms IS NULL
    OR p_max_elapsed_ms NOT BETWEEN 1 AND 86400000 OR p_delay_ms < 0
    OR p_delay_ms > 9007199254740991
    OR (p_status IS NOT NULL AND p_status NOT IN (
      'starting', 'running', 'scheduled', 'building', 'ready', 'failed', 'canceled',
      'not_ready', 'missing', 'unknown', 'read_failed', 'rate_limited'
    )) THEN
    RAISE EXCEPTION 'PROVIDER_POLL_CHECKPOINT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM app.runs WHERE id = p_run_id AND tenant_id = tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RUN_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO owner_attempt FROM app.run_attempts
    WHERE id = p_attempt_id AND tenant_id = tenant AND run_id = p_run_id FOR UPDATE;
  IF NOT FOUND OR owner_attempt.state <> 'claimed'
    OR p_fence_token IS NULL OR owner_attempt.fence_token <> p_fence_token
    OR owner_attempt.worker_lease_expires_at IS NULL
    OR owner_attempt.worker_lease_expires_at <= clock_timestamp()
    OR owner_attempt.kind NOT IN ('submission', 'reconciliation') THEN
    RAISE EXCEPTION 'RUN_ATTEMPT_FENCE_REJECTED' USING ERRCODE = '40001';
  END IF;
  SELECT * INTO source_attempt FROM app.run_attempts
    WHERE id = p_source_attempt_id AND tenant_id = tenant AND run_id = p_run_id
      AND kind = 'submission' FOR UPDATE;
  IF NOT FOUND OR source_attempt.provider_reference_ciphertext IS NULL
    OR source_attempt.provider_reference_fingerprint IS NULL
    OR (owner_attempt.kind = 'submission' AND source_attempt.id <> owner_attempt.id)
    OR (owner_attempt.kind = 'reconciliation' AND source_attempt.state <> 'ambiguous') THEN
    RAISE EXCEPTION 'PROVIDER_POLL_SOURCE_REJECTED' USING ERRCODE = '40001';
  END IF;
  UPDATE app.run_attempts AS source SET
    provider_poll_deadline = COALESCE(source.provider_poll_deadline,
      source.started_at + p_max_elapsed_ms * interval '1 millisecond'),
    provider_last_status = COALESCE(p_status, source.provider_last_status),
    provider_consecutive_failures = CASE
      WHEN p_failure IS TRUE THEN LEAST(source.provider_consecutive_failures + 1, 1000000)
      WHEN p_failure IS FALSE THEN 0 ELSE source.provider_consecutive_failures END,
    provider_next_poll_at = CASE WHEN p_status IS NULL THEN source.provider_next_poll_at
      ELSE observed_at + LEAST(p_delay_ms, 86400000) * interval '1 millisecond' END,
    updated_at = observed_at
    WHERE source.id = p_source_attempt_id AND source.tenant_id = tenant
    RETURNING * INTO source_attempt;
  RETURN QUERY SELECT
    floor(extract(epoch FROM (source_attempt.provider_poll_deadline - clock_timestamp())) * 1000)::bigint,
    GREATEST(0, ceil(extract(epoch FROM (COALESCE(source_attempt.provider_next_poll_at, observed_at) - clock_timestamp())) * 1000)::bigint),
    source_attempt.provider_consecutive_failures;
END;
$$;

CREATE FUNCTION app.resolve_marketplace_execution_plan_fixture(
  p_run_id uuid,
  p_attempt_id uuid,
  p_fence_token uuid,
  p_reconciliation boolean DEFAULT false,
  p_source_attempt_id uuid DEFAULT NULL
)
RETURNS TABLE (
  mapping_id uuid,
  provider_resource_aad_mapping_id uuid,
  validated_input jsonb,
  validated_configuration jsonb,
  template_slug text,
  template_version integer,
  template_output_schema jsonb,
  adapter_code text,
  provider_resource_ciphertext bytea,
  provider_resource_fingerprint bytea,
  output_policy jsonb,
  provider_code text,
  provider_environment text,
  vault_secret_reference text,
  source_attempt_id uuid,
  source_provider_reference_ciphertext bytea,
  source_provider_reference_fingerprint bytea
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  resolved_tenant_id uuid := app.require_tenant_context();
BEGIN
  RETURN QUERY
  SELECT
    mapping.id,
    mapping.provider_resource_aad_mapping_id,
    run.validated_input,
    service_version.validated_configuration,
    template.slug,
    template_version.version,
    template_version.output_schema,
    definition.code,
    mapping.provider_resource_ciphertext,
    mapping.provider_resource_fingerprint,
    mapping.output_policy,
    credential.provider_code,
    credential.environment,
    credential.vault_secret_reference,
    source_attempt.id,
    source_attempt.provider_reference_ciphertext,
    source_attempt.provider_reference_fingerprint
  FROM app.runs AS run
  JOIN app.run_attempts AS owner_attempt
    ON owner_attempt.tenant_id = run.tenant_id
   AND owner_attempt.run_id = run.id
  JOIN app.run_attempts AS source_attempt
    ON source_attempt.tenant_id = run.tenant_id
   AND source_attempt.run_id = run.id
   AND source_attempt.kind = 'submission'
  JOIN app.service_versions AS service_version
    ON service_version.tenant_id = run.tenant_id
   AND service_version.id = run.service_version_id
  JOIN app.service_template_versions AS template_version
    ON template_version.id = run.service_template_version_id
   AND template_version.id = service_version.service_template_version_id
  JOIN app.service_templates AS template
    ON template.id = template_version.service_template_id
  JOIN app.adapter_versions AS adapter ON adapter.id = run.adapter_version_id
  JOIN app.adapter_definitions AS definition
    ON definition.id = adapter.adapter_definition_id
  JOIN app.provider_mappings AS mapping
    ON mapping.id = run.provider_mapping_id
   AND mapping.adapter_version_id = run.adapter_version_id
   AND mapping.service_template_version_id = run.service_template_version_id
  JOIN app.provider_credentials AS credential
    ON credential.id = mapping.provider_credential_id
   AND credential.id = owner_attempt.provider_credential_id
  WHERE run.id = p_run_id
    AND run.tenant_id = resolved_tenant_id
    AND owner_attempt.id = p_attempt_id
    AND owner_attempt.state = 'claimed'
    AND owner_attempt.fence_token = p_fence_token
    AND owner_attempt.worker_lease_expires_at > clock_timestamp()
    AND owner_attempt.adapter_version_id = run.adapter_version_id
    AND owner_attempt.provider_mapping_id = run.provider_mapping_id
    AND definition.code = 'bright_data.marketplace.filter'
    AND definition.product_family = 'marketplace_dataset'
    AND adapter.semantic_version = '1.0.0-m7-fixture'
    AND adapter.state = 'disabled'
    AND adapter.capability_metadata @> '{"transport":"fixture","provider_http_enabled":false}'::jsonb
    AND mapping.state = 'disabled'
    AND mapping.environment = 'test'
    AND mapping.operation_code = 'marketplace.dataset.filter'
    AND credential.provider_code = 'bright_data'
    AND credential.environment = 'test'
    AND credential.state = 'inactive'
    AND mapping.output_policy @> '{"provider_operation":"filter","transport":"fixture"}'::jsonb
    AND (
      (p_reconciliation IS false
       AND owner_attempt.kind = 'submission'
       AND source_attempt.id = owner_attempt.id
       AND run.internal_status IN ('SUBMITTED', 'PROCESSING'))
      OR
      (p_reconciliation IS true
       AND owner_attempt.kind = 'reconciliation'
       AND source_attempt.id = p_source_attempt_id
       AND source_attempt.state = 'ambiguous'
       AND source_attempt.provider_reference_ciphertext IS NOT NULL
       AND source_attempt.provider_reference_fingerprint IS NOT NULL)
    );
END;
$$;

CREATE FUNCTION app.record_marketplace_snapshot_observation_fenced(
  p_run_id uuid,
  p_attempt_id uuid,
  p_fence_token uuid,
  p_source_attempt_id uuid,
  p_status text,
  p_dataset_size bigint,
  p_file_size bigint,
  p_cost_micros bigint,
  p_currency_code text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  resolved_tenant_id uuid := app.require_tenant_context();
  existing app.run_attempts%ROWTYPE;
  first_observation boolean;
BEGIN
  IF p_status IS NULL
     OR p_status NOT IN ('ready', 'failed')
     OR (p_dataset_size IS NOT NULL AND p_dataset_size < 0)
     OR (p_file_size IS NOT NULL AND p_file_size < 0)
     OR (p_cost_micros IS NOT NULL AND p_cost_micros < 0)
     OR p_currency_code IS DISTINCT FROM 'USD' THEN
    RAISE EXCEPTION 'MARKETPLACE_SNAPSHOT_OBSERVATION_INVALID' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM app.resolve_marketplace_execution_plan_fixture(
    p_run_id,
    p_attempt_id,
    p_fence_token,
    p_attempt_id <> p_source_attempt_id,
    p_source_attempt_id
  );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MARKETPLACE_EXECUTION_PLAN_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO existing
  FROM app.run_attempts
  WHERE id = p_source_attempt_id
    AND tenant_id = resolved_tenant_id
    AND run_id = p_run_id
  FOR UPDATE;

  first_observation := existing.provider_metadata_observed_at IS NULL;
  IF NOT first_observation AND (
    existing.provider_last_status IS DISTINCT FROM p_status
    OR existing.provider_dataset_size IS DISTINCT FROM p_dataset_size
    OR existing.provider_file_size IS DISTINCT FROM p_file_size
    OR existing.provider_cost_micros IS DISTINCT FROM p_cost_micros
    OR existing.provider_cost_currency IS DISTINCT FROM p_currency_code
  ) THEN
    RAISE EXCEPTION 'MARKETPLACE_SNAPSHOT_OBSERVATION_REPLAY_CONFLICT'
      USING ERRCODE = '23505';
  END IF;

  IF first_observation THEN
    UPDATE app.run_attempts
    SET provider_last_status = p_status,
        provider_dataset_size = p_dataset_size,
        provider_file_size = p_file_size,
        provider_cost_micros = p_cost_micros,
        provider_cost_currency = p_currency_code,
        provider_metadata_observed_at = clock_timestamp(),
        updated_at = clock_timestamp()
    WHERE id = p_source_attempt_id AND tenant_id = resolved_tenant_id;

    IF p_cost_micros IS NOT NULL THEN
      UPDATE app.provider_cost_holds
      SET state = 'finalized',
          finalized_amount_micros = p_cost_micros,
          settled_at = clock_timestamp(),
          updated_at = clock_timestamp()
      WHERE tenant_id = resolved_tenant_id
        AND run_id = p_run_id
        AND provider_code = 'bright_data'
        AND product_family = 'marketplace_dataset'
        AND currency_code = p_currency_code
        AND state = 'held';
      IF NOT FOUND THEN
        PERFORM 1 FROM app.provider_cost_holds
        WHERE tenant_id = resolved_tenant_id
          AND run_id = p_run_id
          AND provider_code = 'bright_data'
          AND product_family = 'marketplace_dataset'
          AND state = 'finalized'
          AND finalized_amount_micros = p_cost_micros
          AND currency_code = p_currency_code;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'MARKETPLACE_COST_HOLD_CONFLICT' USING ERRCODE = '55000';
        END IF;
      END IF;
    END IF;

    INSERT INTO app.audit_events (
      tenant_id, action, target_type, target_id, outcome, safe_diff
    ) VALUES (
      resolved_tenant_id,
      'provider.marketplace_snapshot.observe',
      'run_attempt',
      p_source_attempt_id,
      p_status,
      jsonb_build_object(
        'status', p_status,
        'dataset_size', p_dataset_size,
        'file_size', p_file_size,
        'cost_recorded', p_cost_micros IS NOT NULL,
        'currency_code', p_currency_code
      )
    );
  END IF;

  RETURN true;
END;
$$;

CREATE FUNCTION app.record_marketplace_known_submission_outcome_fenced(
  p_run_id uuid,
  p_attempt_id uuid,
  p_fence_token uuid,
  p_outcome text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  resolved_tenant_id uuid := app.require_tenant_context();
  changed integer;
BEGIN
  IF p_outcome IS NULL
     OR p_outcome NOT IN ('credential_rejected', 'zero_matches', 'payment_required', 'rate_limited', 'request_rejected') THEN
    RAISE EXCEPTION 'MARKETPLACE_SUBMISSION_OUTCOME_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM 1
  FROM app.resolve_marketplace_execution_plan_fixture(
    p_run_id, p_attempt_id, p_fence_token, false, NULL
  );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MARKETPLACE_EXECUTION_PLAN_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  UPDATE app.provider_cost_holds
  SET state = CASE WHEN p_outcome = 'zero_matches' THEN 'finalized' ELSE 'released' END,
      finalized_amount_micros = CASE WHEN p_outcome = 'zero_matches' THEN 0 ELSE NULL END,
      settled_at = clock_timestamp(),
      updated_at = clock_timestamp()
  WHERE tenant_id = resolved_tenant_id
    AND run_id = p_run_id
    AND provider_code = 'bright_data'
    AND product_family = 'marketplace_dataset'
    AND currency_code = 'USD'
    AND state = 'held';
  GET DIAGNOSTICS changed = ROW_COUNT;

  IF changed = 1 THEN
    INSERT INTO app.audit_events (
      tenant_id, action, target_type, target_id, outcome, safe_diff
    ) VALUES (
      resolved_tenant_id,
      'provider.marketplace_filter.reject',
      'run_attempt',
      p_attempt_id,
      'rejected',
      jsonb_build_object(
        'provider_outcome', p_outcome,
        'cost_disposition', CASE WHEN p_outcome = 'zero_matches' THEN 'finalized_zero' ELSE 'released' END
      )
    );
  ELSE
    PERFORM 1 FROM app.provider_cost_holds
    WHERE tenant_id = resolved_tenant_id
      AND run_id = p_run_id
      AND provider_code = 'bright_data'
      AND product_family = 'marketplace_dataset'
      AND currency_code = 'USD'
      AND (
        (p_outcome = 'zero_matches' AND state = 'finalized' AND finalized_amount_micros = 0)
        OR (p_outcome <> 'zero_matches' AND state = 'released')
      );
    IF NOT FOUND THEN
      RAISE EXCEPTION 'MARKETPLACE_COST_HOLD_CONFLICT' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION app.resolve_provider_executor_kind(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_marketplace_execution_plan_fixture(uuid, uuid, uuid, boolean, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.record_marketplace_snapshot_observation_fenced(uuid, uuid, uuid, uuid, text, bigint, bigint, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.record_marketplace_known_submission_outcome_fenced(uuid, uuid, uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.resolve_provider_executor_kind(uuid, uuid, uuid) TO dhumi_job_manager;
GRANT EXECUTE ON FUNCTION app.resolve_marketplace_execution_plan_fixture(uuid, uuid, uuid, boolean, uuid) TO dhumi_job_manager;
GRANT EXECUTE ON FUNCTION app.record_marketplace_snapshot_observation_fenced(uuid, uuid, uuid, uuid, text, bigint, bigint, bigint, text) TO dhumi_job_manager;
GRANT EXECUTE ON FUNCTION app.record_marketplace_known_submission_outcome_fenced(uuid, uuid, uuid, text) TO dhumi_job_manager;

RESET ROLE;
