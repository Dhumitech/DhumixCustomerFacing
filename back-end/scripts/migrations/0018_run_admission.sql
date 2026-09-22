-- Durable admission, immutable execution pins and least privilege for Run creation.
--
-- This migration intentionally does not create a dispatcher or worker, call
-- Bright Data, resolve a provider credential, publish catalogue content,
-- backfill a legacy Run, enable production admission, provision a LOGIN role,
-- or modify migrations 0001-0017.

SET ROLE dhumi_owner;

-- The new values are evidence, not derivable defaults. Refuse to fabricate
-- them if this migration is ever replayed against a database containing Runs.
-- FORCE RLS would otherwise hide every row from the owner without Tenant
-- context, so lift FORCE only inside this single migration transaction.
ALTER TABLE app.runs NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM app.runs) THEN
    RAISE EXCEPTION '0018 requires app.runs to be empty before adding admission evidence';
  END IF;
END;
$$;
ALTER TABLE app.runs FORCE ROW LEVEL SECURITY;

-- A worker must execute the exact object and release evidence accepted by the
-- API; mutable current pointers are never sufficient execution authority.
ALTER TABLE app.runs
  ADD COLUMN validated_input jsonb NOT NULL,
  ADD COLUMN template_launch_evidence_id uuid NOT NULL
    REFERENCES app.launch_evidence(id) ON DELETE RESTRICT,
  ADD COLUMN mapping_launch_evidence_id uuid NOT NULL
    REFERENCES app.launch_evidence(id) ON DELETE RESTRICT,
  ADD COLUMN feature_flag_id uuid NOT NULL
    REFERENCES app.feature_flags(id) ON DELETE RESTRICT,
  ADD COLUMN feature_launch_evidence_id uuid NOT NULL
    REFERENCES app.launch_evidence(id) ON DELETE RESTRICT,
  ADD CONSTRAINT runs_validated_input_object_check
    CHECK (jsonb_typeof(validated_input) = 'object');

