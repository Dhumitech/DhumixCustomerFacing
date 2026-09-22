-- Forward-only corrections from the 2026-08-17 database integrity audit.
-- This migration alters existing objects only. It creates no business table,
-- calls no provider, and stores no plaintext Dhumi or Bright Data credential.

SET ROLE dhumi_owner;

-- The transition graph already contains SUBMITTED -> UPSTREAM_FAILED. The Run
-- row constraint must accept every state that the graph can legally produce.
ALTER TABLE app.runs
  DROP CONSTRAINT runs_internal_status_check;

ALTER TABLE app.runs
  ADD CONSTRAINT runs_internal_status_check
  CHECK (internal_status IN (
    'QUEUED',
    'SUBMITTED',
    'UPSTREAM_REJECTED',
    'UPSTREAM_FAILED',
    'CANCELLED',
    'RESULT_RECEIVED',
    'PROCESSING',
    'COMPLETED',
    'PROCESSING_FAILED',
    'EXPIRED'
  ));

-- ADR-0006 requires short-lived, envelope-encrypted recovery of the successful
-- POST /v1/keys response. The plaintext key is never stored. These columns are
-- null for every idempotent operation that does not need secret recovery.
ALTER TABLE app.idempotency_records
  ADD COLUMN response_envelope_ciphertext bytea,
  ADD COLUMN response_envelope_key_reference text,
  ADD COLUMN response_envelope_recoverable_until timestamptz,
  ADD COLUMN response_envelope_destroyed_at timestamptz;

ALTER TABLE app.idempotency_records
  ADD CONSTRAINT idempotency_response_envelope_state_check
  CHECK (
    (
      response_envelope_ciphertext IS NULL
      AND response_envelope_key_reference IS NULL
      AND response_envelope_recoverable_until IS NULL
      AND response_envelope_destroyed_at IS NULL
    )
    OR
    (
      response_envelope_ciphertext IS NOT NULL
      AND response_envelope_key_reference IS NOT NULL
      AND response_envelope_recoverable_until IS NOT NULL
      AND response_envelope_destroyed_at IS NULL
    )
    OR
    (
      response_envelope_ciphertext IS NULL
      AND response_envelope_key_reference IS NULL
      AND response_envelope_recoverable_until IS NOT NULL
      AND response_envelope_destroyed_at IS NOT NULL
    )
  );

-- A pinned Provider Mapping must never change meaning. Run Events are ordered
-- history and are append-only. New configuration/history is inserted as a new
-- row; existing rows cannot be rewritten or deleted.
CREATE TRIGGER provider_mappings_immutable
  BEFORE UPDATE OR DELETE ON app.provider_mappings
  FOR EACH ROW EXECUTE FUNCTION app.reject_version_mutation();

CREATE TRIGGER run_events_immutable
  BEFORE UPDATE OR DELETE ON app.run_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_version_mutation();

-- The transition function becomes the only runtime path that can update Run
-- status. Its owner is the non-login migration owner. FORCE RLS still applies,
-- so the tables used by the function and its validation trigger include that owner and
-- continue to require transaction-local Tenant context.
DROP POLICY runs_tenant_isolation ON app.runs;
CREATE POLICY runs_tenant_isolation ON app.runs
  FOR ALL TO dhumi_customer_api, dhumi_admission, dhumi_job_manager,
    dhumi_result_recorder, dhumi_owner
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY run_events_tenant_isolation ON app.run_events;
CREATE POLICY run_events_tenant_isolation ON app.run_events
  FOR ALL TO dhumi_customer_api, dhumi_admission, dhumi_job_manager,
    dhumi_result_recorder, dhumi_owner
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY run_attempts_tenant_isolation ON app.run_attempts;
CREATE POLICY run_attempts_tenant_isolation ON app.run_attempts
  FOR ALL TO dhumi_admission, dhumi_job_manager, dhumi_result_recorder, dhumi_owner
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE OR REPLACE FUNCTION app.guard_run_status_writer()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF (NEW.public_status, NEW.internal_status, NEW.state_version)
     IS DISTINCT FROM
     (OLD.public_status, OLD.internal_status, OLD.state_version)
     AND NOT (
       current_user = 'dhumi_owner'
       AND COALESCE(
         current_setting('app.run_transition_writer', true) = 'on',
         false
       )
     ) THEN
    RAISE EXCEPTION 'ONLY_GUARDED_TRANSITION_MAY_CHANGE_RUN_STATUS'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

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

  INSERT INTO app.run_events (
    tenant_id, run_id, sequence, event_type, source, attempt_id,
    event_idempotency_key, safe_payload
  ) VALUES (
    transitioned_run.tenant_id,
    transitioned_run.id,
    transitioned_run.state_version,
    p_event_type,
    'job_manager',
    p_attempt_id,
    p_event_idempotency_key,
    p_safe_payload
  );

  RETURN transitioned_run;
