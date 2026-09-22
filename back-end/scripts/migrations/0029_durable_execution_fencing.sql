-- Pattern 4 durable execution database authority.
--
-- Adds a job-topic-only dispatcher claim and mandatory PostgreSQL Attempt
-- fencing for every Job Manager lifecycle transition. Queue and Redis state
-- remain non-authoritative. This migration does not add a public API, call a
-- provider, store result bytes in PostgreSQL, or modify migrations 0001-0028.

SET ROLE dhumi_owner;

-- A dispatcher for the execution queue must never consume notification,
-- security or catalogue outbox rows. Claims remain bounded, expiring and
-- protected by the existing per-row claim token.
CREATE FUNCTION app.claim_job_outbox_events(
  p_consumer text,
  p_limit integer,
  p_claim_ttl interval DEFAULT interval '1 minute'
)
RETURNS TABLE (
  id uuid,
  aggregate_type text,
  aggregate_id uuid,
  tenant_id uuid,
  topic text,
  ordering_key text,
  payload jsonb,
  schema_version integer,
  claim_token uuid
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF p_consumer IS NULL
     OR p_consumer !~ '^[a-z0-9][a-z0-9._:-]{0,127}$' THEN
    RAISE EXCEPTION 'OUTBOX_CONSUMER_INVALID'
      USING ERRCODE = '22023';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'OUTBOX_CLAIM_LIMIT_OUT_OF_RANGE'
      USING ERRCODE = '22023';
  END IF;

  IF p_claim_ttl IS NULL
     OR p_claim_ttl < interval '5 seconds'
     OR p_claim_ttl > interval '10 minutes' THEN
    RAISE EXCEPTION 'OUTBOX_CLAIM_TTL_OUT_OF_RANGE'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT event.id
    FROM app.outbox_events AS event
    WHERE event.published_at IS NULL
      AND event.available_at <= clock_timestamp()
      AND event.topic IN ('jobs.execute', 'jobs.cancel')
      AND (
        event.claimed_at IS NULL
        OR event.claimed_at < clock_timestamp() - p_claim_ttl
      )
    ORDER BY event.available_at, event.created_at, event.id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE app.outbox_events AS event
    SET
      claimed_at = clock_timestamp(),
      claimed_by = p_consumer,
      claim_token = gen_random_uuid(),
      delivery_attempts = event.delivery_attempts + 1,
      updated_at = clock_timestamp()
    FROM candidates
    WHERE event.id = candidates.id
    RETURNING event.*
  )
  SELECT
    claimed.id,
    claimed.aggregate_type,
    claimed.aggregate_id,
    claimed.tenant_id,
    claimed.topic,
    claimed.ordering_key,
    claimed.payload,
    claimed.schema_version,
    claimed.claim_token
  FROM claimed;
END;
$$;

