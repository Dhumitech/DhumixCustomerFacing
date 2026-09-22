-- Pattern 4 resilience: durable reconciliation after uncertain execution.
--
-- A queue redelivery must not repeat a cost-incurring submission after a Run
-- has left QUEUED. This migration converts that uncertainty into one durable,
-- Run-only jobs.reconcile command and makes reconciliation completion an
-- atomic, fenced PostgreSQL operation.

SET ROLE dhumi_owner;

ALTER TABLE app.outbox_events
  ADD CONSTRAINT outbox_events_jobs_reconcile_shape_check
  CHECK (
    topic <> 'jobs.reconcile'
    OR (
      aggregate_type = 'run'
      AND tenant_id IS NOT NULL
      AND ordering_key = aggregate_id::text
      AND schema_version = 1
      AND payload = jsonb_build_object('run_id', aggregate_id::text)
    )
  );

CREATE UNIQUE INDEX outbox_events_one_jobs_reconcile_per_run_idx
  ON app.outbox_events (aggregate_id)
  WHERE topic = 'jobs.reconcile';

ALTER TABLE app.outbox_events
  ADD CONSTRAINT outbox_events_jobs_recover_shape_check
  CHECK (
    topic <> 'jobs.recover'
    OR (
      aggregate_type = 'run'
      AND tenant_id IS NOT NULL
      AND ordering_key = aggregate_id::text
      AND schema_version = 1
      AND payload = jsonb_build_object('run_id', aggregate_id::text)
    )
  );

CREATE UNIQUE INDEX outbox_events_one_pending_jobs_recover_per_run_idx
  ON app.outbox_events (aggregate_id)
  WHERE topic = 'jobs.recover' AND published_at IS NULL;

