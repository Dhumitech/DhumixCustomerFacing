-- M9 preflight: immutable, operator-only Marketplace qualification packet.
--
-- This migration prepares and binds a future, separately authorized live
-- qualification. It creates no customer route, public Template pointer,
-- provider mapping, Service, Run, outbox event, entitlement or provider HTTP
-- request. The M7 adapter remains disabled and provider-HTTP-off.

SET ROLE dhumi_owner;

CREATE TABLE app.marketplace_qualification_packets (
  id uuid PRIMARY KEY,
  catalog_candidate_id uuid NOT NULL
    REFERENCES app.catalog_candidates(id) ON DELETE RESTRICT,
  service_template_version_id uuid NOT NULL
    REFERENCES app.service_template_versions(id) ON DELETE RESTRICT,
  filter_adapter_version_id uuid NOT NULL
    REFERENCES app.adapter_versions(id) ON DELETE RESTRICT,
  environment text NOT NULL CHECK (environment IN ('local', 'test')),
  operation_code text NOT NULL CHECK (operation_code = 'marketplace.dataset.filter'),
  provider_resource_fingerprint bytea NOT NULL
    CHECK (octet_length(provider_resource_fingerprint) = 32),
  exact_request jsonb NOT NULL CHECK (jsonb_typeof(exact_request) = 'object'),
  request_fingerprint bytea NOT NULL CHECK (octet_length(request_fingerprint) = 32),
  maximum_estimated_cost_micros bigint NOT NULL
    CHECK (maximum_estimated_cost_micros > 0),
  currency_code text NOT NULL CHECK (currency_code = 'USD'),
  maximum_provider_submissions integer NOT NULL
    CHECK (maximum_provider_submissions = 1),
  automatic_submission_retries integer NOT NULL
    CHECK (automatic_submission_retries = 0),
  poll_deadline_ms integer NOT NULL CHECK (poll_deadline_ms BETWEEN 1 AND 86400000),
  expected_artifact_kinds text[] NOT NULL
    CHECK (expected_artifact_kinds = ARRAY['raw', 'normalized']::text[]),
  expected_evidence text[] NOT NULL,
  authorization_state text NOT NULL DEFAULT 'not_authorized'
    CHECK (authorization_state IN ('not_authorized', 'authorized', 'consumed', 'revoked')),
  authorization_evidence_id uuid
    REFERENCES app.launch_evidence(id) ON DELETE RESTRICT,
  authorization_reference text,
  authorization_hash bytea,
  authorized_by text,
  authorized_at timestamptz,
  authorization_effective_at timestamptz,
  authorization_expires_at timestamptz,
  provider_submission_count integer NOT NULL DEFAULT 0
    CHECK (provider_submission_count BETWEEN 0 AND 1),
  submission_claimed_at timestamptz,
  submission_claimed_by text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT marketplace_qualification_authorization_coherence CHECK (
    (
      authorization_state = 'not_authorized'
      AND authorization_evidence_id IS NULL
      AND authorization_reference IS NULL
      AND authorization_hash IS NULL
      AND authorized_by IS NULL
      AND authorized_at IS NULL
      AND authorization_effective_at IS NULL
      AND authorization_expires_at IS NULL
      AND provider_submission_count = 0
      AND submission_claimed_at IS NULL
      AND submission_claimed_by IS NULL
    )
    OR
    (
      authorization_state = 'authorized'
      AND authorization_evidence_id IS NOT NULL
      AND authorization_reference IS NOT NULL
      AND authorization_hash IS NOT NULL
      AND octet_length(authorization_hash) = 32
      AND authorized_by IS NOT NULL
      AND authorized_at IS NOT NULL
      AND authorization_effective_at IS NOT NULL
      AND authorization_expires_at > authorization_effective_at
      AND provider_submission_count = 0
      AND submission_claimed_at IS NULL
      AND submission_claimed_by IS NULL
    )
    OR
    (
      authorization_state = 'consumed'
      AND authorization_evidence_id IS NOT NULL
      AND authorization_reference IS NOT NULL
      AND authorization_hash IS NOT NULL
      AND octet_length(authorization_hash) = 32
      AND authorized_by IS NOT NULL
      AND authorized_at IS NOT NULL
      AND authorization_effective_at IS NOT NULL
      AND authorization_expires_at > authorization_effective_at
      AND provider_submission_count = 1
      AND submission_claimed_at IS NOT NULL
      AND submission_claimed_by IS NOT NULL
    )
    OR
    (
      authorization_state = 'revoked'
      AND authorization_evidence_id IS NOT NULL
      AND authorization_reference IS NOT NULL
      AND authorization_hash IS NOT NULL
      AND octet_length(authorization_hash) = 32
      AND authorized_by IS NOT NULL
      AND authorized_at IS NOT NULL
      AND authorization_effective_at IS NOT NULL
      AND authorization_expires_at > authorization_effective_at
      AND provider_submission_count = 0
      AND submission_claimed_at IS NULL
      AND submission_claimed_by IS NULL
    )
  )
);

