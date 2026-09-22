-- Tenant RLS, database role permissions, guarded Run transitions and the
-- transaction primitives that make the database the source of business truth.

SET ROLE dhumi_owner;

-- Immutable versions and append-only evidence prevent a later configuration
-- edit from rewriting the history of an admitted Run.
CREATE OR REPLACE FUNCTION app.reject_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% versions are immutable', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER adapter_versions_immutable
  BEFORE UPDATE OR DELETE ON app.adapter_versions
  FOR EACH ROW EXECUTE FUNCTION app.reject_version_mutation();
CREATE TRIGGER service_template_versions_immutable
  BEFORE UPDATE OR DELETE ON app.service_template_versions
  FOR EACH ROW EXECUTE FUNCTION app.reject_version_mutation();
CREATE TRIGGER service_versions_immutable
  BEFORE UPDATE OR DELETE ON app.service_versions
  FOR EACH ROW EXECUTE FUNCTION app.reject_version_mutation();
CREATE TRIGGER legal_acceptances_immutable
  BEFORE UPDATE OR DELETE ON app.legal_acceptances
  FOR EACH ROW EXECUTE FUNCTION app.reject_version_mutation();
CREATE TRIGGER usage_events_immutable
  BEFORE UPDATE OR DELETE ON app.usage_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_version_mutation();
CREATE TRIGGER audit_events_immutable
  BEFORE UPDATE OR DELETE ON app.audit_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_version_mutation();

-- A Run cannot drift from the Service version, Template version, Adapter
-- version, Mapping, or commercial configuration selected at admission.
CREATE OR REPLACE FUNCTION app.validate_run_version_pins()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  service_template_version_id uuid;
  template_adapter_version_id uuid;
  mapping_template_version_id uuid;
  mapping_adapter_version_id uuid;
  mapping_commercial_version text;
BEGIN
  SELECT sv.service_template_version_id
    INTO service_template_version_id
  FROM app.service_versions sv
  WHERE sv.tenant_id = NEW.tenant_id
    AND sv.id = NEW.service_version_id;

  IF service_template_version_id IS DISTINCT FROM NEW.service_template_version_id THEN
    RAISE EXCEPTION 'RUN_TEMPLATE_VERSION_PIN_MISMATCH'
      USING ERRCODE = '23514';
  END IF;

  SELECT stv.adapter_version_id
    INTO template_adapter_version_id
  FROM app.service_template_versions stv
  WHERE stv.id = NEW.service_template_version_id;

  IF template_adapter_version_id IS DISTINCT FROM NEW.adapter_version_id THEN
    RAISE EXCEPTION 'RUN_ADAPTER_VERSION_PIN_MISMATCH'
      USING ERRCODE = '23514';
  END IF;

  SELECT
    pm.service_template_version_id,
    pm.adapter_version_id,
    pm.commercial_config_version
  INTO
    mapping_template_version_id,
    mapping_adapter_version_id,
    mapping_commercial_version
  FROM app.provider_mappings pm
  WHERE pm.id = NEW.provider_mapping_id;

  IF mapping_template_version_id IS DISTINCT FROM NEW.service_template_version_id
     OR mapping_adapter_version_id IS DISTINCT FROM NEW.adapter_version_id
     OR mapping_commercial_version IS DISTINCT FROM NEW.commercial_config_version THEN
    RAISE EXCEPTION 'RUN_PROVIDER_MAPPING_PIN_MISMATCH'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER runs_validate_version_pins
  BEFORE INSERT OR UPDATE OF service_version_id, service_template_version_id,
    adapter_version_id, provider_mapping_id, commercial_config_version
  ON app.runs
  FOR EACH ROW EXECUTE FUNCTION app.validate_run_version_pins();

CREATE OR REPLACE FUNCTION app.validate_attempt_version_pins()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_adapter_version_id uuid;
  run_provider_mapping_id uuid;
  mapping_provider_credential_id uuid;
BEGIN
  SELECT run.adapter_version_id, run.provider_mapping_id
    INTO run_adapter_version_id, run_provider_mapping_id
  FROM app.runs run
  WHERE run.tenant_id = NEW.tenant_id
    AND run.id = NEW.run_id;

  SELECT mapping.provider_credential_id
    INTO mapping_provider_credential_id
  FROM app.provider_mappings mapping
  WHERE mapping.id = NEW.provider_mapping_id;

  IF NEW.adapter_version_id IS DISTINCT FROM run_adapter_version_id
     OR NEW.provider_mapping_id IS DISTINCT FROM run_provider_mapping_id
     OR NEW.provider_credential_id IS DISTINCT FROM mapping_provider_credential_id THEN
    RAISE EXCEPTION 'ATTEMPT_VERSION_PIN_MISMATCH'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER run_attempts_validate_version_pins
  BEFORE INSERT OR UPDATE OF run_id, adapter_version_id, provider_mapping_id,
    provider_credential_id
  ON app.run_attempts
  FOR EACH ROW EXECUTE FUNCTION app.validate_attempt_version_pins();

