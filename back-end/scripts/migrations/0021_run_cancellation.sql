-- Durable best-effort cancellation admission and independent Run-event ordering.
--
-- This migration intentionally does not cancel a provider operation, change a
-- Run from the customer API, settle a provider-cost hold, create a dispatcher
-- or Job Manager runtime, widen Admission table privileges, provision a LOGIN
-- role, backfill data, or modify migrations 0001-0020.

SET ROLE dhumi_owner;

-- A completed cancellation claim is a permanent exact-response tombstone.
-- Only the current internally queued representation may be completed because
-- the HTTP request records durable intent; it does not perform the transition.
ALTER TABLE app.idempotency_records
  ADD CONSTRAINT idempotency_records_run_cancel_semantics_check
  CHECK (
    operation_code <> 'runs.cancel'
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
          AND related_resource_id IS NULL
          AND response_body_reference = 'inline_json_v1'
          AND response_body IS NOT NULL
          AND response_body ?& ARRAY[
            'id',
            'service_id',
            'status',
            'error_code',
            'retryable',
            'created_at',
            'updated_at',
            'completed_at'
          ]
          AND response_body - ARRAY[
            'id',
            'service_id',
            'status',
            'error_code',
            'retryable',
            'created_at',
            'updated_at',
            'completed_at'
          ] = '{}'::jsonb
          AND response_body ->> 'id' = resource_id::text
          AND jsonb_typeof(response_body -> 'service_id') = 'string'
          AND response_body ->> 'status' = 'queued'
          AND response_body -> 'error_code' = 'null'::jsonb
          AND response_body -> 'retryable' = 'false'::jsonb
          AND jsonb_typeof(response_body -> 'created_at') = 'string'
          AND jsonb_typeof(response_body -> 'updated_at') = 'string'
          AND response_body -> 'completed_at' = 'null'::jsonb
          AND response_envelope_ciphertext IS NULL
          AND response_envelope_key_reference IS NULL
          AND response_envelope_recoverable_until IS NULL
          AND response_envelope_destroyed_at IS NULL
          AND completed_at IS NOT NULL
        )
      )
    )
  );

-- A cancellation command carries only a Run identifier. The later trusted
-- consumer must resolve Tenant, lifecycle, hold and provider state afresh.
ALTER TABLE app.outbox_events
  ADD CONSTRAINT outbox_events_jobs_cancel_shape_check
  CHECK (
    topic <> 'jobs.cancel'
    OR (
      aggregate_type = 'run'
      AND tenant_id IS NOT NULL
      AND ordering_key = aggregate_id::text
      AND schema_version = 1
      AND jsonb_typeof(payload) = 'object'
      AND payload ? 'run_id'
      AND payload - 'run_id' = '{}'::jsonb
      AND payload ->> 'run_id' = aggregate_id::text
    )
  );

CREATE UNIQUE INDEX outbox_events_one_jobs_cancel_per_run_idx
  ON app.outbox_events (aggregate_id)
  WHERE topic = 'jobs.cancel';

-- Cancellation intent is immutable customer-safe evidence, not a lifecycle
-- transition. It may be recorded once and contains no provider or actor data.
ALTER TABLE app.run_events
  ADD CONSTRAINT run_events_cancellation_requested_shape_check
  CHECK (
    event_type <> 'cancellation_requested'
    OR (
      source = 'admission'
      AND attempt_id IS NULL
      AND evidence_reference IS NULL
      AND event_idempotency_key ~
        '^cancel\.requested\.v1:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND jsonb_typeof(safe_payload) = 'object'
      AND safe_payload ? 'status'
      AND safe_payload - 'status' = '{}'::jsonb
      AND safe_payload ->> 'status' = 'queued'
    )
  );

CREATE UNIQUE INDEX run_events_one_cancellation_requested_per_run_idx
  ON app.run_events (run_id)
  WHERE event_type = 'cancellation_requested';