-- Execution authority cannot drift after admission even when a future status
-- transition updates the mutable Run lifecycle fields.
CREATE FUNCTION app.guard_run_admission_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF (
    NEW.tenant_id,
    NEW.service_version_id,
    NEW.service_template_version_id,
    NEW.adapter_version_id,
    NEW.provider_mapping_id,
    NEW.commercial_config_version,
    NEW.validated_input,
    NEW.template_launch_evidence_id,
    NEW.mapping_launch_evidence_id,
    NEW.feature_flag_id,
    NEW.feature_launch_evidence_id,
    NEW.retry_of_run_id,
    NEW.accepted_at,
    NEW.created_at
  ) IS DISTINCT FROM (
    OLD.tenant_id,
    OLD.service_version_id,
    OLD.service_template_version_id,
    OLD.adapter_version_id,
    OLD.provider_mapping_id,
    OLD.commercial_config_version,
    OLD.validated_input,
    OLD.template_launch_evidence_id,
    OLD.mapping_launch_evidence_id,
    OLD.feature_flag_id,
    OLD.feature_launch_evidence_id,
    OLD.retry_of_run_id,
    OLD.accepted_at,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'RUN_ADMISSION_FIELDS_ARE_IMMUTABLE'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER runs_admission_fields_immutable
  BEFORE UPDATE ON app.runs
  FOR EACH ROW EXECUTE FUNCTION app.guard_run_admission_fields();

-- The Run must be internally coherent across its same-Tenant Service pin,
-- Template/Adapter/Mapping pins and every release-evidence identity.
CREATE OR REPLACE FUNCTION app.validate_run_version_pins()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  pinned_service_template_version_id uuid;
  pinned_template_id uuid;
  template_adapter_version_id uuid;
  template_launch_evidence_id uuid;
  template_product_family text;
  mapping_template_version_id uuid;
  mapping_adapter_version_id uuid;
  mapping_commercial_version text;
  mapping_launch_evidence_id uuid;
  mapping_environment text;
  feature_code text;
  feature_environment text;
  feature_launch_evidence_id uuid;
BEGIN
  SELECT
    service_version.service_template_version_id,
    service.service_template_id
  INTO
    pinned_service_template_version_id,
    pinned_template_id
  FROM app.service_versions AS service_version
  JOIN app.services AS service
    ON service.tenant_id = service_version.tenant_id
   AND service.id = service_version.service_id
  WHERE service_version.tenant_id = NEW.tenant_id
    AND service_version.id = NEW.service_version_id;

  IF pinned_service_template_version_id IS DISTINCT FROM NEW.service_template_version_id THEN
    RAISE EXCEPTION 'RUN_TEMPLATE_VERSION_PIN_MISMATCH'
      USING ERRCODE = '23514';
  END IF;

  SELECT
    template_version.adapter_version_id,
    template_version.launch_evidence_id,
    template.product_family
  INTO
    template_adapter_version_id,
    template_launch_evidence_id,
    template_product_family
  FROM app.service_template_versions AS template_version
  JOIN app.service_templates AS template
    ON template.id = template_version.service_template_id
  WHERE template_version.id = NEW.service_template_version_id
    AND template.id = pinned_template_id;

  IF template_adapter_version_id IS DISTINCT FROM NEW.adapter_version_id
     OR template_launch_evidence_id IS DISTINCT FROM NEW.template_launch_evidence_id THEN
    RAISE EXCEPTION 'RUN_TEMPLATE_RELEASE_PIN_MISMATCH'
      USING ERRCODE = '23514';
  END IF;

  SELECT
    mapping.service_template_version_id,
    mapping.adapter_version_id,
    mapping.commercial_config_version,
    mapping.launch_evidence_id,
    mapping.environment
  INTO
    mapping_template_version_id,
    mapping_adapter_version_id,
    mapping_commercial_version,
    mapping_launch_evidence_id,
    mapping_environment
  FROM app.provider_mappings AS mapping
  WHERE mapping.id = NEW.provider_mapping_id;

  IF mapping_template_version_id IS DISTINCT FROM NEW.service_template_version_id
     OR mapping_adapter_version_id IS DISTINCT FROM NEW.adapter_version_id
     OR mapping_commercial_version IS DISTINCT FROM NEW.commercial_config_version
     OR mapping_launch_evidence_id IS DISTINCT FROM NEW.mapping_launch_evidence_id THEN
    RAISE EXCEPTION 'RUN_PROVIDER_MAPPING_PIN_MISMATCH'
      USING ERRCODE = '23514';
  END IF;

  SELECT
    flag.feature_code,
    flag.environment,
    flag.launch_evidence_id
  INTO
    feature_code,
    feature_environment,
    feature_launch_evidence_id
  FROM app.feature_flags AS flag
  WHERE flag.id = NEW.feature_flag_id;

  IF feature_code IS DISTINCT FROM template_product_family
     OR feature_environment IS DISTINCT FROM mapping_environment
     OR feature_launch_evidence_id IS DISTINCT FROM NEW.feature_launch_evidence_id THEN
    RAISE EXCEPTION 'RUN_FEATURE_RELEASE_PIN_MISMATCH'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER runs_validate_version_pins ON app.runs;
CREATE TRIGGER runs_validate_version_pins
  BEFORE INSERT OR UPDATE OF service_version_id, service_template_version_id,
    adapter_version_id, provider_mapping_id, commercial_config_version,
    template_launch_evidence_id, mapping_launch_evidence_id, feature_flag_id,
    feature_launch_evidence_id
  ON app.runs
  FOR EACH ROW EXECUTE FUNCTION app.validate_run_version_pins();

-- A completed claim is the permanent exact replay tombstone for the accepted
-- Run. An incomplete or failed claim can never masquerade as a second success.
ALTER TABLE app.idempotency_records
  ADD CONSTRAINT idempotency_records_run_create_semantics_check
  CHECK (
    operation_code <> 'runs.create'
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

-- A jobs.execute command is only a Run identifier. The worker must resolve
-- trusted Tenant, input and private pins from PostgreSQL after dequeue.
ALTER TABLE app.outbox_events
  ADD CONSTRAINT outbox_events_jobs_execute_shape_check
  CHECK (
    topic <> 'jobs.execute'
    OR (
      aggregate_type = 'run'
      AND tenant_id IS NOT NULL
      AND ordering_key = aggregate_id::text
      AND schema_version = 1
      AND jsonb_typeof(payload) = 'object'
      AND payload - 'run_id' = '{}'::jsonb
      AND payload ->> 'run_id' = aggregate_id::text
    )
  );

CREATE UNIQUE INDEX outbox_events_one_jobs_execute_per_run_idx
  ON app.outbox_events (aggregate_id)
  WHERE topic = 'jobs.execute';

-- The accepted Phase-5 profile is deliberately local/test-only. Its advisory
-- lock covers the checks and the caller's subsequent Run/outbox commit so the
-- last global slot cannot be accepted concurrently by two Tenants.
CREATE FUNCTION app.require_phase5_mock_run_capacity(p_environment text)
RETURNS TABLE (
  profile_code text,
  estimated_amount_micros bigint,
  currency_code text,
  unit text,
  evidence_reference text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  resolved_tenant_id uuid;
  recent_tenant_runs bigint;
  pending_jobs bigint;
  oldest_due_job timestamptz;
BEGIN
  resolved_tenant_id := app.require_tenant_context();
  IF p_environment IS NULL OR p_environment NOT IN ('local', 'test') THEN
    RAISE EXCEPTION 'PHASE5_MOCK_ADMISSION_ENVIRONMENT_UNAVAILABLE'
      USING ERRCODE = 'P5104';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('phase5_mock_admission_v1:' || p_environment, 0)
  );

  SELECT min(event.created_at)
    INTO oldest_due_job
  FROM app.outbox_events AS event
  WHERE event.topic = 'jobs.execute'
    AND event.published_at IS NULL
    AND event.available_at <= statement_timestamp();

  IF oldest_due_job IS NOT NULL
     AND oldest_due_job < statement_timestamp() - interval '300 seconds' THEN
    RAISE EXCEPTION 'PHASE5_MOCK_ADMISSION_QUEUE_STALE'
      USING ERRCODE = 'P5103';
  END IF;

  SELECT count(*)
    INTO pending_jobs
  FROM app.outbox_events AS event
  WHERE event.topic = 'jobs.execute'
    AND event.published_at IS NULL;

  IF pending_jobs >= 100 THEN
    RAISE EXCEPTION 'PHASE5_MOCK_ADMISSION_QUEUE_CAPACITY'
      USING ERRCODE = 'P5102';
  END IF;

  SELECT count(*)
    INTO recent_tenant_runs
  FROM app.runs AS run
  WHERE run.tenant_id = resolved_tenant_id
    AND run.accepted_at >= statement_timestamp() - interval '60 seconds';

  IF recent_tenant_runs >= 30 THEN
    RAISE EXCEPTION 'PHASE5_MOCK_ADMISSION_TENANT_CAPACITY'
      USING ERRCODE = 'P5101';
  END IF;

  RETURN QUERY SELECT
    'phase5_mock_admission_v1'::text,
    0::bigint,
    'USD'::text,
    'mock_run'::text,
    'phase5_mock_admission_v1'::text;
END;
$$;

-- Customer reads keep only the future public Run projection. Validated input,
-- provider/evidence pins and internal status stay outside that capability.
REVOKE SELECT ON app.runs FROM dhumi_customer_api;
GRANT SELECT (
  id,
  tenant_id,
  service_version_id,
  public_status,
  retryable,
  customer_error_code,
  accepted_at,
  created_at,
  updated_at,
  completed_at
) ON app.runs TO dhumi_customer_api;

-- Admission resolves only the columns required to lock a Service and prove a
-- coherent release snapshot. Provider credentials and encrypted resources
-- remain inaccessible.
REVOKE SELECT ON app.services FROM dhumi_admission;
REVOKE SELECT ON app.service_versions FROM dhumi_admission;
REVOKE SELECT ON app.service_templates FROM dhumi_admission;
REVOKE SELECT ON app.service_template_versions FROM dhumi_admission;
REVOKE SELECT ON app.feature_flags FROM dhumi_admission;

GRANT SELECT (id, tenant_id, service_template_id, name, state, current_version, created_at)
  ON app.services TO dhumi_admission;
GRANT SELECT (id, tenant_id, service_id, version, service_template_version_id)
  ON app.service_versions TO dhumi_admission;
GRANT SELECT (id, slug, product_family, state, current_public_version_id)
  ON app.service_templates TO dhumi_admission;
GRANT SELECT (
  id,
  service_template_id,
  version,
  input_schema,
  adapter_version_id,
  launch_evidence_id,
  availability_state,
  effective_at,
  published_at
) ON app.service_template_versions TO dhumi_admission;
GRANT SELECT (id, feature_code, environment, state, launch_evidence_id, expires_at)
  ON app.feature_flags TO dhumi_admission;
GRANT SELECT (commercial_config_version)
  ON app.provider_mappings TO dhumi_admission;

-- Admission may write one exact aggregate but cannot later rewrite outbox
-- delivery metadata, Run lifecycle, immutable history or cost settlement.
REVOKE SELECT ON app.runs FROM dhumi_admission;
REVOKE INSERT ON app.runs FROM dhumi_admission;
REVOKE INSERT ON app.run_events FROM dhumi_admission;
REVOKE INSERT ON app.provider_cost_holds FROM dhumi_admission;
REVOKE INSERT ON app.outbox_events FROM dhumi_admission;
REVOKE UPDATE ON app.provider_cost_holds FROM dhumi_admission;
REVOKE UPDATE ON app.outbox_events FROM dhumi_admission;

GRANT SELECT (id, tenant_id, accepted_at) ON app.runs TO dhumi_admission;
GRANT INSERT (
  id,
  tenant_id,
  service_version_id,
  service_template_version_id,
  adapter_version_id,
  provider_mapping_id,
  commercial_config_version,
  validated_input,
  template_launch_evidence_id,
  mapping_launch_evidence_id,
  feature_flag_id,
  feature_launch_evidence_id,
  public_status,
  internal_status,
  state_version,
  retryable
) ON app.runs TO dhumi_admission;
GRANT INSERT (
  id,
  tenant_id,
  run_id,
  sequence,
  event_type,
  source,
  event_idempotency_key,
  safe_payload
) ON app.run_events TO dhumi_admission;
GRANT INSERT (
  id,
  tenant_id,
  run_id,
  provider_code,
  product_family,
  commercial_config_version,
  evidence_reference,
  estimated_amount_micros,
  currency_code,
  unit,
  state
) ON app.provider_cost_holds TO dhumi_admission;
GRANT INSERT (
  id,
  aggregate_type,
  aggregate_id,
  tenant_id,
  topic,
  ordering_key,
  payload,
  schema_version
) ON app.outbox_events TO dhumi_admission;

REVOKE ALL ON FUNCTION app.guard_run_admission_fields() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.validate_run_version_pins() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.require_phase5_mock_run_capacity(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.require_phase5_mock_run_capacity(text)
  TO dhumi_admission;

RESET ROLE;
