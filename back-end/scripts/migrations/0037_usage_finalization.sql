-- Pattern 8A: exactly-once informational usage finalization.
--
-- A successful Run is completed only in the same fenced transaction that
-- records (or exactly reuses) its normalized Artifact usage observation and
-- finishes the owning Attempt. No public API or database identity is added.

SET ROLE dhumi_owner;

ALTER TABLE app.artifacts
  ADD COLUMN record_count bigint,
  ADD CONSTRAINT artifacts_record_count_check
    CHECK (
      record_count IS NULL
      OR (record_count >= 0 AND kind = 'normalized')
    );

-- The new SECURITY DEFINER composition reads Artifact metadata and inserts
-- usage as dhumi_owner. FORCE RLS therefore needs the same tenant-constrained
-- owner inclusion already established for Runs/Attempts by migration 0004.
DROP POLICY artifacts_tenant_isolation ON app.artifacts;
CREATE POLICY artifacts_tenant_isolation ON app.artifacts
  FOR ALL TO dhumi_customer_api, dhumi_job_manager, dhumi_result_recorder,
    dhumi_owner
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY usage_events_tenant_isolation ON app.usage_events;
CREATE POLICY usage_events_tenant_isolation ON app.usage_events
  FOR ALL TO dhumi_customer_api, dhumi_job_manager, dhumi_result_recorder,
    dhumi_owner
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE UNIQUE INDEX usage_events_successful_artifact_attempt_meter_uidx
  ON app.usage_events (tenant_id, attempt_id, meter_code)
  WHERE attempt_id IS NOT NULL
    AND source = 'artifact'
    AND outcome = 'succeeded';

CREATE FUNCTION app.require_validated_normalized_artifact(
  p_run_id uuid,
  p_attempt_id uuid,
  p_artifact_id uuid
)
RETURNS app.artifacts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  resolved_tenant_id uuid;
  resolved_artifact app.artifacts%ROWTYPE;
BEGIN
  resolved_tenant_id := app.require_tenant_context();

  SELECT artifact.* INTO resolved_artifact
  FROM app.artifacts AS artifact
  WHERE artifact.id = p_artifact_id
    AND artifact.tenant_id = resolved_tenant_id
    AND artifact.run_id = p_run_id
    AND artifact.attempt_id = p_attempt_id
    AND artifact.kind = 'normalized'
    AND artifact.state = 'validated'
    AND artifact.record_count IS NOT NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'VALIDATED_NORMALIZED_ARTIFACT_REQUIRED'
      USING ERRCODE = '23514';
  END IF;

  RETURN resolved_artifact;
END;
$$;