CREATE INDEX marketplace_qualification_packets_candidate_idx
  ON app.marketplace_qualification_packets (catalog_candidate_id, created_at DESC);
CREATE INDEX marketplace_qualification_packets_authorization_idx
  ON app.marketplace_qualification_packets (authorization_state, authorization_expires_at);

ALTER TABLE app.marketplace_qualification_packets ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.marketplace_qualification_packets FORCE ROW LEVEL SECURITY;

CREATE POLICY marketplace_qualification_packets_owner_all
  ON app.marketplace_qualification_packets
  FOR ALL
  TO dhumi_owner
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON TABLE app.marketplace_qualification_packets FROM PUBLIC;

CREATE FUNCTION app.reject_marketplace_qualification_packet_contract_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.catalog_candidate_id IS DISTINCT FROM OLD.catalog_candidate_id
     OR NEW.service_template_version_id IS DISTINCT FROM OLD.service_template_version_id
     OR NEW.filter_adapter_version_id IS DISTINCT FROM OLD.filter_adapter_version_id
     OR NEW.environment IS DISTINCT FROM OLD.environment
     OR NEW.operation_code IS DISTINCT FROM OLD.operation_code
     OR NEW.provider_resource_fingerprint IS DISTINCT FROM OLD.provider_resource_fingerprint
     OR NEW.exact_request IS DISTINCT FROM OLD.exact_request
     OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
     OR NEW.maximum_estimated_cost_micros IS DISTINCT FROM OLD.maximum_estimated_cost_micros
     OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
     OR NEW.maximum_provider_submissions IS DISTINCT FROM OLD.maximum_provider_submissions
     OR NEW.automatic_submission_retries IS DISTINCT FROM OLD.automatic_submission_retries
     OR NEW.poll_deadline_ms IS DISTINCT FROM OLD.poll_deadline_ms
     OR NEW.expected_artifact_kinds IS DISTINCT FROM OLD.expected_artifact_kinds
     OR NEW.expected_evidence IS DISTINCT FROM OLD.expected_evidence
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.provider_submission_count < OLD.provider_submission_count THEN
    RAISE EXCEPTION 'MARKETPLACE_QUALIFICATION_PACKET_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER marketplace_qualification_packets_contract_immutable
  BEFORE UPDATE ON app.marketplace_qualification_packets
  FOR EACH ROW EXECUTE FUNCTION app.reject_marketplace_qualification_packet_contract_mutation();

CREATE TRIGGER marketplace_qualification_packets_no_delete
  BEFORE DELETE ON app.marketplace_qualification_packets
  FOR EACH ROW EXECUTE FUNCTION app.reject_version_mutation();

