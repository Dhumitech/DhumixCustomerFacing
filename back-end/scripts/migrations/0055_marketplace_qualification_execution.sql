-- M9 live qualification evidence boundary.
--
-- This migration extends the already-authorized operator packet with a direct
-- qualification lifecycle. It does not create a customer route, entitlement,
-- Service, Run, outbox event, provider mapping or public Template pointer.

SET ROLE dhumi_owner;

ALTER TABLE app.marketplace_qualification_packets
  ADD CONSTRAINT marketplace_qualification_provider_job_deadline_check
    CHECK (poll_deadline_ms <= 300000),
  ADD COLUMN execution_state text NOT NULL DEFAULT 'not_started'
    CHECK (execution_state IN (
      'not_started', 'submitting', 'polling', 'succeeded', 'failed', 'uncertain'
    )),
  ADD COLUMN request_object_key text,
  ADD COLUMN request_checksum bytea,
  ADD COLUMN request_content_type text,
  ADD COLUMN request_byte_count bigint,
  ADD COLUMN provider_snapshot_ciphertext bytea,
  ADD COLUMN provider_snapshot_fingerprint bytea,
  ADD COLUMN provider_last_status text,
  ADD COLUMN provider_poll_count integer NOT NULL DEFAULT 0
    CHECK (provider_poll_count >= 0),
  ADD COLUMN raw_object_key text,
  ADD COLUMN raw_checksum bytea,
  ADD COLUMN raw_content_type text,
  ADD COLUMN raw_byte_count bigint,
  ADD COLUMN raw_record_count integer,
  ADD COLUMN normalized_object_key text,
  ADD COLUMN normalized_checksum bytea,
  ADD COLUMN normalized_content_type text,
  ADD COLUMN normalized_byte_count bigint,
  ADD COLUMN normalized_record_count integer,
  ADD COLUMN observed_cost_micros bigint,
  ADD COLUMN observed_currency_code text,
  ADD COLUMN safe_error_code text,
  ADD COLUMN execution_started_at timestamptz,
  ADD COLUMN execution_completed_at timestamptz,
  ADD COLUMN execution_outcome_class text;

ALTER TABLE app.marketplace_qualification_packets
  ADD CONSTRAINT marketplace_qualification_execution_values_check CHECK (
    (request_checksum IS NULL OR octet_length(request_checksum) = 32)
    AND (request_content_type IS NULL OR request_content_type = 'application/json')
    AND (request_byte_count IS NULL OR request_byte_count >= 2)
    AND (
      provider_snapshot_ciphertext IS NULL
      OR octet_length(provider_snapshot_ciphertext) > 29
    )
    AND (
      provider_snapshot_fingerprint IS NULL
      OR octet_length(provider_snapshot_fingerprint) = 32
    )
    AND (raw_checksum IS NULL OR octet_length(raw_checksum) = 32)
    AND (raw_content_type IS NULL OR raw_content_type = 'application/json')
    AND (raw_byte_count IS NULL OR raw_byte_count >= 2)
    AND (raw_record_count IS NULL OR raw_record_count >= 0)
    AND (normalized_checksum IS NULL OR octet_length(normalized_checksum) = 32)
    AND (
      normalized_content_type IS NULL
      OR normalized_content_type = 'application/json'
    )
    AND (normalized_byte_count IS NULL OR normalized_byte_count >= 2)
    AND (normalized_record_count IS NULL OR normalized_record_count >= 0)
    AND (observed_cost_micros IS NULL OR observed_cost_micros >= 0)
    AND (observed_currency_code IS NULL OR observed_currency_code = 'USD')
    AND (
      safe_error_code IS NULL
      OR safe_error_code ~ '^[A-Z][A-Z0-9_]{2,127}$'
    )
  ),
  ADD CONSTRAINT marketplace_qualification_execution_coherence_check CHECK (
    (
      execution_state = 'not_started'
      AND request_object_key IS NULL
      AND request_checksum IS NULL
      AND request_content_type IS NULL
      AND request_byte_count IS NULL
      AND provider_snapshot_ciphertext IS NULL
      AND provider_snapshot_fingerprint IS NULL
      AND execution_started_at IS NULL
      AND execution_completed_at IS NULL
      AND safe_error_code IS NULL
    )
    OR
    (
      execution_state = 'submitting'
      AND request_object_key IS NOT NULL
      AND request_checksum IS NOT NULL
      AND request_content_type = 'application/json'
      AND request_byte_count IS NOT NULL
      AND provider_snapshot_ciphertext IS NULL
      AND provider_snapshot_fingerprint IS NULL
      AND execution_started_at IS NOT NULL
      AND execution_completed_at IS NULL
      AND safe_error_code IS NULL
    )
    OR
    (
      execution_state = 'polling'
      AND request_object_key IS NOT NULL
      AND request_checksum IS NOT NULL
      AND provider_snapshot_ciphertext IS NOT NULL
      AND provider_snapshot_fingerprint IS NOT NULL
      AND execution_started_at IS NOT NULL
      AND execution_completed_at IS NULL
      AND safe_error_code IS NULL
    )
    OR
    (
      execution_state = 'succeeded'
      AND request_object_key IS NOT NULL
      AND request_checksum IS NOT NULL
      AND provider_snapshot_ciphertext IS NOT NULL
      AND provider_snapshot_fingerprint IS NOT NULL
      AND provider_last_status = 'ready'
      AND raw_object_key IS NOT NULL
      AND raw_checksum IS NOT NULL
      AND raw_byte_count IS NOT NULL
      AND raw_record_count IS NOT NULL
      AND normalized_object_key IS NOT NULL
      AND normalized_checksum IS NOT NULL
      AND normalized_byte_count IS NOT NULL
      AND normalized_record_count IS NOT NULL
      AND observed_cost_micros IS NOT NULL
      AND observed_currency_code = 'USD'
      AND safe_error_code IS NULL
      AND execution_started_at IS NOT NULL
      AND execution_completed_at IS NOT NULL
      AND execution_outcome_class = 'provider_execution_completed'
    )
    OR
    (
      execution_state IN ('failed', 'uncertain')
      AND safe_error_code IS NOT NULL
      AND execution_completed_at IS NOT NULL
      AND execution_outcome_class IS NOT NULL
    )
  );