CREATE OR REPLACE FUNCTION app.validate_event_attempt_belongs_to_run()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.attempt_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM app.run_attempts attempt
    WHERE attempt.id = NEW.attempt_id
      AND attempt.tenant_id = NEW.tenant_id
      AND attempt.run_id = NEW.run_id
  ) THEN
    RAISE EXCEPTION 'RUN_EVENT_ATTEMPT_DOES_NOT_BELONG_TO_RUN'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER run_events_validate_attempt
  BEFORE INSERT ON app.run_events
  FOR EACH ROW EXECUTE FUNCTION app.validate_event_attempt_belongs_to_run();

CREATE OR REPLACE FUNCTION app.validate_artifact_attempt_belongs_to_run()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM app.run_attempts attempt
    WHERE attempt.id = NEW.attempt_id
      AND attempt.tenant_id = NEW.tenant_id
      AND attempt.run_id = NEW.run_id
  ) THEN
    RAISE EXCEPTION 'ARTIFACT_ATTEMPT_DOES_NOT_BELONG_TO_RUN'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER artifacts_validate_attempt
  BEFORE INSERT OR UPDATE OF tenant_id, run_id, attempt_id ON app.artifacts
  FOR EACH ROW EXECUTE FUNCTION app.validate_artifact_attempt_belongs_to_run();

CREATE OR REPLACE FUNCTION app.validate_usage_attempt_belongs_to_run()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.attempt_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM app.run_attempts attempt
    WHERE attempt.id = NEW.attempt_id
      AND attempt.tenant_id = NEW.tenant_id
      AND attempt.run_id = NEW.run_id
  ) THEN
    RAISE EXCEPTION 'USAGE_ATTEMPT_DOES_NOT_BELONG_TO_RUN'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER usage_events_validate_attempt
  BEFORE INSERT ON app.usage_events
  FOR EACH ROW EXECUTE FUNCTION app.validate_usage_attempt_belongs_to_run();

-- PostgreSQL enforces a small legal internal transition graph. The public
-- status is deliberately supplied with the transition so it cannot silently
-- diverge from the internal lifecycle.
CREATE TABLE app.run_status_transitions (
  from_internal_status text NOT NULL,
  to_internal_status text NOT NULL,
  to_public_status text NOT NULL,
  PRIMARY KEY (from_internal_status, to_internal_status)
);

INSERT INTO app.run_status_transitions (
  from_internal_status, to_internal_status, to_public_status
) VALUES
  ('QUEUED', 'SUBMITTED', 'running'),
  ('QUEUED', 'UPSTREAM_REJECTED', 'failed'),
  ('QUEUED', 'CANCELLED', 'cancelled'),
  ('SUBMITTED', 'RESULT_RECEIVED', 'running'),
  ('SUBMITTED', 'UPSTREAM_FAILED', 'failed'),
  ('SUBMITTED', 'CANCELLED', 'cancelled'),
  ('RESULT_RECEIVED', 'PROCESSING', 'running'),
  ('PROCESSING', 'COMPLETED', 'ready'),
  ('PROCESSING', 'PROCESSING_FAILED', 'failed'),
  ('COMPLETED', 'EXPIRED', 'expired');

CREATE OR REPLACE FUNCTION app.guard_run_status_writer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.public_status, NEW.internal_status, NEW.state_version)
     IS DISTINCT FROM
     (OLD.public_status, OLD.internal_status, OLD.state_version)
     AND current_user <> 'dhumi_job_manager' THEN
    RAISE EXCEPTION 'ONLY_JOB_MANAGER_MAY_CHANGE_RUN_STATUS'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER runs_guard_status_writer
  BEFORE UPDATE OF public_status, internal_status, state_version ON app.runs
  FOR EACH ROW EXECUTE FUNCTION app.guard_run_status_writer();

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
SECURITY INVOKER
SET search_path = app, pg_temp
AS $$
DECLARE
  current_run app.runs%ROWTYPE;
  transitioned_run app.runs%ROWTYPE;
  target_public_status text;