CREATE FUNCTION app.marketplace_qualification_schema_supports(
  p_schema jsonb,
  p_type text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT CASE jsonb_typeof(p_schema -> 'type')
    WHEN 'string' THEN p_schema ->> 'type' = p_type
    WHEN 'array' THEN (p_schema -> 'type') ? p_type
    ELSE false
  END;
$$;

CREATE FUNCTION app.marketplace_qualification_filter_valid(
  p_filter jsonb,
  p_properties jsonb,
  p_depth integer DEFAULT 1
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  filter_operator text;
  field_name text;
  field_schema jsonb;
  child jsonb;
BEGIN
  IF p_depth < 1 OR jsonb_typeof(p_filter) <> 'object'
     OR jsonb_typeof(p_properties) <> 'object'
     OR jsonb_typeof(p_filter -> 'operator') <> 'string' THEN
    RETURN false;
  END IF;
  filter_operator := p_filter ->> 'operator';

  IF filter_operator IN ('and', 'or') THEN
    IF p_depth > 3
       OR NOT (p_filter ? 'filters')
       OR jsonb_typeof(p_filter -> 'filters') <> 'array'
       OR jsonb_array_length(p_filter -> 'filters') < 1
       OR EXISTS (
         SELECT 1 FROM jsonb_object_keys(p_filter) AS key
         WHERE key NOT IN ('operator', 'filters', 'combine_nested_fields')
       )
       OR (
         p_filter ? 'combine_nested_fields'
         AND jsonb_typeof(p_filter -> 'combine_nested_fields') <> 'boolean'
       ) THEN
      RETURN false;
    END IF;
    FOR child IN SELECT value FROM jsonb_array_elements(p_filter -> 'filters') LOOP
      IF NOT app.marketplace_qualification_filter_valid(child, p_properties, p_depth + 1) THEN
        RETURN false;
      END IF;
    END LOOP;
    RETURN true;
  END IF;

  IF filter_operator NOT IN (
       '=', '!=', '<', '<=', '>', '>=', 'in', 'not_in',
       'includes', 'not_includes', 'array_includes', 'not_array_includes',
       'is_null', 'is_not_null'
     )
     OR jsonb_typeof(p_filter -> 'name') <> 'string' THEN
    RETURN false;
  END IF;
  field_name := p_filter ->> 'name';
  IF field_name !~ '^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,255}$'
     OR NOT (p_properties ? field_name) THEN
    RETURN false;
  END IF;
  field_schema := p_properties -> field_name;

  IF filter_operator IN ('is_null', 'is_not_null') THEN
    RETURN NOT (p_filter ? 'value')
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_object_keys(p_filter) AS key
        WHERE key NOT IN ('name', 'operator')
      );
  END IF;

  IF NOT (p_filter ? 'value') OR p_filter -> 'value' = 'null'::jsonb
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_filter) AS key
       WHERE key NOT IN ('name', 'operator', 'value')
     ) THEN
    RETURN false;
  END IF;

  IF filter_operator IN ('<', '<=', '>', '>=')
     AND NOT (
       app.marketplace_qualification_schema_supports(field_schema, 'number')
       OR app.marketplace_qualification_schema_supports(field_schema, 'integer')
       OR (
         app.marketplace_qualification_schema_supports(field_schema, 'string')
         AND field_schema ->> 'format' IN ('date', 'date-time')
       )
     ) THEN
    RETURN false;
  END IF;
  IF filter_operator IN ('includes', 'not_includes')
     AND NOT (
       app.marketplace_qualification_schema_supports(field_schema, 'string')
       OR app.marketplace_qualification_schema_supports(field_schema, 'array')
     ) THEN
    RETURN false;
  END IF;
  IF filter_operator IN ('array_includes', 'not_array_includes')
     AND NOT app.marketplace_qualification_schema_supports(field_schema, 'array') THEN
    RETURN false;
  END IF;
  IF filter_operator IN ('in', 'not_in')
     AND (
       jsonb_typeof(p_filter -> 'value') <> 'array'
       OR jsonb_array_length(p_filter -> 'value') < 1
     ) THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(p_filter -> 'value') = 'array'
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_filter -> 'value') AS value
       WHERE jsonb_typeof(value) NOT IN ('string', 'boolean', 'number')
     ) THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$$;