-- Admission needs one serialized, Tenant-owned lifecycle snapshot but must not
-- receive SELECT on internal Run state or UPDATE on any Run column. The owner
-- remains constrained by FORCE RLS and a required transaction-local Tenant.
CREATE FUNCTION app.lock_run_for_cancellation(p_run_id uuid)
RETURNS TABLE (
  run_id uuid,
  service_version_id uuid,
  public_status text,
  internal_status text,
  customer_error_code text,
  retryable boolean,
  created_at timestamptz,
  updated_at timestamptz,
  completed_at timestamptz,
  next_event_sequence bigint,
  cancellation_requested boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  resolved_tenant_id uuid;
  current_run app.runs%ROWTYPE;
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

  RETURN QUERY
  SELECT
    current_run.id,
    current_run.service_version_id,
    current_run.public_status,
    current_run.internal_status,
    current_run.customer_error_code,
    current_run.retryable,
    current_run.created_at,
    current_run.updated_at,
    current_run.completed_at,
    COALESCE(MAX(event.sequence), 0) + 1,
    COUNT(*) FILTER (WHERE event.event_type = 'cancellation_requested') > 0
  FROM app.run_events AS event
  WHERE event.tenant_id = resolved_tenant_id
    AND event.run_id = current_run.id;
END;
$$;

-- A non-transition cancellation event consumes an event sequence without
-- consuming a state version. Preserve the guarded transition graph and CAS,
-- while allocating every later transition event from immutable history under
-- the same already-held Run row lock.
CREATE OR REPLACE FUNCTION app.transition_run(
  p_run_id uuid,
  p_expected_state_version bigint,
  p_to_internal_status text,
  p_event_type text,
  p_event_idempotency_key text,
  p_attempt_id uuid DEFAULT NULL,
  p_customer_error_code text DEFAULT NULL,
  p_retryable boolean DEFAULT false,
  p_safe_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS app.runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  current_run app.runs%ROWTYPE;
  transitioned_run app.runs%ROWTYPE;
  target_public_status text;
  resolved_tenant_id uuid;
  next_event_sequence bigint;
BEGIN
  -- EXECUTE is granted only to dhumi_job_manager. The definer is a NOLOGIN
  -- migration owner, and FORCE RLS still requires this resolved Tenant.
  resolved_tenant_id := app.require_tenant_context();
  PERFORM set_config('app.run_transition_writer', 'on', true);

  -- A redelivered event returns the Run produced by the original transition.
  SELECT run.*
    INTO current_run
  FROM app.run_events event
  JOIN app.runs run
    ON run.id = event.run_id
   AND run.tenant_id = event.tenant_id
  WHERE event.tenant_id = resolved_tenant_id
    AND event.run_id = p_run_id
    AND event.event_idempotency_key = p_event_idempotency_key;

  IF FOUND THEN
    RETURN current_run;
  END IF;

  SELECT *
    INTO current_run
  FROM app.runs
  WHERE id = p_run_id
    AND tenant_id = resolved_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RUN_NOT_FOUND'
      USING ERRCODE = 'P0002';
  END IF;

  IF current_run.state_version <> p_expected_state_version THEN
    RAISE EXCEPTION 'STATE_CONFLICT'
      USING ERRCODE = '40001';
  END IF;

  SELECT transition.to_public_status
    INTO target_public_status
  FROM app.run_status_transitions transition
  WHERE transition.from_internal_status = current_run.internal_status
    AND transition.to_internal_status = p_to_internal_status;

  IF target_public_status IS NULL THEN
    RAISE EXCEPTION 'ILLEGAL_RUN_TRANSITION % -> %',
      current_run.internal_status, p_to_internal_status
      USING ERRCODE = '23514';
  END IF;

  UPDATE app.runs
  SET
    internal_status = p_to_internal_status,
    public_status = target_public_status,
    state_version = current_run.state_version + 1,
    customer_error_code = p_customer_error_code,
    retryable = p_retryable,
    started_at = CASE
      WHEN p_to_internal_status = 'SUBMITTED'
        THEN COALESCE(started_at, clock_timestamp())
      ELSE started_at
    END,
    completed_at = CASE
      WHEN p_to_internal_status IN (
        'UPSTREAM_REJECTED', 'UPSTREAM_FAILED', 'CANCELLED',
        'COMPLETED', 'PROCESSING_FAILED'
      ) THEN clock_timestamp()
      ELSE completed_at
    END,
    expired_at = CASE
      WHEN p_to_internal_status = 'EXPIRED' THEN clock_timestamp()
      ELSE expired_at
    END
  WHERE id = current_run.id
    AND tenant_id = current_run.tenant_id
    AND state_version = current_run.state_version
  RETURNING * INTO transitioned_run;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'STATE_CONFLICT'
      USING ERRCODE = '40001';
  END IF;

  SELECT COALESCE(MAX(event.sequence), 0) + 1
    INTO next_event_sequence
  FROM app.run_events AS event
  WHERE event.tenant_id = transitioned_run.tenant_id
    AND event.run_id = transitioned_run.id;

  INSERT INTO app.run_events (
    tenant_id, run_id, sequence, event_type, source, attempt_id,
    event_idempotency_key, safe_payload
  ) VALUES (
    transitioned_run.tenant_id,
    transitioned_run.id,
    next_event_sequence,
    p_event_type,
    'job_manager',
    p_attempt_id,
    p_event_idempotency_key,
    p_safe_payload
  );

  RETURN transitioned_run;
END;
$$;

REVOKE ALL ON FUNCTION app.lock_run_for_cancellation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_run_for_cancellation(uuid)
  TO dhumi_admission;

REVOKE ALL ON FUNCTION app.transition_run(uuid, bigint, text, text, text, uuid, text, boolean, jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.transition_run(uuid, bigint, text, text, text, uuid, text, boolean, jsonb)
  TO dhumi_job_manager;

RESET ROLE;