BEGIN
  IF current_user <> 'dhumi_job_manager' THEN
    RAISE EXCEPTION 'ONLY_JOB_MANAGER_MAY_TRANSITION_RUNS'
      USING ERRCODE = '42501';
  END IF;

  -- A redelivered internal event returns the original completed transition.
  SELECT run.*
    INTO current_run
  FROM app.run_events event
  JOIN app.runs run ON run.id = event.run_id AND run.tenant_id = event.tenant_id
  WHERE event.run_id = p_run_id
    AND event.event_idempotency_key = p_event_idempotency_key;
  IF FOUND THEN
    RETURN current_run;
  END IF;

  SELECT * INTO current_run
  FROM app.runs
  WHERE id = p_run_id
    AND tenant_id = app.require_tenant_context()
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
      WHEN p_to_internal_status = 'SUBMITTED' THEN COALESCE(started_at, clock_timestamp())
      ELSE started_at
    END,
    completed_at = CASE
      WHEN p_to_internal_status IN ('UPSTREAM_REJECTED', 'CANCELLED', 'UPSTREAM_FAILED', 'COMPLETED', 'PROCESSING_FAILED')
        THEN clock_timestamp()
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

-- The transactional outbox uses a database claim token. A queue can redeliver
-- a command, but no two dispatchers receive the same active claim.
CREATE OR REPLACE FUNCTION app.claim_outbox_events(
  p_consumer text,
  p_limit integer,
  p_claim_ttl interval DEFAULT interval '5 minutes'
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
SET search_path = app, pg_temp
AS $$
BEGIN
  IF current_user <> 'dhumi_outbox_dispatcher' THEN
    RAISE EXCEPTION 'ONLY_OUTBOX_DISPATCHER_MAY_CLAIM_EVENTS'
      USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'OUTBOX_CLAIM_LIMIT_OUT_OF_RANGE'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT event.id
    FROM app.outbox_events event
    WHERE event.published_at IS NULL
      AND event.available_at <= clock_timestamp()
      AND (event.claimed_at IS NULL OR event.claimed_at < clock_timestamp() - p_claim_ttl)
    ORDER BY event.available_at, event.created_at, event.id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE app.outbox_events event
    SET
      claimed_at = clock_timestamp(),
      claimed_by = p_consumer,
      claim_token = gen_random_uuid(),
      delivery_attempts = event.delivery_attempts + 1
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

CREATE OR REPLACE FUNCTION app.mark_outbox_event_published(
  p_event_id uuid,
  p_claim_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = app, pg_temp
AS $$
BEGIN
  IF current_user <> 'dhumi_outbox_dispatcher' THEN
    RAISE EXCEPTION 'ONLY_OUTBOX_DISPATCHER_MAY_PUBLISH_EVENTS'
      USING ERRCODE = '42501';
  END IF;

  UPDATE app.outbox_events
  SET
    published_at = clock_timestamp(),
    claimed_at = NULL,
    claimed_by = NULL,
    claim_token = NULL
  WHERE id = p_event_id
    AND claim_token = p_claim_token
    AND published_at IS NULL;

  RETURN FOUND;
END;
$$;

-- Signup is an explicit atomic transaction: idempotency record, local User,
-- Tenant, owner access, legal acceptance, audit and outbox. It cannot call a
-- provider because it has no provider-facing operation or table dependency.
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
SET search_path = app, pg_temp
AS $$
DECLARE
  existing_idempotency app.idempotency_records%ROWTYPE;
  created_user_id uuid;
  created_tenant_id uuid;
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

  SELECT * INTO existing_idempotency
  FROM app.idempotency_records
  WHERE scope_kind = 'signup'
    AND actor_fingerprint = p_actor_fingerprint
    AND operation_code = 'auth.signup'
    AND idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF FOUND THEN
    IF existing_idempotency.request_hash <> p_request_hash THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'
        USING ERRCODE = '23505';
    END IF;
    IF existing_idempotency.state = 'completed' THEN
      RETURN QUERY
      SELECT existing_idempotency.related_resource_id,
        existing_idempotency.resource_id,
        true;
      RETURN;
    END IF;
    RAISE EXCEPTION 'SIGNUP_IN_PROGRESS'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO app.idempotency_records (
    scope_kind, actor_fingerprint, operation_code, idempotency_key, request_hash,
    expires_at
  ) VALUES (
    'signup', p_actor_fingerprint, 'auth.signup', p_idempotency_key, p_request_hash,
    clock_timestamp() + interval '24 hours'
  );

  INSERT INTO app.users (email_normalized, password_hash)
  VALUES (p_email_normalized, p_password_hash)
  RETURNING id INTO created_user_id;

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
    created_tenant_id, created_user_id, 'tenant.signup', 'tenant',
    created_tenant_id, 'accepted', p_request_id
  );

  INSERT INTO app.outbox_events (
    aggregate_type, aggregate_id, tenant_id, topic, ordering_key, payload
  ) VALUES (
    'tenant', created_tenant_id, created_tenant_id, 'notifications.signup_accepted',
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
    completed_at = clock_timestamp()
  WHERE scope_kind = 'signup'
    AND actor_fingerprint = p_actor_fingerprint
    AND operation_code = 'auth.signup'
    AND idempotency_key = p_idempotency_key;

  RETURN QUERY SELECT created_user_id, created_tenant_id, false;
END;
$$;

-- Tenant RLS: no context means no rows. Identity is a separately constrained
-- local module that can perform the signup transaction before a tenant exists.
ALTER TABLE app.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenants_tenant_isolation ON app.tenants
  FOR ALL TO dhumi_customer_api, dhumi_admission, dhumi_job_manager, dhumi_result_recorder
  USING (id = app.current_tenant_id())
  WITH CHECK (id = app.current_tenant_id());
CREATE POLICY tenants_identity_access ON app.tenants
  FOR ALL TO dhumi_identity
  USING (true) WITH CHECK (true);

ALTER TABLE app.tenant_user_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tenant_user_access FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_user_access_tenant_isolation ON app.tenant_user_access
  FOR ALL TO dhumi_customer_api, dhumi_admission, dhumi_job_manager, dhumi_result_recorder
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY tenant_user_access_identity_access ON app.tenant_user_access
  FOR ALL TO dhumi_identity
  USING (true) WITH CHECK (true);

ALTER TABLE app.platform_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.platform_api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_api_keys_tenant_isolation ON app.platform_api_keys
  FOR ALL TO dhumi_customer_api, dhumi_admission, dhumi_job_manager
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY platform_api_keys_identity_access ON app.platform_api_keys
  FOR ALL TO dhumi_identity
  USING (true) WITH CHECK (true);

ALTER TABLE app.legal_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.legal_acceptances FORCE ROW LEVEL SECURITY;
CREATE POLICY legal_acceptances_tenant_isolation ON app.legal_acceptances
  FOR ALL TO dhumi_customer_api, dhumi_admission, dhumi_job_manager
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY legal_acceptances_identity_access ON app.legal_acceptances
  FOR ALL TO dhumi_identity
  USING (true) WITH CHECK (true);

ALTER TABLE app.services ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.services FORCE ROW LEVEL SECURITY;
CREATE POLICY services_tenant_isolation ON app.services
  FOR ALL TO dhumi_customer_api, dhumi_admission, dhumi_job_manager, dhumi_result_recorder
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.service_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.service_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY service_versions_tenant_isolation ON app.service_versions
  FOR ALL TO dhumi_customer_api, dhumi_admission, dhumi_job_manager, dhumi_result_recorder
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.runs FORCE ROW LEVEL SECURITY;
CREATE POLICY runs_tenant_isolation ON app.runs
  FOR ALL TO dhumi_customer_api, dhumi_admission, dhumi_job_manager, dhumi_result_recorder
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.run_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.run_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY run_attempts_tenant_isolation ON app.run_attempts
  FOR ALL TO dhumi_admission, dhumi_job_manager, dhumi_result_recorder
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.run_events FORCE ROW LEVEL SECURITY;
CREATE POLICY run_events_tenant_isolation ON app.run_events
  FOR ALL TO dhumi_customer_api, dhumi_admission, dhumi_job_manager, dhumi_result_recorder
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY artifacts_tenant_isolation ON app.artifacts
  FOR ALL TO dhumi_customer_api, dhumi_job_manager, dhumi_result_recorder
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.usage_events FORCE ROW LEVEL SECURITY;
CREATE POLICY usage_events_tenant_isolation ON app.usage_events
  FOR ALL TO dhumi_customer_api, dhumi_job_manager, dhumi_result_recorder
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.provider_cost_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.provider_cost_holds FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_cost_holds_tenant_isolation ON app.provider_cost_holds
  FOR ALL TO dhumi_admission, dhumi_job_manager
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.idempotency_records FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_records_tenant_isolation ON app.idempotency_records
  FOR ALL TO dhumi_customer_api, dhumi_admission, dhumi_job_manager
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY idempotency_records_signup_identity_access ON app.idempotency_records
  FOR ALL TO dhumi_identity
  USING (scope_kind = 'signup' AND tenant_id IS NULL)
  WITH CHECK (scope_kind = 'signup' AND tenant_id IS NULL);

ALTER TABLE app.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_events_tenant_isolation ON app.audit_events
  FOR ALL TO dhumi_admission, dhumi_job_manager, dhumi_result_recorder
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY audit_events_identity_access ON app.audit_events
  FOR ALL TO dhumi_identity
  USING (true) WITH CHECK (true);

-- Public catalogue reads are intentionally limited to published Template
-- definitions. Provider mappings, credentials and launch evidence get no
-- customer database grant.
ALTER TABLE app.service_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.service_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY service_templates_customer_read ON app.service_templates
  FOR SELECT TO dhumi_customer_api
  USING (state = 'published');
CREATE POLICY service_templates_internal_read ON app.service_templates
  FOR SELECT TO dhumi_admission, dhumi_job_manager, dhumi_result_recorder
  USING (true);

ALTER TABLE app.service_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.service_template_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY service_template_versions_customer_read ON app.service_template_versions
  FOR SELECT TO dhumi_customer_api
  USING (
    published_at IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM app.service_templates template
      WHERE template.id = service_template_id AND template.state = 'published'
    )
  );
CREATE POLICY service_template_versions_internal_read ON app.service_template_versions
  FOR SELECT TO dhumi_admission, dhumi_job_manager, dhumi_result_recorder
  USING (true);

-- Privileges intentionally follow module responsibilities. RLS still applies
-- to every tenant-scoped table granted below.
GRANT SELECT ON app.tenants, app.tenant_user_access, app.platform_api_keys,
  app.services, app.service_versions, app.runs, app.run_events, app.artifacts,
  app.usage_events, app.service_templates, app.service_template_versions
  TO dhumi_customer_api;

GRANT SELECT, INSERT, UPDATE ON app.users, app.tenants, app.tenant_user_access,
  app.auth_sessions, app.legal_acceptances, app.platform_api_keys,
  app.idempotency_records, app.audit_events, app.outbox_events
  TO dhumi_identity;

GRANT SELECT ON app.service_templates, app.service_template_versions,
  app.adapter_versions, app.provider_mappings, app.services, app.service_versions,
  app.runs, app.platform_api_keys
  TO dhumi_admission;
GRANT INSERT ON app.services, app.service_versions
  TO dhumi_admission;
GRANT INSERT ON app.idempotency_records, app.runs, app.run_events,
  app.provider_cost_holds, app.audit_events, app.outbox_events
  TO dhumi_admission;
GRANT UPDATE ON app.idempotency_records, app.provider_cost_holds, app.outbox_events
  TO dhumi_admission;

GRANT SELECT ON app.service_templates, app.service_template_versions,
  app.adapter_versions, app.provider_mappings, app.provider_credentials,
  app.runs, app.run_attempts, app.run_events, app.artifacts,
  app.usage_events, app.provider_cost_holds
  TO dhumi_job_manager;
GRANT INSERT, UPDATE ON app.runs, app.run_attempts, app.run_events,
  app.usage_events, app.provider_cost_holds, app.audit_events, app.outbox_events
  TO dhumi_job_manager;

GRANT SELECT ON app.runs, app.run_attempts, app.artifacts TO dhumi_result_recorder;
GRANT INSERT, UPDATE ON app.artifacts, app.usage_events, app.run_events,
  app.audit_events, app.outbox_events TO dhumi_result_recorder;

GRANT SELECT, UPDATE ON app.outbox_events TO dhumi_outbox_dispatcher;
GRANT SELECT ON app.run_status_transitions TO dhumi_job_manager;

REVOKE ALL ON FUNCTION app.reject_version_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.validate_run_version_pins() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.validate_attempt_version_pins() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.validate_event_attempt_belongs_to_run() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.validate_artifact_attempt_belongs_to_run() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.validate_usage_attempt_belongs_to_run() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.guard_run_status_writer() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.transition_run(uuid, bigint, text, text, text, uuid, text, boolean, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.claim_outbox_events(text, integer, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.mark_outbox_event_published(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.create_signup(text, text, text, jsonb, text, bytea, bytea, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.transition_run(uuid, bigint, text, text, text, uuid, text, boolean, jsonb)
  TO dhumi_job_manager;
GRANT EXECUTE ON FUNCTION app.claim_outbox_events(text, integer, interval),
  app.mark_outbox_event_published(uuid, uuid)
  TO dhumi_outbox_dispatcher;
GRANT EXECUTE ON FUNCTION app.create_signup(text, text, text, jsonb, text, bytea, bytea, uuid)
  TO dhumi_identity;

RESET ROLE;