CREATE FUNCTION app.resolve_marketplace_qualification_context(
  p_candidate_id uuid,
  p_environment text
)
RETURNS TABLE (
  candidate_id uuid,
  template_version_id uuid,
  filter_adapter_version_id uuid,
  provider_resource_fingerprint bytea,
  output_schema jsonb
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT
    candidate.id,
    template_version.id,
    filter_adapter.id,
    candidate.provider_resource_fingerprint,
    -- M4 exposes exactly these two governed synthetic-sample fields, and M7's
    -- offline normalizer is proven against the same projection. Do not infer
    -- additional provider fields from the generic M2 draft output schema.
    '{
      "type":"array",
      "items":{
        "type":"object",
        "additionalProperties":false,
        "properties":{
          "url":{"type":"string","format":"uri"},
          "text":{"type":["string","null"]}
        }
      }
    }'::jsonb
  FROM app.catalog_candidates AS candidate
  JOIN app.catalog_imports AS catalog_import
    ON catalog_import.id = candidate.catalog_import_id
  JOIN app.provider_credentials AS catalog_credential
    ON catalog_credential.id = catalog_import.provider_credential_id
  JOIN app.service_template_versions AS template_version
    ON template_version.id = candidate.service_template_version_id
  JOIN app.service_templates AS template
    ON template.id = template_version.service_template_id
  JOIN app.adapter_versions AS catalog_adapter
    ON catalog_adapter.id = candidate.adapter_version_id
  JOIN app.adapter_definitions AS catalog_definition
    ON catalog_definition.id = catalog_adapter.adapter_definition_id
  CROSS JOIN app.adapter_versions AS filter_adapter
  JOIN app.adapter_definitions AS filter_definition
    ON filter_definition.id = filter_adapter.adapter_definition_id
  WHERE p_candidate_id IS NOT NULL
    AND p_environment IN ('local', 'test')
    AND candidate.id = p_candidate_id
    AND candidate.resource_code = 'linkedin.posts'
    AND candidate.review_state = 'approved'
    AND candidate.provider_resource_fingerprint IS NOT NULL
    AND octet_length(candidate.provider_resource_fingerprint) = 32
    AND template.slug = 'linkedin-posts'
    AND template.product_family = 'marketplace_dataset'
    AND template.state = 'draft'
    AND template.current_public_version_id IS NULL
    AND template_version.availability_state = 'coming_soon'
    AND template_version.effective_at IS NULL
    AND template_version.published_at IS NULL
    AND catalog_definition.code = 'bright_data.marketplace.catalogue'
    AND catalog_adapter.semantic_version = '1.0.0-m2'
    AND catalog_adapter.state = 'disabled'
    AND catalog_credential.provider_code = 'bright_data'
    AND catalog_credential.environment = p_environment
    AND filter_definition.code = 'bright_data.marketplace.filter'
    AND filter_definition.product_family = 'marketplace_dataset'
    AND filter_adapter.semantic_version = '1.0.0-m7-fixture'
    AND filter_adapter.state = 'disabled'
    AND filter_adapter.capability_metadata @> '{
      "transport":"fixture",
      "provider_http_enabled":false,
      "customer_visible":false,
      "can_execute":false,
      "automatic_submission_retries":0
    }'::jsonb
    AND NOT EXISTS (
      SELECT 1 FROM app.provider_mappings AS mapping
      WHERE mapping.adapter_version_id = filter_adapter.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM app.service_template_versions AS published_version
      WHERE published_version.adapter_version_id = filter_adapter.id
    );
$$;

CREATE POLICY audit_events_marketplace_qualification_preflight_insert
  ON app.audit_events
  FOR INSERT
  TO dhumi_owner
  WITH CHECK (
    tenant_id IS NULL
    AND actor_user_id IS NULL
    AND actor_api_key_id IS NULL
    AND request_id IS NULL
    AND ip_fingerprint IS NULL
    AND action IN (
      'provider.marketplace_qualification.prepare',
      'provider.marketplace_qualification.authorize',
      'provider.marketplace_qualification.submission_claim'
    )
    AND target_type = 'marketplace_qualification_packet'
    AND target_id IS NOT NULL
  );