-- M8 already proves the customer Run/outbox/Attempt/usage/download machinery.
-- M9 is a direct, protected qualification operation and therefore freezes only
-- evidence that this operator can produce and bind to this exact packet.
CREATE OR REPLACE FUNCTION app.prepare_marketplace_qualification_packet(
  p_packet_id uuid,
  p_candidate_id uuid,
  p_template_version_id uuid,
  p_filter_adapter_version_id uuid,
  p_environment text,
  p_provider_resource_fingerprint bytea,
  p_exact_request jsonb,
  p_maximum_estimated_cost_micros bigint,
  p_currency_code text,
  p_maximum_provider_submissions integer,
  p_automatic_submission_retries integer,
  p_poll_deadline_ms integer,
  p_expected_evidence text[],
  p_actor text
)
RETURNS TABLE (
  packet_id uuid,
  request_fingerprint bytea,
  authorization_state text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  context_row record;
  properties jsonb;
  selected_fields jsonb;
  calculated_fingerprint bytea;
  existing app.marketplace_qualification_packets%ROWTYPE;
  required_evidence constant text[] := ARRAY[
    'authorization_audit', 'request', 'protected_snapshot_reference',
    'poll_checkpoints', 'raw_artifact', 'normalized_artifact',
    'checksums', 'cost', 'execution_audit'
  ]::text[];
BEGIN
  SELECT * INTO context_row
  FROM app.resolve_marketplace_qualification_context(p_candidate_id, p_environment);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MARKETPLACE_QUALIFICATION_CONTEXT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  properties := context_row.output_schema -> 'items' -> 'properties';
  selected_fields := p_exact_request -> 'selected_fields';
  IF p_packet_id IS NULL
     OR p_template_version_id IS DISTINCT FROM context_row.template_version_id
     OR p_filter_adapter_version_id IS DISTINCT FROM context_row.filter_adapter_version_id
     OR p_provider_resource_fingerprint IS DISTINCT FROM context_row.provider_resource_fingerprint
     OR jsonb_typeof(properties) <> 'object'
     OR jsonb_typeof(p_exact_request) <> 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_exact_request)) <> 3
     OR NOT (p_exact_request ?& ARRAY['records_limit', 'selected_fields', 'filter'])
     OR jsonb_typeof(p_exact_request -> 'records_limit') <> 'number'
     OR (p_exact_request ->> 'records_limit') !~ '^[1-9][0-9]*$'
     OR (p_exact_request ->> 'records_limit')::numeric > 9007199254740991
     OR jsonb_typeof(selected_fields) <> 'array'
     OR jsonb_array_length(selected_fields) NOT BETWEEN 1 AND 100
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(selected_fields) AS field
       WHERE jsonb_typeof(field) <> 'string'
          OR NOT (properties ? (field #>> '{}'))
     )
     OR (
       SELECT count(*) <> count(DISTINCT field #>> '{}')
       FROM jsonb_array_elements(selected_fields) AS field
     )
     OR NOT app.marketplace_qualification_filter_valid(
       p_exact_request -> 'filter', properties, 1
     )
     OR p_maximum_estimated_cost_micros IS NULL
     OR p_maximum_estimated_cost_micros <= 0
     OR p_currency_code IS DISTINCT FROM 'USD'
     OR p_maximum_provider_submissions IS DISTINCT FROM 1
     OR p_automatic_submission_retries IS DISTINCT FROM 0
     OR p_poll_deadline_ms IS NULL OR p_poll_deadline_ms NOT BETWEEN 1 AND 300000
     OR p_expected_evidence IS DISTINCT FROM required_evidence
     OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$' THEN
    RAISE EXCEPTION 'MARKETPLACE_QUALIFICATION_PACKET_INVALID' USING ERRCODE = '22023';
  END IF;

  calculated_fingerprint := sha256(
    convert_to(
      jsonb_build_object(
        'operation_code', 'marketplace.dataset.filter',
        'provider_resource_fingerprint', encode(p_provider_resource_fingerprint, 'hex'),
        'exact_request', p_exact_request,
        'maximum_estimated_cost_micros', p_maximum_estimated_cost_micros,
        'currency_code', p_currency_code,
        'maximum_provider_submissions', p_maximum_provider_submissions,
        'automatic_submission_retries', p_automatic_submission_retries,
        'poll_deadline_ms', p_poll_deadline_ms,
        'expected_artifact_kinds', to_jsonb(ARRAY['raw', 'normalized']::text[]),
        'expected_evidence', to_jsonb(p_expected_evidence)
      )::text,
      'UTF8'
    )
  );

  SELECT packet.* INTO existing
  FROM app.marketplace_qualification_packets AS packet
  WHERE packet.id = p_packet_id;
  IF FOUND THEN
    IF existing.authorization_state IS DISTINCT FROM 'not_authorized'
       OR existing.catalog_candidate_id IS DISTINCT FROM p_candidate_id
       OR existing.service_template_version_id IS DISTINCT FROM p_template_version_id
       OR existing.filter_adapter_version_id IS DISTINCT FROM p_filter_adapter_version_id
       OR existing.environment IS DISTINCT FROM p_environment
       OR existing.provider_resource_fingerprint IS DISTINCT FROM p_provider_resource_fingerprint
       OR existing.exact_request IS DISTINCT FROM p_exact_request
       OR existing.request_fingerprint IS DISTINCT FROM calculated_fingerprint
       OR existing.maximum_estimated_cost_micros IS DISTINCT FROM p_maximum_estimated_cost_micros
       OR existing.currency_code IS DISTINCT FROM p_currency_code
       OR existing.maximum_provider_submissions IS DISTINCT FROM p_maximum_provider_submissions
       OR existing.automatic_submission_retries IS DISTINCT FROM p_automatic_submission_retries
       OR existing.poll_deadline_ms IS DISTINCT FROM p_poll_deadline_ms
       OR existing.expected_evidence IS DISTINCT FROM p_expected_evidence
       OR existing.created_by IS DISTINCT FROM p_actor THEN
      RAISE EXCEPTION 'MARKETPLACE_QUALIFICATION_PACKET_REPLAY_CONFLICT' USING ERRCODE = '55000';
    END IF;
    RETURN QUERY SELECT existing.id, existing.request_fingerprint, existing.authorization_state;
    RETURN;
  END IF;

  INSERT INTO app.marketplace_qualification_packets (
    id, catalog_candidate_id, service_template_version_id,
    filter_adapter_version_id, environment, operation_code,
    provider_resource_fingerprint, exact_request, request_fingerprint,
    maximum_estimated_cost_micros, currency_code,
    maximum_provider_submissions, automatic_submission_retries,
    poll_deadline_ms, expected_artifact_kinds, expected_evidence,
    authorization_state, created_by
  ) VALUES (
    p_packet_id, p_candidate_id, p_template_version_id,
    p_filter_adapter_version_id, p_environment, 'marketplace.dataset.filter',
    p_provider_resource_fingerprint, p_exact_request, calculated_fingerprint,
    p_maximum_estimated_cost_micros, p_currency_code,
    p_maximum_provider_submissions, p_automatic_submission_retries,
    p_poll_deadline_ms, ARRAY['raw', 'normalized']::text[], p_expected_evidence,
    'not_authorized', p_actor
  );

  INSERT INTO app.audit_events (action, target_type, target_id, outcome, safe_diff)
  VALUES (
    'provider.marketplace_qualification.prepare',
    'marketplace_qualification_packet', p_packet_id, 'prepared',
    jsonb_build_object(
      'environment', p_environment,
      'operation_code', 'marketplace.dataset.filter',
      'request_fingerprint', encode(calculated_fingerprint, 'hex'),
      'records_limit', (p_exact_request ->> 'records_limit')::numeric,
      'maximum_estimated_cost_micros', p_maximum_estimated_cost_micros,
      'currency_code', p_currency_code,
      'maximum_provider_submissions', 1,
      'automatic_submission_retries', 0,
      'provider_http_called', false
    )
  );
  RETURN QUERY SELECT p_packet_id, calculated_fingerprint, 'not_authorized'::text;
END;
$$;

CREATE FUNCTION app.enforce_marketplace_qualification_execution_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF OLD.authorization_state = 'not_authorized'
     AND NEW.authorization_state = 'authorized'
     AND NEW.expected_evidence IS DISTINCT FROM ARRAY[
       'authorization_audit', 'request', 'protected_snapshot_reference',
       'poll_checkpoints', 'raw_artifact', 'normalized_artifact',
       'checksums', 'cost', 'execution_audit'
     ]::text[] THEN
    RAISE EXCEPTION 'MARKETPLACE_QUALIFICATION_PACKET_EVIDENCE_OUTDATED' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER marketplace_qualification_execution_evidence_guard
BEFORE UPDATE OF authorization_state ON app.marketplace_qualification_packets
FOR EACH ROW EXECUTE FUNCTION app.enforce_marketplace_qualification_execution_evidence();

REVOKE ALL ON FUNCTION app.enforce_marketplace_qualification_execution_evidence() FROM PUBLIC;

CREATE TABLE app.marketplace_qualification_poll_checkpoints (
  marketplace_qualification_packet_id uuid NOT NULL
    REFERENCES app.marketplace_qualification_packets(id) ON DELETE RESTRICT,
  sequence integer NOT NULL CHECK (sequence > 0),
  provider_status text NOT NULL CHECK (provider_status IN (
    'scheduled', 'building', 'ready', 'failed',
    'not_ready', 'missing', 'read_failed', 'rate_limited'
  )),
  safe_error_code text CHECK (
    safe_error_code IS NULL OR safe_error_code ~ '^[A-Z][A-Z0-9_]{2,127}$'
  ),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (marketplace_qualification_packet_id, sequence),
  CHECK (
    (provider_status IN ('scheduled', 'building', 'ready', 'failed')
      AND safe_error_code IS NULL)
    OR
    (provider_status IN ('not_ready', 'missing', 'read_failed', 'rate_limited')
      AND safe_error_code IS NOT NULL)
  )
);

ALTER TABLE app.marketplace_qualification_poll_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.marketplace_qualification_poll_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY marketplace_qualification_poll_checkpoints_owner_all
  ON app.marketplace_qualification_poll_checkpoints
  FOR ALL TO dhumi_owner USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE app.marketplace_qualification_poll_checkpoints FROM PUBLIC;

CREATE POLICY audit_events_marketplace_qualification_execution_insert
  ON app.audit_events
  FOR INSERT
  TO dhumi_owner
  WITH CHECK (
    action IN (
      'provider.marketplace_qualification.execution_start',
      'provider.marketplace_qualification.snapshot_record',
      'provider.marketplace_qualification.complete'
    )
    AND target_type = 'marketplace_qualification_packet'
  );

CREATE FUNCTION app.record_marketplace_qualification_submission_start(
  p_packet_id uuid,
  p_request_object_key text,
  p_request_checksum bytea,
  p_request_content_type text,
  p_request_byte_count bigint,
  p_actor text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE packet app.marketplace_qualification_packets%ROWTYPE;
BEGIN
  SELECT * INTO packet FROM app.marketplace_qualification_packets
  WHERE id = p_packet_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MARKETPLACE_QUALIFICATION_PACKET_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF packet.authorization_state <> 'consumed'
     OR packet.provider_submission_count <> 1
     OR packet.execution_state <> 'not_started' THEN
    RAISE EXCEPTION 'MARKETPLACE_QUALIFICATION_EXECUTION_STATE_CONFLICT' USING ERRCODE = '55000';
  END IF;
  IF p_request_object_key IS DISTINCT FROM
       'qualification/operations/' || p_packet_id::text || '/request.json'
     OR p_request_checksum IS NULL OR octet_length(p_request_checksum) <> 32
     OR p_request_content_type <> 'application/json'
     OR p_request_byte_count IS NULL OR p_request_byte_count < 2
     OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$' THEN
    RAISE EXCEPTION 'MARKETPLACE_QUALIFICATION_EVIDENCE_INVALID' USING ERRCODE = '22023';
  END IF;

  UPDATE app.marketplace_qualification_packets SET
    execution_state = 'submitting',
    request_object_key = p_request_object_key,
    request_checksum = p_request_checksum,
    request_content_type = p_request_content_type,
    request_byte_count = p_request_byte_count,
    execution_started_at = clock_timestamp()
  WHERE id = p_packet_id;

  INSERT INTO app.audit_events (action, target_type, target_id, outcome, safe_diff)
  VALUES (
    'provider.marketplace_qualification.execution_start',
    'marketplace_qualification_packet', p_packet_id, 'started',
    jsonb_build_object(
      'actor', p_actor,
      'request_checksum', encode(p_request_checksum, 'hex'),
      'provider_submission_count', 1,
      'automatic_submission_retries', 0
    )
  );
  RETURN true;
END;
$$;

CREATE FUNCTION app.record_marketplace_qualification_snapshot_reference(
  p_packet_id uuid,
  p_snapshot_ciphertext bytea,
  p_snapshot_fingerprint bytea,
  p_actor text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE packet app.marketplace_qualification_packets%ROWTYPE;
BEGIN
  SELECT * INTO packet FROM app.marketplace_qualification_packets
  WHERE id = p_packet_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MARKETPLACE_QUALIFICATION_PACKET_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF packet.execution_state <> 'submitting'
     OR p_snapshot_ciphertext IS NULL OR octet_length(p_snapshot_ciphertext) <= 29
     OR p_snapshot_fingerprint IS NULL OR octet_length(p_snapshot_fingerprint) <> 32
     OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$' THEN
    RAISE EXCEPTION 'MARKETPLACE_QUALIFICATION_SNAPSHOT_INVALID' USING ERRCODE = '22023';
  END IF;
  UPDATE app.marketplace_qualification_packets SET
    execution_state = 'polling',
    provider_snapshot_ciphertext = p_snapshot_ciphertext,
    provider_snapshot_fingerprint = p_snapshot_fingerprint
  WHERE id = p_packet_id;
  INSERT INTO app.audit_events (action, target_type, target_id, outcome, safe_diff)
  VALUES (
    'provider.marketplace_qualification.snapshot_record',
    'marketplace_qualification_packet', p_packet_id, 'recorded',
    jsonb_build_object(
      'actor', p_actor,
      'snapshot_fingerprint', encode(p_snapshot_fingerprint, 'hex')
    )
  );
  RETURN true;
END;
$$;

CREATE FUNCTION app.record_marketplace_qualification_poll_checkpoint(
  p_packet_id uuid,
  p_provider_status text,
  p_safe_error_code text,
  p_actor text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE packet app.marketplace_qualification_packets%ROWTYPE;
DECLARE next_sequence integer;
BEGIN
  SELECT * INTO packet FROM app.marketplace_qualification_packets
  WHERE id = p_packet_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MARKETPLACE_QUALIFICATION_PACKET_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF packet.execution_state <> 'polling'
     OR p_provider_status NOT IN (
       'scheduled', 'building', 'ready', 'failed',
       'not_ready', 'missing', 'read_failed', 'rate_limited'
     )
     OR (p_provider_status IN ('scheduled', 'building', 'ready', 'failed')
       AND p_safe_error_code IS NOT NULL)
     OR (p_provider_status IN ('not_ready', 'missing', 'read_failed', 'rate_limited')
       AND (p_safe_error_code IS NULL
         OR p_safe_error_code !~ '^[A-Z][A-Z0-9_]{2,127}$'))
     OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$' THEN
    RAISE EXCEPTION 'MARKETPLACE_QUALIFICATION_POLL_INVALID' USING ERRCODE = '22023';
  END IF;
  next_sequence := packet.provider_poll_count + 1;
  INSERT INTO app.marketplace_qualification_poll_checkpoints (
    marketplace_qualification_packet_id, sequence, provider_status, safe_error_code
  ) VALUES (p_packet_id, next_sequence, p_provider_status, p_safe_error_code);
  UPDATE app.marketplace_qualification_packets SET
    provider_poll_count = next_sequence,
    provider_last_status = p_provider_status
  WHERE id = p_packet_id;
  RETURN true;
END;
$$;

CREATE FUNCTION app.complete_marketplace_qualification_success(
  p_packet_id uuid,
  p_raw_object_key text,
  p_raw_checksum bytea,
  p_raw_content_type text,
  p_raw_byte_count bigint,
  p_raw_record_count integer,
  p_normalized_object_key text,
  p_normalized_checksum bytea,
  p_normalized_content_type text,
  p_normalized_byte_count bigint,
  p_normalized_record_count integer,
  p_observed_cost_micros bigint,
  p_currency_code text,
  p_actor text,
  p_outcome_class text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE packet app.marketplace_qualification_packets%ROWTYPE;
BEGIN
  SELECT * INTO packet FROM app.marketplace_qualification_packets
  WHERE id = p_packet_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MARKETPLACE_QUALIFICATION_PACKET_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF packet.execution_state <> 'polling' OR packet.provider_last_status <> 'ready'
     OR p_raw_object_key IS DISTINCT FROM
       'qualification/operations/' || p_packet_id::text || '/raw.json'
     OR p_normalized_object_key IS DISTINCT FROM
       'qualification/operations/' || p_packet_id::text || '/normalized.json'
     OR p_raw_checksum IS NULL OR octet_length(p_raw_checksum) <> 32
     OR p_normalized_checksum IS NULL OR octet_length(p_normalized_checksum) <> 32
     OR p_raw_content_type <> 'application/json'
     OR p_normalized_content_type <> 'application/json'
     OR p_raw_byte_count IS NULL OR p_raw_byte_count < 2
     OR p_normalized_byte_count IS NULL OR p_normalized_byte_count < 2
     OR p_raw_record_count IS NULL OR p_raw_record_count < 0
     OR p_normalized_record_count IS DISTINCT FROM p_raw_record_count
     OR p_normalized_record_count > (packet.exact_request->>'records_limit')::integer
     OR p_observed_cost_micros IS NULL OR p_observed_cost_micros < 0
     OR p_observed_cost_micros > packet.maximum_estimated_cost_micros
     OR p_currency_code <> packet.currency_code
     OR p_outcome_class <> 'provider_execution_completed'
     OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$' THEN
    RAISE EXCEPTION 'MARKETPLACE_QUALIFICATION_COMPLETION_INVALID' USING ERRCODE = '22023';
  END IF;

  UPDATE app.marketplace_qualification_packets SET
    execution_state = 'succeeded',
    raw_object_key = p_raw_object_key,
    raw_checksum = p_raw_checksum,
    raw_content_type = p_raw_content_type,
    raw_byte_count = p_raw_byte_count,
    raw_record_count = p_raw_record_count,
    normalized_object_key = p_normalized_object_key,
    normalized_checksum = p_normalized_checksum,
    normalized_content_type = p_normalized_content_type,
    normalized_byte_count = p_normalized_byte_count,
    normalized_record_count = p_normalized_record_count,
    observed_cost_micros = p_observed_cost_micros,
    observed_currency_code = p_currency_code,
    execution_completed_at = clock_timestamp(),
    execution_outcome_class = p_outcome_class
  WHERE id = p_packet_id;

  INSERT INTO app.audit_events (action, target_type, target_id, outcome, safe_diff)
  VALUES (
    'provider.marketplace_qualification.complete',
    'marketplace_qualification_packet', p_packet_id, 'succeeded',
    jsonb_build_object(
      'actor', p_actor,
      'raw_checksum', encode(p_raw_checksum, 'hex'),
      'normalized_checksum', encode(p_normalized_checksum, 'hex'),
      'record_count', p_normalized_record_count,
      'observed_cost_micros', p_observed_cost_micros,
      'currency_code', p_currency_code
    )
  );
  RETURN true;
END;
$$;

CREATE FUNCTION app.complete_marketplace_qualification_failure(
  p_packet_id uuid,
  p_execution_state text,
  p_safe_error_code text,
  p_observed_cost_micros bigint,
  p_currency_code text,
  p_actor text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE packet app.marketplace_qualification_packets%ROWTYPE;
BEGIN
  SELECT * INTO packet FROM app.marketplace_qualification_packets
  WHERE id = p_packet_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MARKETPLACE_QUALIFICATION_PACKET_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF packet.execution_state NOT IN ('not_started', 'submitting', 'polling')
     OR p_execution_state NOT IN ('failed', 'uncertain')
     OR p_safe_error_code !~ '^[A-Z][A-Z0-9_]{2,127}$'
     OR (p_observed_cost_micros IS NOT NULL AND p_observed_cost_micros < 0)
     OR p_currency_code <> packet.currency_code
     OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$' THEN
    RAISE EXCEPTION 'MARKETPLACE_QUALIFICATION_FAILURE_INVALID' USING ERRCODE = '22023';
  END IF;
  UPDATE app.marketplace_qualification_packets SET
    execution_state = p_execution_state,
    observed_cost_micros = p_observed_cost_micros,
    observed_currency_code = CASE
      WHEN p_observed_cost_micros IS NULL THEN NULL ELSE p_currency_code END,
    safe_error_code = p_safe_error_code,
    execution_completed_at = clock_timestamp(),
    execution_outcome_class = CASE p_execution_state
      WHEN 'uncertain' THEN 'provider_submission_uncertain'
      ELSE 'provider_qualification_failed' END
  WHERE id = p_packet_id;
  INSERT INTO app.audit_events (action, target_type, target_id, outcome, reason, safe_diff)
  VALUES (
    'provider.marketplace_qualification.complete',
    'marketplace_qualification_packet', p_packet_id, p_execution_state,
    p_safe_error_code,
    jsonb_build_object(
      'actor', p_actor,
      'observed_cost_micros', p_observed_cost_micros,
      'currency_code', p_currency_code,
      'automatic_submission_retries', 0
    )
  );
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION app.record_marketplace_qualification_submission_start(uuid,text,bytea,text,bigint,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.record_marketplace_qualification_snapshot_reference(uuid,bytea,bytea,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.record_marketplace_qualification_poll_checkpoint(uuid,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.complete_marketplace_qualification_success(uuid,text,bytea,text,bigint,integer,text,bytea,text,bigint,integer,bigint,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.complete_marketplace_qualification_failure(uuid,text,text,bigint,text,text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.record_marketplace_qualification_submission_start(uuid,text,bytea,text,bigint,text) TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.record_marketplace_qualification_snapshot_reference(uuid,bytea,bytea,text) TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.record_marketplace_qualification_poll_checkpoint(uuid,text,text,text) TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.complete_marketplace_qualification_success(uuid,text,bytea,text,bigint,integer,text,bytea,text,bigint,integer,bigint,text,text,text) TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.complete_marketplace_qualification_failure(uuid,text,text,bigint,text,text) TO dhumi_operator;

RESET ROLE;