CREATE FUNCTION app.record_success_usage_observation(
  p_run_id uuid,
  p_attempt_id uuid,
  p_artifact_id uuid,
  p_meter_code text,
  p_unit text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  resolved_tenant_id uuid;
  current_run app.runs%ROWTYPE;
  current_attempt app.run_attempts%ROWTYPE;
  normalized_artifact app.artifacts%ROWTYPE;
  inserted_usage_id uuid;
  current_usage app.usage_events%ROWTYPE;
  artifact_evidence_reference text;
BEGIN
  resolved_tenant_id := app.require_tenant_context();

  IF p_meter_code IS NULL
     OR p_meter_code !~ '^[a-z][a-z0-9_.]{0,127}$'
     OR p_unit IS NULL
     OR p_unit !~ '^[a-z][a-z0-9_]{0,31}$' THEN
    RAISE EXCEPTION 'USAGE_OBSERVATION_INPUT_INVALID'
      USING ERRCODE = '22023';
  END IF;

  SELECT run.* INTO current_run
  FROM app.runs AS run
  WHERE run.id = p_run_id
    AND run.tenant_id = resolved_tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RUN_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT attempt.* INTO current_attempt
  FROM app.run_attempts AS attempt
  WHERE attempt.id = p_attempt_id
    AND attempt.tenant_id = resolved_tenant_id
    AND attempt.run_id = p_run_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RUN_ATTEMPT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  normalized_artifact := app.require_validated_normalized_artifact(
    p_run_id,
    p_attempt_id,
    p_artifact_id
  );
  artifact_evidence_reference := 'artifact:' || normalized_artifact.id::text;

  INSERT INTO app.usage_events (
    tenant_id,
    run_id,
    attempt_id,
    service_template_version_id,
    adapter_version_id,
    meter_code,
    quantity,
    unit,
    outcome,
    source,
    reconciliation_state,
    provider_reference_fingerprint,
    evidence_reference,
    observed_at
  ) VALUES (
    resolved_tenant_id,
    current_run.id,
    current_attempt.id,
    current_run.service_template_version_id,
    current_run.adapter_version_id,
    p_meter_code,
    normalized_artifact.record_count,
    p_unit,
    'succeeded',
    'artifact',
    'observed',
    current_attempt.provider_reference_fingerprint,
    artifact_evidence_reference,
    normalized_artifact.created_at
  )
  ON CONFLICT (tenant_id, attempt_id, meter_code)
    WHERE attempt_id IS NOT NULL
      AND source = 'artifact'
      AND outcome = 'succeeded'
  DO NOTHING
  RETURNING id INTO inserted_usage_id;

  IF inserted_usage_id IS NOT NULL THEN
    RETURN inserted_usage_id;
  END IF;

  SELECT usage.* INTO current_usage
  FROM app.usage_events AS usage
  WHERE usage.tenant_id = resolved_tenant_id
    AND usage.attempt_id = current_attempt.id
    AND usage.meter_code = p_meter_code
    AND usage.source = 'artifact'
    AND usage.outcome = 'succeeded';

  IF NOT FOUND
     OR current_usage.run_id <> current_run.id
     OR current_usage.service_template_version_id <> current_run.service_template_version_id
     OR current_usage.adapter_version_id <> current_run.adapter_version_id
     OR current_usage.quantity <> normalized_artifact.record_count
     OR current_usage.unit <> p_unit
     OR current_usage.reconciliation_state <> 'observed'
     OR current_usage.provider_reference_fingerprint
          IS DISTINCT FROM current_attempt.provider_reference_fingerprint
     OR current_usage.evidence_reference <> artifact_evidence_reference THEN
    RAISE EXCEPTION 'USAGE_FINALIZATION_CONFLICT'
      USING ERRCODE = '23505';
  END IF;

  RETURN current_usage.id;
END;
$$;

CREATE FUNCTION app.complete_run_execution_with_usage(
  p_run_id uuid,
  p_expected_state_version bigint,
  p_event_idempotency_key text,
  p_attempt_id uuid,
  p_fence_token uuid,
  p_attempt_outcome_class text,
  p_normalized_artifact_id uuid,
  p_meter_code text DEFAULT NULL,
  p_unit text DEFAULT NULL,
  p_safe_payload jsonb DEFAULT '{"status":"ready"}'::jsonb
)
RETURNS app.runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  transitioned_run app.runs%ROWTYPE;
BEGIN
  IF (p_meter_code IS NULL) <> (p_unit IS NULL) THEN
    RAISE EXCEPTION 'USAGE_OBSERVATION_INPUT_INVALID'
      USING ERRCODE = '22023';
  END IF;

  PERFORM app.require_validated_normalized_artifact(
    p_run_id,
    p_attempt_id,
    p_normalized_artifact_id
  );

  IF p_meter_code IS NOT NULL THEN
    PERFORM app.record_success_usage_observation(
      p_run_id,
      p_attempt_id,
      p_normalized_artifact_id,
      p_meter_code,
      p_unit
    );
  END IF;

  transitioned_run := app.transition_run_fenced(
    p_run_id,
    p_expected_state_version,
    'COMPLETED',
    'completed',
    p_event_idempotency_key,
    p_attempt_id,
    p_fence_token,
    NULL,
    false,
    p_safe_payload
  );

  IF NOT app.finish_run_attempt_claim(
    p_attempt_id,
    p_fence_token,
    'completed',
    p_attempt_outcome_class
  ) THEN
    RAISE EXCEPTION 'RUN_ATTEMPT_FINISH_REJECTED'
      USING ERRCODE = '40001';
  END IF;

  RETURN transitioned_run;
END;
$$;

CREATE FUNCTION app.complete_run_reconciliation_with_usage(
  p_run_id uuid,
  p_expected_state_version bigint,
  p_event_idempotency_key text,
  p_reconciliation_attempt_id uuid,
  p_reconciliation_fence_token uuid,
  p_source_attempt_id uuid,
  p_reconciliation_outcome_class text,
  p_normalized_artifact_id uuid,
  p_meter_code text DEFAULT NULL,
  p_unit text DEFAULT NULL,
  p_safe_payload jsonb DEFAULT '{"status":"ready"}'::jsonb
)
RETURNS app.runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  transitioned_run app.runs%ROWTYPE;
BEGIN
  IF (p_meter_code IS NULL) <> (p_unit IS NULL) THEN
    RAISE EXCEPTION 'USAGE_OBSERVATION_INPUT_INVALID'
      USING ERRCODE = '22023';
  END IF;

  PERFORM app.require_validated_normalized_artifact(
    p_run_id,
    p_source_attempt_id,
    p_normalized_artifact_id
  );

  IF p_meter_code IS NOT NULL THEN
    PERFORM app.record_success_usage_observation(
      p_run_id,
      p_source_attempt_id,
      p_normalized_artifact_id,
      p_meter_code,
      p_unit
    );
  END IF;

  transitioned_run := app.complete_run_reconciliation(
    p_run_id,
    p_expected_state_version,
    'COMPLETED',
    'completed',
    p_event_idempotency_key,
    p_reconciliation_attempt_id,
    p_reconciliation_fence_token,
    p_source_attempt_id,
    'completed',
    'reconciled_from_durable_result',
    p_reconciliation_outcome_class,
    NULL,
    false,
    p_safe_payload
  );

  RETURN transitioned_run;
END;
$$;

REVOKE ALL ON FUNCTION app.require_validated_normalized_artifact(uuid, uuid, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app.record_success_usage_observation(uuid, uuid, uuid, text, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app.complete_run_execution_with_usage(
  uuid, bigint, text, uuid, uuid, text, uuid, text, text, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.complete_run_reconciliation_with_usage(
  uuid, bigint, text, uuid, uuid, uuid, text, uuid, text, text, jsonb
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.complete_run_execution_with_usage(
  uuid, bigint, text, uuid, uuid, text, uuid, text, text, jsonb
), app.complete_run_reconciliation_with_usage(
  uuid, bigint, text, uuid, uuid, uuid, text, uuid, text, text, jsonb
) TO dhumi_job_manager;

RESET ROLE;