-- Claim one activity under the Tenant context supplied by the worker. The
-- candidate Tenant came from replayable queue metadata; forced RLS plus this
-- Run lookup is the authoritative equality check.
CREATE FUNCTION app.claim_run_attempt(
  p_run_id uuid,
  p_kind text,
  p_lease_ttl interval DEFAULT interval '1 minute'
)
RETURNS TABLE (
  disposition text,
  attempt_id uuid,
  attempt_number integer,
  fence_token uuid,
  worker_lease_expires_at timestamptz,
  run_state_version bigint,
  run_internal_status text,
  adapter_version_id uuid,
  provider_mapping_id uuid,
  provider_credential_id uuid,
  cancellation_requested boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  resolved_tenant_id uuid;
  current_run app.runs%ROWTYPE;
  current_attempt app.run_attempts%ROWTYPE;
  mapping_credential_id uuid;
  next_attempt_number integer;
  requested_cancel boolean;
BEGIN
  resolved_tenant_id := app.require_tenant_context();

  IF p_kind NOT IN ('submission', 'poll', 'download', 'reconciliation') THEN
    RAISE EXCEPTION 'RUN_ATTEMPT_KIND_INVALID'
      USING ERRCODE = '22023';
  END IF;

  IF p_lease_ttl IS NULL
     OR p_lease_ttl < interval '5 seconds'
     OR p_lease_ttl > interval '5 minutes' THEN
    RAISE EXCEPTION 'RUN_ATTEMPT_LEASE_TTL_OUT_OF_RANGE'
      USING ERRCODE = '22023';
  END IF;

  SELECT run.*
    INTO current_run
  FROM app.runs AS run
  WHERE run.tenant_id = resolved_tenant_id
    AND run.id = p_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RUN_NOT_FOUND'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM app.run_events AS event
    WHERE event.tenant_id = resolved_tenant_id
      AND event.run_id = current_run.id
      AND event.event_type = 'cancellation_requested'
  ) INTO requested_cancel;

  IF current_run.internal_status IN (
    'UPSTREAM_REJECTED', 'UPSTREAM_FAILED', 'CANCELLED',
    'COMPLETED', 'PROCESSING_FAILED', 'EXPIRED'
  ) THEN
    RETURN QUERY SELECT
      'terminal'::text, NULL::uuid, NULL::integer, NULL::uuid,
      NULL::timestamptz, current_run.state_version,
      current_run.internal_status, current_run.adapter_version_id,
      current_run.provider_mapping_id, NULL::uuid, requested_cancel;
    RETURN;
  END IF;

  IF p_kind = 'submission' AND current_run.internal_status <> 'QUEUED' THEN
    RETURN QUERY SELECT
      CASE
        WHEN current_run.internal_status = 'SUBMITTED'
          THEN 'reconciliation_required'::text
        ELSE 'not_claimable'::text
      END,
      NULL::uuid, NULL::integer, NULL::uuid, NULL::timestamptz,
      current_run.state_version, current_run.internal_status,
      current_run.adapter_version_id, current_run.provider_mapping_id,
      NULL::uuid, requested_cancel;
    RETURN;
  END IF;

  SELECT attempt.*
    INTO current_attempt
  FROM app.run_attempts AS attempt
  WHERE attempt.tenant_id = resolved_tenant_id
    AND attempt.run_id = current_run.id
    AND attempt.kind = p_kind
    AND attempt.state = 'claimed'
  FOR UPDATE;

  IF FOUND AND current_attempt.worker_lease_expires_at > clock_timestamp() THEN
    RETURN QUERY SELECT
      'busy'::text, current_attempt.id, current_attempt.attempt_number,
      NULL::uuid, current_attempt.worker_lease_expires_at,
      current_run.state_version, current_run.internal_status,
      current_attempt.adapter_version_id, current_attempt.provider_mapping_id,
      current_attempt.provider_credential_id, requested_cancel;
    RETURN;
  END IF;

  IF FOUND THEN
    UPDATE app.run_attempts AS attempt
    SET
      fence_token = gen_random_uuid(),
      worker_lease_expires_at = clock_timestamp() + p_lease_ttl,
      updated_at = clock_timestamp()
    WHERE attempt.id = current_attempt.id
      AND attempt.tenant_id = resolved_tenant_id
    RETURNING attempt.* INTO current_attempt;

    RETURN QUERY SELECT
      'recovered'::text, current_attempt.id, current_attempt.attempt_number,
      current_attempt.fence_token, current_attempt.worker_lease_expires_at,
      current_run.state_version, current_run.internal_status,
      current_attempt.adapter_version_id, current_attempt.provider_mapping_id,
      current_attempt.provider_credential_id, requested_cancel;
    RETURN;
  END IF;

  SELECT mapping.provider_credential_id
    INTO mapping_credential_id
  FROM app.provider_mappings AS mapping
  WHERE mapping.id = current_run.provider_mapping_id
    AND mapping.adapter_version_id = current_run.adapter_version_id;

  IF mapping_credential_id IS NULL THEN
    RAISE EXCEPTION 'RUN_PROVIDER_MAPPING_NOT_RESOLVABLE'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(MAX(attempt.attempt_number), 0) + 1
    INTO next_attempt_number
  FROM app.run_attempts AS attempt
  WHERE attempt.tenant_id = resolved_tenant_id
    AND attempt.run_id = current_run.id
    AND attempt.kind = p_kind;

  INSERT INTO app.run_attempts (
    tenant_id,
    run_id,
    attempt_number,
    kind,
    state,
    worker_lease_expires_at,
    adapter_version_id,
    provider_mapping_id,
    provider_credential_id
  ) VALUES (
    resolved_tenant_id,
    current_run.id,
    next_attempt_number,
    p_kind,
    'claimed',
    clock_timestamp() + p_lease_ttl,
    current_run.adapter_version_id,
    current_run.provider_mapping_id,
    mapping_credential_id
  )
  RETURNING * INTO current_attempt;

  RETURN QUERY SELECT
    'claimed'::text, current_attempt.id, current_attempt.attempt_number,
    current_attempt.fence_token, current_attempt.worker_lease_expires_at,
    current_run.state_version, current_run.internal_status,
    current_attempt.adapter_version_id, current_attempt.provider_mapping_id,
    current_attempt.provider_credential_id, requested_cancel;
END;
$$;