CREATE FUNCTION app.prepare_marketplace_qualification_packet(
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
    'request', 'outbox', 'queue_or_dlq', 'attempt',
    'protected_snapshot_reference', 'poll_checkpoints', 'raw_artifact',
    'normalized_artifact', 'checksums', 'usage', 'cost', 'download_audit'
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
     OR p_poll_deadline_ms IS NULL OR p_poll_deadline_ms NOT BETWEEN 1 AND 86400000
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

CREATE FUNCTION app.authorize_marketplace_qualification_packet(
  p_packet_id uuid,
  p_request_fingerprint bytea,
  p_records_limit bigint,
  p_maximum_estimated_cost_micros bigint,
  p_currency_code text,
  p_maximum_provider_submissions integer,
  p_automatic_submission_retries integer,
  p_authorization_reference text,
  p_authorization_hash bytea,
  p_issuer text,
  p_effective_at timestamptz,
  p_expires_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  packet app.marketplace_qualification_packets%ROWTYPE;
  evidence_id uuid;
  observed_at timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO packet FROM app.marketplace_qualification_packets
  WHERE id = p_packet_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MARKETPLACE_QUALIFICATION_PACKET_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF packet.authorization_state <> 'not_authorized' THEN
    RAISE EXCEPTION 'MARKETPLACE_QUALIFICATION_AUTHORIZATION_CONFLICT' USING ERRCODE = '55000';
  END IF;
  IF p_request_fingerprint IS DISTINCT FROM packet.request_fingerprint
     OR p_records_limit IS DISTINCT FROM (packet.exact_request ->> 'records_limit')::bigint
     OR p_maximum_estimated_cost_micros IS DISTINCT FROM packet.maximum_estimated_cost_micros
     OR p_currency_code IS DISTINCT FROM packet.currency_code
     OR p_maximum_provider_submissions IS DISTINCT FROM packet.maximum_provider_submissions
     OR p_automatic_submission_retries IS DISTINCT FROM packet.automatic_submission_retries THEN
    RAISE EXCEPTION 'MARKETPLACE_QUALIFICATION_AUTHORIZATION_MISMATCH' USING ERRCODE = '22023';
  END IF;
  IF p_authorization_reference IS NULL
     OR length(p_authorization_reference) NOT BETWEEN 8 AND 1024
     OR btrim(p_authorization_reference) <> p_authorization_reference
     OR p_authorization_reference !~ '^[A-Za-z][A-Za-z0-9+.-]*://[^[:space:]]+$'
     OR p_authorization_hash IS NULL OR octet_length(p_authorization_hash) <> 32
     OR p_issuer !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$'
     OR p_effective_at IS NULL OR p_expires_at IS NULL
     OR p_expires_at <= p_effective_at OR p_expires_at <= observed_at THEN
    RAISE EXCEPTION 'MARKETPLACE_QUALIFICATION_AUTHORIZATION_EXPIRED' USING ERRCODE = '22023';
  END IF;

  INSERT INTO app.launch_evidence (
    evidence_code, scope_type, scope_key, state, restricted_reference,
    evidence_hash, effective_at, expires_at, approved_by, approved_at
  ) VALUES (
    'marketplace.qualification.authorization.' || packet.id::text,
    'marketplace_qualification_packet', packet.id::text, 'approved',
    p_authorization_reference, p_authorization_hash, p_effective_at,
    p_expires_at, p_issuer, observed_at
  ) RETURNING id INTO evidence_id;

  UPDATE app.marketplace_qualification_packets SET
    authorization_state = 'authorized',
    authorization_evidence_id = evidence_id,
    authorization_reference = p_authorization_reference,
    authorization_hash = p_authorization_hash,
    authorized_by = p_issuer,
    authorized_at = observed_at,
    authorization_effective_at = p_effective_at,
    authorization_expires_at = p_expires_at
  WHERE id = packet.id;

  INSERT INTO app.audit_events (action, target_type, target_id, outcome, safe_diff)
  VALUES (
    'provider.marketplace_qualification.authorize',
    'marketplace_qualification_packet', packet.id, 'authorized',
    jsonb_build_object(
      'request_fingerprint', encode(packet.request_fingerprint, 'hex'),
      'records_limit', p_records_limit,
      'maximum_estimated_cost_micros', p_maximum_estimated_cost_micros,
      'currency_code', p_currency_code,
      'maximum_provider_submissions', 1,
      'automatic_submission_retries', 0,
      'effective_at', p_effective_at,
      'expires_at', p_expires_at,
      'provider_http_called', false
    )
  );
  RETURN 'authorized';
END;
$$;

CREATE FUNCTION app.claim_marketplace_qualification_submission(
  p_packet_id uuid,
  p_request_fingerprint bytea,
  p_actor text
)
RETURNS TABLE (
  packet_id uuid,
  candidate_id uuid,
  environment text,
  operation_code text,
  provider_resource_ciphertext bytea,
  provider_resource_fingerprint bytea,
  exact_request jsonb,
  maximum_estimated_cost_micros bigint,
  currency_code text,
  poll_deadline_ms integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  packet app.marketplace_qualification_packets%ROWTYPE;
  evidence app.launch_evidence%ROWTYPE;
  observed_at timestamptz := clock_timestamp();
BEGIN
  IF p_actor !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$' THEN
    RAISE EXCEPTION 'MARKETPLACE_QUALIFICATION_CLAIM_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO packet FROM app.marketplace_qualification_packets
  WHERE id = p_packet_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MARKETPLACE_QUALIFICATION_PACKET_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF p_request_fingerprint IS DISTINCT FROM packet.request_fingerprint THEN
    RAISE EXCEPTION 'MARKETPLACE_QUALIFICATION_AUTHORIZATION_MISMATCH' USING ERRCODE = '22023';
  END IF;
  IF packet.authorization_state = 'consumed' OR packet.provider_submission_count <> 0 THEN
    RAISE EXCEPTION 'MARKETPLACE_QUALIFICATION_SUBMISSION_ALREADY_CLAIMED' USING ERRCODE = '55000';
  END IF;
  IF packet.authorization_state <> 'authorized' OR packet.authorization_evidence_id IS NULL THEN
    RAISE EXCEPTION 'MARKETPLACE_QUALIFICATION_NOT_AUTHORIZED' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO evidence FROM app.launch_evidence
  WHERE id = packet.authorization_evidence_id FOR UPDATE;
  IF NOT FOUND OR evidence.state <> 'approved'
     OR evidence.scope_type <> 'marketplace_qualification_packet'
     OR evidence.scope_key <> packet.id::text
     OR evidence.evidence_hash IS DISTINCT FROM packet.authorization_hash
     OR evidence.effective_at IS NULL OR evidence.effective_at > observed_at
     OR evidence.expires_at IS NULL OR evidence.expires_at <= observed_at THEN
    RAISE EXCEPTION 'MARKETPLACE_QUALIFICATION_AUTHORIZATION_EXPIRED' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.resolve_marketplace_qualification_context(
      packet.catalog_candidate_id, packet.environment
    ) AS context
    WHERE context.template_version_id = packet.service_template_version_id
      AND context.filter_adapter_version_id = packet.filter_adapter_version_id
      AND context.provider_resource_fingerprint = packet.provider_resource_fingerprint
  ) THEN
    RAISE EXCEPTION 'MARKETPLACE_QUALIFICATION_CONTEXT_CHANGED' USING ERRCODE = '55000';
  END IF;

  UPDATE app.marketplace_qualification_packets SET
    authorization_state = 'consumed',
    provider_submission_count = 1,
    submission_claimed_at = observed_at,
    submission_claimed_by = p_actor
  WHERE id = packet.id;

  INSERT INTO app.audit_events (action, target_type, target_id, outcome, safe_diff)
  VALUES (
    'provider.marketplace_qualification.submission_claim',
    'marketplace_qualification_packet', packet.id, 'claimed',
    jsonb_build_object(
      'request_fingerprint', encode(packet.request_fingerprint, 'hex'),
      'maximum_provider_submissions', 1,
      'automatic_submission_retries', 0,
      'provider_submission_count', 1,
      'provider_http_called', false
    )
  );

  RETURN QUERY
  SELECT
    packet.id,
    candidate.id,
    packet.environment,
    packet.operation_code,
    candidate.provider_resource_ciphertext,
    candidate.provider_resource_fingerprint,
    packet.exact_request,
    packet.maximum_estimated_cost_micros,
    packet.currency_code,
    packet.poll_deadline_ms
  FROM app.catalog_candidates AS candidate
  WHERE candidate.id = packet.catalog_candidate_id;
END;
$$;

REVOKE ALL ON FUNCTION app.marketplace_qualification_schema_supports(jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.marketplace_qualification_filter_valid(jsonb, jsonb, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_marketplace_qualification_context(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.prepare_marketplace_qualification_packet(uuid, uuid, uuid, uuid, text, bytea, jsonb, bigint, text, integer, integer, integer, text[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.authorize_marketplace_qualification_packet(uuid, bytea, bigint, bigint, text, integer, integer, text, bytea, text, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.claim_marketplace_qualification_submission(uuid, bytea, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.resolve_marketplace_qualification_context(uuid, text) TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.prepare_marketplace_qualification_packet(uuid, uuid, uuid, uuid, text, bytea, jsonb, bigint, text, integer, integer, integer, text[], text) TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.authorize_marketplace_qualification_packet(uuid, bytea, bigint, bigint, text, integer, integer, text, bytea, text, timestamptz, timestamptz) TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.claim_marketplace_qualification_submission(uuid, bytea, text) TO dhumi_operator;

RESET ROLE;