END;
$$;

-- Signup claims a previously missing idempotency key atomically. ON CONFLICT
-- waits for a concurrent winner and prevents two first requests from both
-- proceeding. An existing email completes the same generic accepted response
-- without creating another User, Tenant, access row, or legal acceptance.
CREATE OR REPLACE FUNCTION app.create_signup(
  p_email_normalized text,
  p_password_hash text,
  p_workspace_name text,
  p_legal_acceptances jsonb,
  p_idempotency_key text,
  p_request_hash bytea,
  p_actor_fingerprint bytea,
  p_request_id uuid DEFAULT NULL
)
RETURNS TABLE (user_id uuid, tenant_id uuid, replayed boolean)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  idempotency_row app.idempotency_records%ROWTYPE;
  claim_won boolean;
  created_user_id uuid;
  created_tenant_id uuid;
  existing_user_id uuid;
  existing_tenant_id uuid;
BEGIN
  IF current_user <> 'dhumi_identity' THEN
    RAISE EXCEPTION 'ONLY_IDENTITY_MODULE_MAY_CREATE_SIGNUPS'
      USING ERRCODE = '42501';
  END IF;

  IF p_email_normalized <> lower(p_email_normalized)
     OR length(trim(p_workspace_name)) = 0
     OR jsonb_typeof(p_legal_acceptances) <> 'array'
     OR jsonb_array_length(p_legal_acceptances) = 0 THEN
    RAISE EXCEPTION 'SIGNUP_INPUT_INVALID'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO app.idempotency_records (
    scope_kind, actor_fingerprint, operation_code, idempotency_key,
    request_hash, expires_at
  ) VALUES (
    'signup', p_actor_fingerprint, 'auth.signup', p_idempotency_key,
    p_request_hash, clock_timestamp() + interval '24 hours'
  )
  ON CONFLICT (actor_fingerprint, operation_code, idempotency_key)
    WHERE scope_kind = 'signup'
  DO NOTHING
  RETURNING * INTO idempotency_row;

  claim_won := FOUND;

  IF NOT claim_won THEN
    SELECT *
      INTO idempotency_row
    FROM app.idempotency_records
    WHERE scope_kind = 'signup'
      AND actor_fingerprint = p_actor_fingerprint
      AND operation_code = 'auth.signup'
      AND idempotency_key = p_idempotency_key
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CLAIM_NOT_FOUND'
        USING ERRCODE = '55000';
    END IF;

    IF idempotency_row.request_hash <> p_request_hash THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'
        USING ERRCODE = '23505';
    END IF;

    IF idempotency_row.state = 'completed' THEN
      RETURN QUERY
      SELECT
        idempotency_row.related_resource_id,
        idempotency_row.resource_id,
        true;
      RETURN;
    END IF;

    RAISE EXCEPTION 'SIGNUP_IN_PROGRESS'
      USING ERRCODE = '55000';
  END IF;

  -- The unique email insert is also concurrency-safe for two different
  -- idempotency keys submitted for the same normalized email.
  INSERT INTO app.users (email_normalized, password_hash)
  VALUES (p_email_normalized, p_password_hash)
  ON CONFLICT (email_normalized) DO NOTHING
  RETURNING id INTO created_user_id;

  IF created_user_id IS NULL THEN
    SELECT id
      INTO existing_user_id
    FROM app.users
    WHERE email_normalized = p_email_normalized;

    IF existing_user_id IS NULL THEN
      RAISE EXCEPTION 'EXISTING_IDENTITY_NOT_FOUND_AFTER_CONFLICT'
        USING ERRCODE = '55000';
    END IF;

    SELECT access.tenant_id
      INTO existing_tenant_id
    FROM app.tenant_user_access access
    WHERE access.user_id = existing_user_id
      AND access.state = 'active'
    ORDER BY access.created_at, access.tenant_id
    LIMIT 1;

    INSERT INTO app.audit_events (
      tenant_id, action, target_type, target_id, outcome, request_id
    ) VALUES (
      existing_tenant_id,
      'identity.signup_existing',
      'user',
      existing_user_id,
      'accepted_generic',
      p_request_id
    );

    INSERT INTO app.outbox_events (
      aggregate_type, aggregate_id, tenant_id, topic, ordering_key, payload
    ) VALUES (
      'user',
      existing_user_id,
      existing_tenant_id,
      'notifications.signup_existing_identity',
      existing_user_id::text,
      jsonb_build_object('user_id', existing_user_id)
    );

    UPDATE app.idempotency_records
    SET
      state = 'completed',
      response_status = 202,
      resource_type = 'signup_request',
      resource_id = NULL,
      related_resource_id = NULL,
      response_body_reference = 'auth-accepted:v1',
      completed_at = clock_timestamp()
    WHERE id = idempotency_row.id;

    RETURN QUERY SELECT NULL::uuid, NULL::uuid, false;
    RETURN;
  END IF;

  INSERT INTO app.tenants (display_name)
  VALUES (p_workspace_name)
  RETURNING id INTO created_tenant_id;

  INSERT INTO app.tenant_user_access (tenant_id, user_id, access_role)
  VALUES (created_tenant_id, created_user_id, 'owner');

  INSERT INTO app.legal_acceptances (
    user_id, tenant_id, document_type, document_version, document_hash,
    disclosure_version, locale, request_id, acceptance_method
  )
  SELECT
    created_user_id,
    created_tenant_id,
    item.value->>'document_type',
    item.value->>'document_version',
    decode(item.value->>'document_hash_hex', 'hex'),
    item.value->>'disclosure_version',
    COALESCE(item.value->>'locale', 'en'),
    p_request_id,
    'signup'
  FROM jsonb_array_elements(p_legal_acceptances) AS item(value);

  INSERT INTO app.audit_events (
    tenant_id, actor_user_id, action, target_type, target_id, outcome, request_id
  ) VALUES (
    created_tenant_id,
    created_user_id,
    'tenant.signup',
    'tenant',
    created_tenant_id,
    'accepted',
    p_request_id
  );

  INSERT INTO app.outbox_events (
    aggregate_type, aggregate_id, tenant_id, topic, ordering_key, payload
  ) VALUES (
    'tenant',
    created_tenant_id,
    created_tenant_id,
    'notifications.signup_accepted',
    created_tenant_id::text,
    jsonb_build_object('tenant_id', created_tenant_id, 'user_id', created_user_id)
  );

  UPDATE app.idempotency_records
  SET
    state = 'completed',
    response_status = 202,
    resource_type = 'tenant',
    resource_id = created_tenant_id,
    related_resource_id = created_user_id,
    response_body_reference = 'auth-accepted:v1',
    completed_at = clock_timestamp()
  WHERE id = idempotency_row.id;

  RETURN QUERY SELECT created_user_id, created_tenant_id, false;
