-- Safe retry admission for terminal failed Runs.
--
-- This migration intentionally does not reopen or update a source Run, retry
-- provider traffic, create a dispatcher or Job Manager, resolve credentials,
-- enforce one child per source, widen Admission table reads, provision LOGIN
-- roles, backfill data, or modify migrations 0001-0021.

SET ROLE dhumi_owner;

-- A completed retry claim is a permanent exact-response tombstone. Its
-- resource is the new child and its related resource is the immutable source.
ALTER TABLE app.idempotency_records
  ADD CONSTRAINT idempotency_records_run_retry_semantics_check
  CHECK (
    operation_code <> 'runs.retry'
    OR
    (
      scope_kind = 'tenant'
      AND
      (
        (
          state = 'in_progress'
          AND response_status IS NULL
          AND resource_type IS NULL
          AND resource_id IS NULL
          AND related_resource_id IS NULL
          AND response_body_reference IS NULL
          AND response_body IS NULL
          AND response_envelope_ciphertext IS NULL
          AND response_envelope_key_reference IS NULL
          AND response_envelope_recoverable_until IS NULL
          AND response_envelope_destroyed_at IS NULL
          AND completed_at IS NULL
        )
        OR
        (
          state = 'completed'
          AND response_status = 202
          AND resource_type = 'run'
          AND resource_id IS NOT NULL
          AND related_resource_id IS NOT NULL
          AND resource_id <> related_resource_id
          AND response_body_reference = 'inline_json_v1'
          AND response_body IS NOT NULL
          AND response_body ?& ARRAY['run_id', 'status', 'accepted_at']
          AND response_body - ARRAY['run_id', 'status', 'accepted_at'] = '{}'::jsonb
          AND response_body ->> 'run_id' = resource_id::text
          AND response_body ->> 'status' = 'queued'
          AND jsonb_typeof(response_body -> 'accepted_at') = 'string'
          AND response_envelope_ciphertext IS NULL
          AND response_envelope_key_reference IS NULL
          AND response_envelope_recoverable_until IS NULL
          AND response_envelope_destroyed_at IS NULL
          AND completed_at IS NOT NULL
        )
      )
    )
  );

-- Lineage may be one-to-many, but a Run can never be its own immediate source.
ALTER TABLE app.runs
  ADD CONSTRAINT runs_retry_not_self_check
  CHECK (retry_of_run_id IS NULL OR retry_of_run_id <> id);