-- Idempotency belongs to the exact dead-lettered event, not permanently to the
-- Run. A recovery command can itself reach the DLQ; after that published
-- command is repaired, the operator must be able to create a new recovery
-- command without allowing concurrent pending commands for the same Run.
CREATE TABLE app.dead_letter_recovery_intents (
  original_event_id uuid PRIMARY KEY
    REFERENCES app.outbox_events(id) ON DELETE RESTRICT,
  recovery_event_id uuid NOT NULL
    REFERENCES app.outbox_events(id) ON DELETE RESTRICT,
  reason_code text NOT NULL
    CHECK (reason_code IN (
      'transient_infrastructure_recovered',
      'configuration_repaired',
      'manual_reconciliation_required'
    )),
  requested_by text NOT NULL DEFAULT session_user,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE app.dead_letter_recovery_intents OWNER TO dhumi_owner;

CREATE OR REPLACE FUNCTION app.claim_job_outbox_events(
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
      AND event.topic IN ('jobs.execute', 'jobs.cancel', 'jobs.reconcile', 'jobs.recover')
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

CREATE OR REPLACE FUNCTION app.claim_run_attempt(
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
  has_claimed_attempt boolean := false;
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

  SELECT attempt.*
    INTO current_attempt
  FROM app.run_attempts AS attempt
  WHERE attempt.tenant_id = resolved_tenant_id
    AND attempt.run_id = current_run.id
    AND attempt.kind = p_kind
    AND attempt.state = 'claimed'
  FOR UPDATE;
  has_claimed_attempt := FOUND;

  IF p_kind = 'submission'
     AND current_run.internal_status IN ('SUBMITTED', 'RESULT_RECEIVED', 'PROCESSING') THEN
    IF has_claimed_attempt
       AND current_attempt.worker_lease_expires_at > clock_timestamp() THEN
      RETURN QUERY SELECT
        'busy'::text, current_attempt.id, current_attempt.attempt_number,
        NULL::uuid, current_attempt.worker_lease_expires_at,
        current_run.state_version, current_run.internal_status,
        current_attempt.adapter_version_id, current_attempt.provider_mapping_id,
        current_attempt.provider_credential_id, requested_cancel;
    ELSE
      RETURN QUERY SELECT
        'reconciliation_required'::text, NULL::uuid, NULL::integer,
        NULL::uuid, NULL::timestamptz, current_run.state_version,
        current_run.internal_status, current_run.adapter_version_id,
        current_run.provider_mapping_id, NULL::uuid, requested_cancel;
    END IF;
    RETURN;
  END IF;

  IF p_kind = 'submission' AND current_run.internal_status <> 'QUEUED' THEN
    RETURN QUERY SELECT
      'not_claimable'::text, NULL::uuid, NULL::integer, NULL::uuid,
      NULL::timestamptz, current_run.state_version,
      current_run.internal_status, current_run.adapter_version_id,
      current_run.provider_mapping_id, NULL::uuid, requested_cancel;
    RETURN;
  END IF;

  IF p_kind = 'reconciliation'
     AND current_run.internal_status NOT IN ('SUBMITTED', 'RESULT_RECEIVED', 'PROCESSING') THEN
    RETURN QUERY SELECT
      'not_claimable'::text, NULL::uuid, NULL::integer, NULL::uuid,
      NULL::timestamptz, current_run.state_version,
      current_run.internal_status, current_run.adapter_version_id,
      current_run.provider_mapping_id, NULL::uuid, requested_cancel;
    RETURN;
  END IF;

  IF has_claimed_attempt
     AND current_attempt.worker_lease_expires_at > clock_timestamp() THEN
    RETURN QUERY SELECT
      'busy'::text, current_attempt.id, current_attempt.attempt_number,
      NULL::uuid, current_attempt.worker_lease_expires_at,
      current_run.state_version, current_run.internal_status,
      current_attempt.adapter_version_id, current_attempt.provider_mapping_id,
      current_attempt.provider_credential_id, requested_cancel;
    RETURN;
  END IF;

  IF has_claimed_attempt THEN
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
    tenant_id, run_id, attempt_number, kind, state,
    worker_lease_expires_at, adapter_version_id,
    provider_mapping_id, provider_credential_id
  ) VALUES (
    resolved_tenant_id, current_run.id, next_attempt_number, p_kind,
    'claimed', clock_timestamp() + p_lease_ttl,
    current_run.adapter_version_id, current_run.provider_mapping_id,
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

CREATE FUNCTION app.schedule_run_reconciliation(
  p_run_id uuid,
  p_reason_code text
)
RETURNS TABLE (command_event_id uuid, scheduled boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  resolved_tenant_id uuid;
  current_run app.runs%ROWTYPE;
  source_attempt app.run_attempts%ROWTYPE;
  inserted_event_id uuid;
BEGIN
  resolved_tenant_id := app.require_tenant_context();

  IF p_reason_code NOT IN ('submission_outcome_uncertain', 'cancellation_requested') THEN
    RAISE EXCEPTION 'RUN_RECONCILIATION_REASON_INVALID'
      USING ERRCODE = '22023';
  END IF;

  SELECT run.* INTO current_run
  FROM app.runs AS run
  WHERE run.tenant_id = resolved_tenant_id
    AND run.id = p_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RUN_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF current_run.internal_status NOT IN ('SUBMITTED', 'RESULT_RECEIVED', 'PROCESSING') THEN
    RAISE EXCEPTION 'RUN_RECONCILIATION_NOT_REQUIRED'
      USING ERRCODE = '23514';
  END IF;

  SELECT attempt.* INTO source_attempt
  FROM app.run_attempts AS attempt
  WHERE attempt.tenant_id = resolved_tenant_id
    AND attempt.run_id = current_run.id
    AND attempt.kind = 'submission'
  ORDER BY attempt.attempt_number DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RUN_SUBMISSION_ATTEMPT_NOT_FOUND'
      USING ERRCODE = '23514';
  END IF;

  IF source_attempt.state = 'claimed' THEN
    IF source_attempt.worker_lease_expires_at > clock_timestamp() THEN
      RAISE EXCEPTION 'RUN_SUBMISSION_ATTEMPT_STILL_ACTIVE'
        USING ERRCODE = '40001';
    END IF;

    UPDATE app.run_attempts AS attempt
    SET
      state = 'ambiguous',
      outcome_class = p_reason_code,
      worker_lease_expires_at = NULL,
      finished_at = clock_timestamp(),
      updated_at = clock_timestamp()
    WHERE attempt.id = source_attempt.id
      AND attempt.tenant_id = resolved_tenant_id;
  ELSIF source_attempt.state <> 'ambiguous' THEN
    RAISE EXCEPTION 'RUN_SUBMISSION_ATTEMPT_NOT_AMBIGUOUS'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO app.outbox_events (
    aggregate_type, aggregate_id, tenant_id, topic,
    ordering_key, payload, schema_version
  ) VALUES (
    'run', current_run.id, resolved_tenant_id, 'jobs.reconcile',
    current_run.id::text,
    jsonb_build_object('run_id', current_run.id::text),
    1
  )
  ON CONFLICT (aggregate_id) WHERE topic = 'jobs.reconcile'
  DO NOTHING
  RETURNING id INTO inserted_event_id;

  IF inserted_event_id IS NOT NULL THEN
    INSERT INTO app.run_events (
      tenant_id, run_id, sequence, event_type, source, attempt_id,
      event_idempotency_key, safe_payload
    ) VALUES (
      resolved_tenant_id,
      current_run.id,
      COALESCE((
        SELECT MAX(event.sequence)
        FROM app.run_events AS event
        WHERE event.tenant_id = resolved_tenant_id
          AND event.run_id = current_run.id
      ), 0) + 1,
      'reconciliation_scheduled',
      'job_manager',
      source_attempt.id,
      'job.reconciliation-scheduled.v1',
      jsonb_build_object('reason', p_reason_code)
    );

    RETURN QUERY SELECT inserted_event_id, true;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT event.id, false
  FROM app.outbox_events AS event
  WHERE event.aggregate_id = current_run.id
    AND event.topic = 'jobs.reconcile';
END;
$$;

CREATE FUNCTION app.inspect_run_reconciliation(p_run_id uuid)
RETURNS TABLE (
  source_attempt_id uuid,
  has_raw_artifact boolean,
  has_normalized_artifact boolean
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  resolved_tenant_id uuid;
BEGIN
  resolved_tenant_id := app.require_tenant_context();

  IF NOT EXISTS (
    SELECT 1 FROM app.runs AS run
    WHERE run.tenant_id = resolved_tenant_id AND run.id = p_run_id
  ) THEN
    RAISE EXCEPTION 'RUN_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  RETURN QUERY
  SELECT
    attempt.id,
    EXISTS (
      SELECT 1 FROM app.artifacts AS artifact
      WHERE artifact.tenant_id = resolved_tenant_id
        AND artifact.run_id = p_run_id
        AND artifact.kind = 'raw'
        AND artifact.state IN ('durable', 'validated')
    ),
    EXISTS (
      SELECT 1 FROM app.artifacts AS artifact
      WHERE artifact.tenant_id = resolved_tenant_id
        AND artifact.run_id = p_run_id
        AND artifact.kind = 'normalized'
        AND artifact.state = 'validated'
    )
  FROM app.run_attempts AS attempt
  WHERE attempt.tenant_id = resolved_tenant_id
    AND attempt.run_id = p_run_id
    AND attempt.kind = 'submission'
    AND attempt.state = 'ambiguous'
  ORDER BY attempt.attempt_number DESC
  LIMIT 1;
END;
$$;

CREATE FUNCTION app.complete_run_reconciliation(
  p_run_id uuid,
  p_expected_state_version bigint,
  p_to_internal_status text,
  p_event_type text,
  p_event_idempotency_key text,
  p_reconciliation_attempt_id uuid,
  p_reconciliation_fence_token uuid,
  p_source_attempt_id uuid,
  p_source_attempt_state text,
  p_source_outcome_class text,
  p_reconciliation_outcome_class text,
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
  reconciliation_attempt app.run_attempts%ROWTYPE;
  transitioned_run app.runs%ROWTYPE;
BEGIN
  resolved_tenant_id := app.require_tenant_context();

  IF p_source_attempt_state NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'RUN_RECONCILIATION_SOURCE_STATE_INVALID'
      USING ERRCODE = '22023';
  END IF;

  IF p_source_outcome_class !~ '^[a-z][a-z0-9_]{0,63}$'
     OR p_reconciliation_outcome_class !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'RUN_RECONCILIATION_OUTCOME_INVALID'
      USING ERRCODE = '22023';
  END IF;

  SELECT attempt.* INTO reconciliation_attempt
  FROM app.run_attempts AS attempt
  WHERE attempt.id = p_reconciliation_attempt_id
    AND attempt.tenant_id = resolved_tenant_id
    AND attempt.run_id = p_run_id
    AND attempt.kind = 'reconciliation'
  FOR UPDATE;

  IF NOT FOUND
     OR reconciliation_attempt.state <> 'claimed'
     OR reconciliation_attempt.fence_token <> p_reconciliation_fence_token
     OR reconciliation_attempt.worker_lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'RUN_RECONCILIATION_FENCE_REJECTED'
      USING ERRCODE = '40001';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM app.run_attempts AS source
    WHERE source.id = p_source_attempt_id
      AND source.tenant_id = resolved_tenant_id
      AND source.run_id = p_run_id
      AND source.kind = 'submission'
      AND source.state = 'ambiguous'
    FOR UPDATE
  ) THEN
    RAISE EXCEPTION 'RUN_RECONCILIATION_SOURCE_REJECTED'
      USING ERRCODE = '40001';
  END IF;

  transitioned_run := app.transition_run_fenced(
    p_run_id,
    p_expected_state_version,
    p_to_internal_status,
    p_event_type,
    p_event_idempotency_key,
    p_reconciliation_attempt_id,
    p_reconciliation_fence_token,
    p_customer_error_code,
    p_retryable,
    p_safe_payload
  );

  UPDATE app.run_attempts AS source
  SET
    state = p_source_attempt_state,
    outcome_class = p_source_outcome_class,
    updated_at = clock_timestamp()
  WHERE source.id = p_source_attempt_id
    AND source.tenant_id = resolved_tenant_id
    AND source.state = 'ambiguous';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RUN_RECONCILIATION_SOURCE_UPDATE_REJECTED'
      USING ERRCODE = '40001';
  END IF;

  UPDATE app.run_attempts AS attempt
  SET
    state = 'completed',
    outcome_class = p_reconciliation_outcome_class,
    worker_lease_expires_at = NULL,
    finished_at = clock_timestamp(),
    updated_at = clock_timestamp()
  WHERE attempt.id = p_reconciliation_attempt_id
    AND attempt.tenant_id = resolved_tenant_id
    AND attempt.state = 'claimed'
    AND attempt.fence_token = p_reconciliation_fence_token;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RUN_RECONCILIATION_FINISH_REJECTED'
      USING ERRCODE = '40001';
  END IF;

  RETURN transitioned_run;
END;
$$;

-- Operator recovery never republishes a broker message directly. It creates
-- one new durable Run-only outbox command. The normal dispatcher and Job
-- Manager then apply the same Tenant lookup, claim and fencing rules as every
-- other delivery. A terminal Run needs no replay and is reported as such.
CREATE FUNCTION app.recover_dead_lettered_run_command(
  p_original_event_id uuid,
  p_reason_code text
)
RETURNS TABLE (
  recovery_event_id uuid,
  scheduled boolean,
  terminal boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  original_event app.outbox_events%ROWTYPE;
  current_run app.runs%ROWTYPE;
  existing_recovery_event_id uuid;
  selected_recovery_event_id uuid;
  created_new_command boolean := false;
BEGIN
  IF p_reason_code NOT IN (
    'transient_infrastructure_recovered',
    'configuration_repaired',
    'manual_reconciliation_required'
  ) THEN
    RAISE EXCEPTION 'DEAD_LETTER_RECOVERY_REASON_INVALID'
      USING ERRCODE = '22023';
  END IF;

  SELECT event.* INTO original_event
  FROM app.outbox_events AS event
  WHERE event.id = p_original_event_id
    AND event.topic IN ('jobs.execute', 'jobs.cancel', 'jobs.reconcile', 'jobs.recover')
    AND event.tenant_id IS NOT NULL
    AND event.published_at IS NOT NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DEAD_LETTER_COMMAND_NOT_AUTHORITATIVE'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM set_config('app.tenant_id', original_event.tenant_id::text, true);

  SELECT run.* INTO current_run
  FROM app.runs AS run
  WHERE run.tenant_id = original_event.tenant_id
    AND run.id = original_event.aggregate_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RUN_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF current_run.internal_status IN (
    'UPSTREAM_REJECTED', 'UPSTREAM_FAILED', 'CANCELLED',
    'COMPLETED', 'PROCESSING_FAILED', 'EXPIRED'
  ) THEN
    RETURN QUERY SELECT NULL::uuid, false, true;
    RETURN;
  END IF;

  SELECT intent.recovery_event_id INTO existing_recovery_event_id
  FROM app.dead_letter_recovery_intents AS intent
  WHERE intent.original_event_id = original_event.id;

  IF FOUND THEN
    RETURN QUERY SELECT existing_recovery_event_id, false, false;
    RETURN;
  END IF;

  SELECT event.id INTO selected_recovery_event_id
  FROM app.outbox_events AS event
  WHERE event.aggregate_id = current_run.id
    AND event.topic = 'jobs.recover'
    AND event.published_at IS NULL
  ORDER BY event.created_at, event.id
  LIMIT 1
  FOR UPDATE;

  IF selected_recovery_event_id IS NULL THEN
    INSERT INTO app.outbox_events (
      aggregate_type, aggregate_id, tenant_id, topic,
      ordering_key, payload, schema_version, last_safe_error_code
    ) VALUES (
      'run', current_run.id, original_event.tenant_id, 'jobs.recover',
      current_run.id::text,
      jsonb_build_object('run_id', current_run.id::text),
      1,
      p_reason_code
    )
    RETURNING id INTO selected_recovery_event_id;
    created_new_command := true;
  END IF;

  INSERT INTO app.dead_letter_recovery_intents (
    original_event_id, recovery_event_id, reason_code
  ) VALUES (
    original_event.id, selected_recovery_event_id, p_reason_code
  );

  RETURN QUERY SELECT selected_recovery_event_id, created_new_command, false;
END;
$$;

REVOKE ALL ON FUNCTION app.schedule_run_reconciliation(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.inspect_run_reconciliation(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.complete_run_reconciliation(
  uuid, bigint, text, text, text, uuid, uuid, uuid, text, text, text,
  text, boolean, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.recover_dead_lettered_run_command(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.schedule_run_reconciliation(uuid, text),
  app.inspect_run_reconciliation(uuid),
  app.complete_run_reconciliation(
    uuid, bigint, text, text, text, uuid, uuid, uuid, text, text, text,
    text, boolean, jsonb
  )
  TO dhumi_job_manager;

GRANT EXECUTE ON FUNCTION app.recover_dead_lettered_run_command(uuid, text)
  TO dhumi_operator;

RESET ROLE;