END;
$$;

-- Remove powers that bypass module boundaries. Producers insert outbox rows;
-- only the dispatcher updates delivery metadata. Run history is insert-only.
REVOKE UPDATE ON app.run_events
  FROM dhumi_job_manager, dhumi_result_recorder;

REVOKE UPDATE ON app.outbox_events
  FROM dhumi_identity, dhumi_admission, dhumi_job_manager, dhumi_result_recorder;

REVOKE SELECT ON app.provider_credentials
  FROM dhumi_job_manager;

REVOKE UPDATE ON app.runs
  FROM dhumi_job_manager;

-- CREATE OR REPLACE retains existing ACLs, but repeat these rules explicitly so
-- a future privilege drift is visible in this correction migration.
REVOKE ALL ON FUNCTION app.guard_run_status_writer() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.transition_run(uuid, bigint, text, text, text, uuid, text, boolean, jsonb)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app.create_signup(text, text, text, jsonb, text, bytea, bytea, uuid)
  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.transition_run(uuid, bigint, text, text, text, uuid, text, boolean, jsonb)
  TO dhumi_job_manager;
GRANT EXECUTE ON FUNCTION app.create_signup(text, text, text, jsonb, text, bytea, bytea, uuid)
  TO dhumi_identity;

RESET ROLE;