CREATE FUNCTION app.renew_run_attempt_claim(
  p_attempt_id uuid,
  p_fence_token uuid,
  p_lease_ttl interval DEFAULT interval '1 minute'
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  resolved_tenant_id uuid;
  renewed_until timestamptz;
BEGIN
  resolved_tenant_id := app.require_tenant_context();

  IF p_lease_ttl IS NULL
     OR p_lease_ttl < interval '5 seconds'
     OR p_lease_ttl > interval '5 minutes' THEN
    RAISE EXCEPTION 'RUN_ATTEMPT_LEASE_TTL_OUT_OF_RANGE'
      USING ERRCODE = '22023';
  END IF;

  UPDATE app.run_attempts AS attempt
  SET
    worker_lease_expires_at = clock_timestamp() + p_lease_ttl,
    updated_at = clock_timestamp()
  WHERE attempt.id = p_attempt_id
    AND attempt.tenant_id = resolved_tenant_id
    AND attempt.state = 'claimed'
    AND attempt.fence_token = p_fence_token
    AND attempt.worker_lease_expires_at > clock_timestamp()
  RETURNING attempt.worker_lease_expires_at INTO renewed_until;

  RETURN renewed_until;
END;
$$;

-- Every lifecycle transition now requires an exact live Attempt fence. The
-- original transition function remains the single legal-graph/event writer,
-- but direct Job Manager execution of that unfenced surface is revoked below.
CREATE FUNCTION app.transition_run_fenced(
  p_run_id uuid,
  p_expected_state_version bigint,
  p_to_internal_status text,
  p_event_type text,
  p_event_idempotency_key text,
  p_attempt_id uuid,
  p_fence_token uuid,
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
  resolved_tenant_id uuid;
  claimed_attempt app.run_attempts%ROWTYPE;
BEGIN
  resolved_tenant_id := app.require_tenant_context();

  SELECT attempt.*
    INTO claimed_attempt
  FROM app.run_attempts AS attempt
  WHERE attempt.id = p_attempt_id
    AND attempt.tenant_id = resolved_tenant_id
    AND attempt.run_id = p_run_id
  FOR UPDATE;

  IF NOT FOUND
     OR p_attempt_id IS NULL
     OR p_fence_token IS NULL
     OR claimed_attempt.state <> 'claimed'
     OR claimed_attempt.fence_token <> p_fence_token
     OR claimed_attempt.worker_lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'RUN_ATTEMPT_FENCE_REJECTED'
      USING ERRCODE = '40001';
  END IF;

  -- Cancellation may commit after the worker claimed the QUEUED Attempt but
  -- before it tries to enter SUBMITTED. Close that race in the same
  -- authoritative transaction as the fenced transition.
  IF p_to_internal_status = 'SUBMITTED'
     AND EXISTS (
       SELECT 1
       FROM app.run_events AS event
       WHERE event.tenant_id = resolved_tenant_id
         AND event.run_id = p_run_id
         AND event.event_type = 'cancellation_requested'
     ) THEN
    RAISE EXCEPTION 'RUN_CANCELLATION_REQUESTED'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN app.transition_run(
    p_run_id,
    p_expected_state_version,
    p_to_internal_status,
    p_event_type,
    p_event_idempotency_key,
    p_attempt_id,
    p_customer_error_code,
    p_retryable,
    p_safe_payload
  );
END;
$$;

CREATE FUNCTION app.finish_run_attempt_claim(
  p_attempt_id uuid,
  p_fence_token uuid,
  p_state text,
  p_outcome_class text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  resolved_tenant_id uuid;
BEGIN
  resolved_tenant_id := app.require_tenant_context();

  IF p_state NOT IN ('rejected', 'ambiguous', 'completed', 'failed') THEN
    RAISE EXCEPTION 'RUN_ATTEMPT_FINISH_STATE_INVALID'
      USING ERRCODE = '22023';
  END IF;

  IF p_outcome_class IS NULL
     OR p_outcome_class !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'RUN_ATTEMPT_OUTCOME_INVALID'
      USING ERRCODE = '22023';
  END IF;

  UPDATE app.run_attempts AS attempt
  SET
    state = p_state,
    outcome_class = p_outcome_class,
    worker_lease_expires_at = NULL,
    finished_at = clock_timestamp(),
    updated_at = clock_timestamp()
  WHERE attempt.id = p_attempt_id
    AND attempt.tenant_id = resolved_tenant_id
    AND attempt.state = 'claimed'
    AND attempt.fence_token = p_fence_token
    AND attempt.worker_lease_expires_at > clock_timestamp();

  RETURN FOUND;
END;
$$;

-- Remove direct Attempt mutation and the old unfenced transition entry point.
-- Reads remain available for trusted execution composition and diagnostics.
REVOKE INSERT, UPDATE ON app.run_attempts FROM dhumi_job_manager;
REVOKE EXECUTE ON FUNCTION app.transition_run(
  uuid, bigint, text, text, text, uuid, text, boolean, jsonb
) FROM dhumi_job_manager;

REVOKE ALL ON FUNCTION app.claim_job_outbox_events(text, integer, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.claim_run_attempt(uuid, text, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.renew_run_attempt_claim(uuid, uuid, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.transition_run_fenced(
  uuid, bigint, text, text, text, uuid, uuid, text, boolean, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.finish_run_attempt_claim(uuid, uuid, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.claim_job_outbox_events(text, integer, interval)
  TO dhumi_outbox_dispatcher;

GRANT EXECUTE ON FUNCTION app.claim_run_attempt(uuid, text, interval),
  app.renew_run_attempt_claim(uuid, uuid, interval),
  app.transition_run_fenced(
    uuid, bigint, text, text, text, uuid, uuid, text, boolean, jsonb
  ),
  app.finish_run_attempt_claim(uuid, uuid, text, text)
  TO dhumi_job_manager;

RESET ROLE;