-- Admission needs one stable Tenant-owned source snapshot. Elevation is
-- deliberately limited to the lifecycle/input fields required for retry and
-- locks both the source and every current Attempt before returning.
CREATE FUNCTION app.lock_run_for_retry(p_run_id uuid)
RETURNS TABLE (
  run_id uuid,
  service_id uuid,
  validated_input jsonb,
  public_status text,
  internal_status text,
  retryable boolean,
  completed_at timestamptz,
  has_ambiguous_attempt boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  resolved_tenant_id uuid;
  current_run app.runs%ROWTYPE;
  resolved_service_id uuid;
  unresolved_attempt boolean;
BEGIN
  resolved_tenant_id := app.require_tenant_context();

  SELECT run.*
    INTO current_run
  FROM app.runs AS run
  WHERE run.tenant_id = resolved_tenant_id
    AND run.id = p_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  PERFORM 1
  FROM app.run_attempts AS attempt
  WHERE attempt.tenant_id = resolved_tenant_id
    AND attempt.run_id = current_run.id
  ORDER BY attempt.id
  FOR UPDATE;

  SELECT EXISTS (
    SELECT 1
    FROM app.run_attempts AS attempt
    WHERE attempt.tenant_id = resolved_tenant_id
      AND attempt.run_id = current_run.id
      AND attempt.state = 'ambiguous'
  ) INTO unresolved_attempt;

  SELECT version.service_id
    INTO resolved_service_id
  FROM app.service_versions AS version
  WHERE version.tenant_id = resolved_tenant_id
    AND version.id = current_run.service_version_id;

  IF resolved_service_id IS NULL THEN
    RAISE EXCEPTION 'RUN_RETRY_SOURCE_SERVICE_UNAVAILABLE'
      USING ERRCODE = 'P5202';
  END IF;

  RETURN QUERY SELECT
    current_run.id,
    resolved_service_id,
    current_run.validated_input,
    current_run.public_status,
    current_run.internal_status,
    current_run.retryable,
    current_run.completed_at,
    unresolved_attempt;
END;
$$;

-- The database rechecks source eligibility and same-logical-Service lineage at
-- the insert boundary, so direct or racing callers cannot bypass the service.
CREATE FUNCTION app.validate_run_retry_lineage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  resolved_tenant_id uuid;
  source_run app.runs%ROWTYPE;
  source_service_id uuid;
  child_service_id uuid;
BEGIN
  IF NEW.retry_of_run_id IS NULL THEN
    RETURN NEW;
  END IF;

  resolved_tenant_id := app.require_tenant_context();
  IF NEW.tenant_id <> resolved_tenant_id THEN
    RAISE EXCEPTION 'RUN_RETRY_TENANT_CONTEXT_MISMATCH'
      USING ERRCODE = '42501';
  END IF;

  SELECT run.*
    INTO source_run
  FROM app.runs AS run
  WHERE run.tenant_id = resolved_tenant_id
    AND run.id = NEW.retry_of_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RUN_RETRY_SOURCE_NOT_FOUND'
      USING ERRCODE = 'P5201';
  END IF;

  PERFORM 1
  FROM app.run_attempts AS attempt
  WHERE attempt.tenant_id = resolved_tenant_id
    AND attempt.run_id = source_run.id
  ORDER BY attempt.id
  FOR UPDATE;

  IF source_run.public_status <> 'failed'
     OR source_run.internal_status NOT IN (
       'UPSTREAM_REJECTED', 'UPSTREAM_FAILED', 'PROCESSING_FAILED'
     )
     OR source_run.retryable IS NOT TRUE
     OR source_run.completed_at IS NULL
     OR EXISTS (
       SELECT 1
       FROM app.run_attempts AS attempt
       WHERE attempt.tenant_id = resolved_tenant_id
         AND attempt.run_id = source_run.id
         AND attempt.state = 'ambiguous'
     ) THEN
    RAISE EXCEPTION 'RUN_RETRY_SOURCE_STATE_CONFLICT'
      USING ERRCODE = 'P5201';
  END IF;

  SELECT version.service_id
    INTO source_service_id
  FROM app.service_versions AS version
  WHERE version.tenant_id = resolved_tenant_id
    AND version.id = source_run.service_version_id;

  SELECT version.service_id
    INTO child_service_id
  FROM app.service_versions AS version
  WHERE version.tenant_id = resolved_tenant_id
    AND version.id = NEW.service_version_id;

  IF source_service_id IS NULL
     OR child_service_id IS NULL
     OR source_service_id <> child_service_id THEN
    RAISE EXCEPTION 'RUN_RETRY_SERVICE_MISMATCH'
      USING ERRCODE = 'P5202';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER runs_validate_retry_lineage
  BEFORE INSERT ON app.runs
  FOR EACH ROW EXECUTE FUNCTION app.validate_run_retry_lineage();

-- Admission may set the already-protected lineage column only while inserting
-- a new aggregate. It still receives no direct source-input/Attempt read and
-- no UPDATE authority over Run lifecycle or pins.
GRANT INSERT (retry_of_run_id) ON app.runs TO dhumi_admission;

REVOKE ALL ON FUNCTION app.lock_run_for_retry(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_run_for_retry(uuid) TO dhumi_admission;
REVOKE ALL ON FUNCTION app.validate_run_retry_lineage() FROM PUBLIC;

RESET ROLE;
