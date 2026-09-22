-- M10: immutable, customer-disabled LinkedIn Posts export candidate.
--
-- This accepts only the exact successful M9 qualification evidence and binds
-- it to a private Template version and protected Provider Mapping. The adapter,
-- Template version and mapping remain disabled/unpublished. No customer grant,
-- entitlement, Service, Run, outbox event, Attempt or provider request is added.

SET ROLE dhumi_owner;

INSERT INTO app.adapter_definitions (code, product_family)
VALUES ('bright_data.marketplace.filter', 'marketplace_dataset')
ON CONFLICT (code) DO NOTHING;

INSERT INTO app.adapter_versions (
  adapter_definition_id,
  semantic_version,
  capability_metadata,
  request_schema,
  result_schema,
  error_schema,
  code_artifact_digest,
  state
)
SELECT
  definition.id,
  '1.0.0-m10-candidate',
  '{
    "provider":"bright_data",
    "product_family":"marketplace_dataset",
    "operation":"filter",
    "transport":"provider_candidate",
    "provider_http_qualified":true,
    "provider_http_enabled":false,
    "customer_visible":false,
    "customer_execution_enabled":false,
    "can_purchase":false,
    "can_execute":false,
    "can_publish":false,
    "maximum_records":5,
    "maximum_estimated_cost_micros":12500,
    "currency_code":"USD",
    "maximum_provider_submissions":1,
    "automatic_submission_retries":0
  }'::jsonb,
  '{
    "$schema":"https://json-schema.org/draft/2020-12/schema",
    "type":"object",
    "additionalProperties":false,
    "required":["records_limit","selected_fields","filter"],
    "properties":{
      "records_limit":{"const":5},
      "selected_fields":{"const":["url","text"]},
      "filter":{"const":{"name":"url","operator":"is_not_null"}}
    }
  }'::jsonb,
  '{
    "$schema":"https://json-schema.org/draft/2020-12/schema",
    "type":"array",
    "items":{
      "type":"object",
      "additionalProperties":false,
      "required":["url","text"],
      "properties":{
        "url":{"type":"string","format":"uri"},
        "text":{"type":["string","null"]}
      }
    },
    "maxItems":5
  }'::jsonb,
  '{
    "$schema":"https://json-schema.org/draft/2020-12/schema",
    "type":"object",
    "additionalProperties":false,
    "required":["code"],
    "properties":{"code":{"type":"string"}}
  }'::jsonb,
  -- SHA-256 of the ordered Marketplace execution source set used by M7/M10.
  decode('a5545e0016e38071abf59bf01a3520ebb529d7e1f14f367f10dde9b9e534e2ab', 'hex'),
  'disabled'
FROM app.adapter_definitions AS definition
WHERE definition.code = 'bright_data.marketplace.filter'
  AND definition.product_family = 'marketplace_dataset'
ON CONFLICT (adapter_definition_id, semantic_version) DO NOTHING;

CREATE TABLE app.marketplace_export_candidates (
  provider_mapping_id uuid PRIMARY KEY
    REFERENCES app.provider_mappings(id) ON DELETE RESTRICT,
  marketplace_qualification_packet_id uuid NOT NULL UNIQUE
    REFERENCES app.marketplace_qualification_packets(id) ON DELETE RESTRICT,
  catalog_candidate_id uuid NOT NULL
    REFERENCES app.catalog_candidates(id) ON DELETE RESTRICT,
  service_template_version_id uuid NOT NULL UNIQUE
    REFERENCES app.service_template_versions(id) ON DELETE RESTRICT,
  adapter_version_id uuid NOT NULL
    REFERENCES app.adapter_versions(id) ON DELETE RESTRICT,
  launch_evidence_id uuid NOT NULL
    REFERENCES app.launch_evidence(id) ON DELETE RESTRICT,
  source_provider_resource_fingerprint bytea NOT NULL
    CHECK (octet_length(source_provider_resource_fingerprint) = 32),
  mapping_provider_resource_fingerprint bytea NOT NULL
    CHECK (octet_length(mapping_provider_resource_fingerprint) = 32),
  request_fingerprint bytea NOT NULL CHECK (octet_length(request_fingerprint) = 32),
  request_checksum bytea NOT NULL CHECK (octet_length(request_checksum) = 32),
  raw_checksum bytea NOT NULL CHECK (octet_length(raw_checksum) = 32),
  normalized_checksum bytea NOT NULL CHECK (octet_length(normalized_checksum) = 32),
  evidence_hash bytea NOT NULL CHECK (octet_length(evidence_hash) = 32),
  state text NOT NULL CHECK (state = 'disabled_candidate'),
  reviewed_by text NOT NULL CHECK (reviewed_by ~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$'),
  review_reason text NOT NULL CHECK (length(btrim(review_reason)) BETWEEN 8 AND 512),
  evidence_reference text NOT NULL
    CHECK (length(btrim(evidence_reference)) BETWEEN 8 AND 1024),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE app.marketplace_export_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.marketplace_export_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY marketplace_export_candidates_owner_all
  ON app.marketplace_export_candidates
  FOR ALL TO dhumi_owner USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE app.marketplace_export_candidates FROM PUBLIC;

CREATE TRIGGER marketplace_export_candidates_immutable
  BEFORE UPDATE OR DELETE ON app.marketplace_export_candidates
  FOR EACH ROW EXECUTE FUNCTION app.reject_version_mutation();

-- FORCE RLS permits the owner-only registration function to insert and replay
-- only the precise private M10 version. Customer roles receive no new policy.
CREATE POLICY service_template_versions_marketplace_m10_owner_select
  ON app.service_template_versions
  FOR SELECT TO dhumi_owner
  USING (
    version = 2
    AND availability_state = 'coming_soon'
    AND effective_at IS NULL
    AND published_at IS NULL
    AND EXISTS (
      SELECT 1 FROM app.adapter_versions AS adapter
      JOIN app.adapter_definitions AS definition
        ON definition.id = adapter.adapter_definition_id
      WHERE adapter.id = adapter_version_id
        AND adapter.semantic_version = '1.0.0-m10-candidate'
        AND adapter.state = 'disabled'
        AND definition.code = 'bright_data.marketplace.filter'
        AND definition.product_family = 'marketplace_dataset'
    )
    AND EXISTS (
      SELECT 1 FROM app.service_templates AS template
      WHERE template.id = service_template_id
        AND template.slug = 'linkedin-posts'
        AND template.product_family = 'marketplace_dataset'
        AND template.state = 'draft'
        AND template.current_public_version_id IS NULL
    )
  );

CREATE POLICY service_template_versions_marketplace_m10_owner_insert
  ON app.service_template_versions
  FOR INSERT TO dhumi_owner
  WITH CHECK (
    version = 2
    AND availability_state = 'coming_soon'
    AND effective_at IS NULL
    AND published_at IS NULL
    AND EXISTS (
      SELECT 1 FROM app.adapter_versions AS adapter
      JOIN app.adapter_definitions AS definition
        ON definition.id = adapter.adapter_definition_id
      WHERE adapter.id = adapter_version_id
        AND adapter.semantic_version = '1.0.0-m10-candidate'
        AND adapter.state = 'disabled'
        AND adapter.capability_metadata @> '{
          "provider_http_enabled":false,
          "customer_execution_enabled":false,
          "can_purchase":false,
          "can_execute":false,
          "can_publish":false
        }'::jsonb
        AND definition.code = 'bright_data.marketplace.filter'
        AND definition.product_family = 'marketplace_dataset'
    )
    AND EXISTS (
      SELECT 1 FROM app.service_templates AS template
      WHERE template.id = service_template_id
        AND template.slug = 'linkedin-posts'
        AND template.product_family = 'marketplace_dataset'
        AND template.state = 'draft'
        AND template.current_public_version_id IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM app.launch_evidence AS evidence
      WHERE evidence.id = launch_evidence_id
        AND evidence.evidence_code LIKE 'marketplace.export_candidate.%'
        AND evidence.scope_type = 'service_template_version'
        AND evidence.state = 'approved'
        AND evidence.effective_at IS NOT NULL
        AND evidence.approved_at IS NOT NULL
        AND evidence.expires_at IS NULL
    )
  );

CREATE POLICY audit_events_marketplace_export_candidate_insert
  ON app.audit_events
  FOR INSERT TO dhumi_owner
  WITH CHECK (
    tenant_id IS NULL
    AND actor_user_id IS NULL
    AND actor_api_key_id IS NULL
    AND request_id IS NULL
    AND ip_fingerprint IS NULL
    AND action = 'provider.marketplace_export_candidate.register'
    AND target_type = 'provider_mapping'
    AND target_id IS NOT NULL
    AND outcome IN ('registered', 'replayed')
  );

CREATE FUNCTION app.resolve_marketplace_export_candidate_source(
  p_packet_id uuid,
  p_mapping_id uuid
)
RETURNS TABLE (
  packet_id uuid,
  candidate_id uuid,
  environment text,
  resource_code text,
  provider_resource_ciphertext bytea,
  provider_resource_fingerprint bytea
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT
    packet.id,
    candidate.id,
    packet.environment,
    candidate.resource_code,
    candidate.provider_resource_ciphertext,
    candidate.provider_resource_fingerprint
  FROM app.marketplace_qualification_packets AS packet
  JOIN app.catalog_candidates AS candidate
    ON candidate.id = packet.catalog_candidate_id
  JOIN app.catalog_imports AS catalog_import
    ON catalog_import.id = candidate.catalog_import_id
  JOIN app.provider_credentials AS credential
    ON credential.id = catalog_import.provider_credential_id
  JOIN app.service_template_versions AS template_version
    ON template_version.id = packet.service_template_version_id
   AND template_version.id = candidate.service_template_version_id
  JOIN app.service_templates AS template
    ON template.id = template_version.service_template_id
  JOIN app.adapter_versions AS filter_adapter
    ON filter_adapter.id = packet.filter_adapter_version_id
  JOIN app.adapter_definitions AS filter_definition
    ON filter_definition.id = filter_adapter.adapter_definition_id
  WHERE p_packet_id IS NOT NULL
    AND p_mapping_id IS NOT NULL
    AND packet.id = p_packet_id
    AND packet.id = '2e1560c3-ca8b-40a0-b578-c9e71ecf27cd'
    AND packet.authorization_state = 'consumed'
    AND packet.execution_state = 'succeeded'
    AND packet.operation_code = 'marketplace.dataset.filter'
    AND packet.provider_submission_count = 1
    AND packet.maximum_provider_submissions = 1
    AND packet.automatic_submission_retries = 0
    AND packet.provider_last_status = 'ready'
    AND packet.raw_record_count = 5
    AND packet.normalized_record_count = 5
    AND packet.exact_request = '{
      "records_limit":5,
      "selected_fields":["url","text"],
      "filter":{"name":"url","operator":"is_not_null"}
    }'::jsonb
    AND packet.maximum_estimated_cost_micros = 12500
    AND packet.currency_code = 'USD'
    AND packet.observed_cost_micros BETWEEN 0 AND 12500
    AND packet.observed_currency_code = 'USD'
    AND packet.execution_outcome_class = 'provider_execution_completed'
    AND octet_length(packet.request_fingerprint) = 32
    AND packet.request_checksum = decode(
      'f8041530994ed911795f56aa605fde3d11000b8da3c7c587e41cb7da67155e1f', 'hex'
    )
    AND packet.request_byte_count = 106
    AND packet.raw_checksum = decode(
      'd5a9c6c3403959349925d0574195e12e511ab2e861d421938e53b4a6738f6c95', 'hex'
    )
    AND packet.raw_byte_count = 25858
    AND packet.normalized_checksum = decode(
      '7e0f8497a7e02933b2c395a42b2215477f7aae4803762b30bda5e9d3f09bd170', 'hex'
    )
    AND packet.normalized_byte_count = 675
    AND candidate.resource_code = 'linkedin.posts'
    AND candidate.review_state = 'approved'
    AND candidate.provider_resource_ciphertext IS NOT NULL
    AND octet_length(candidate.provider_resource_ciphertext) > 29
    AND candidate.provider_resource_fingerprint = packet.provider_resource_fingerprint
    AND catalog_import.state = 'completed'
    AND catalog_import.environment = packet.environment
    AND credential.provider_code = 'bright_data'
    AND credential.environment = packet.environment
    AND credential.state IN ('inactive', 'active')
    AND template.slug = 'linkedin-posts'
    AND template.product_family = 'marketplace_dataset'
    AND template.state = 'draft'
    AND template.current_public_version_id IS NULL
    AND template_version.version = 1
    AND template_version.availability_state = 'coming_soon'
    AND template_version.published_at IS NULL
    AND filter_definition.code = 'bright_data.marketplace.filter'
    AND filter_adapter.semantic_version = '1.0.0-m7-fixture'
    AND filter_adapter.state = 'disabled'
    AND EXISTS (
      SELECT 1 FROM app.marketplace_qualification_poll_checkpoints AS checkpoint
      WHERE checkpoint.marketplace_qualification_packet_id = packet.id
        AND checkpoint.provider_status = 'ready'
    );
$$;

CREATE FUNCTION app.register_marketplace_export_candidate_v1(
  p_packet_id uuid,
  p_mapping_id uuid,
  p_provider_resource_ciphertext bytea,
  p_provider_resource_fingerprint bytea,
  p_actor text,
  p_evidence_reference text,
  p_reason text
)
RETURNS TABLE (
  mapping_id uuid,
  template_slug text,
  template_version integer,
  mapping_state text,
  disposition text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  source record;
  packet app.marketplace_qualification_packets%ROWTYPE;
  existing app.marketplace_export_candidates%ROWTYPE;
  resolved_adapter_id uuid;
  resolved_credential_id uuid;
  resolved_template_id uuid;
  resolved_template_version_id uuid;
  resolved_evidence_id uuid;
  calculated_evidence_hash bytea;
BEGIN
  IF p_packet_id IS NULL OR p_mapping_id IS NULL
     OR p_provider_resource_ciphertext IS NULL
     OR octet_length(p_provider_resource_ciphertext) <= 29
     OR p_provider_resource_fingerprint IS NULL
     OR octet_length(p_provider_resource_fingerprint) <> 32
     OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$'
     OR length(p_evidence_reference) NOT BETWEEN 8 AND 1024
     OR btrim(p_evidence_reference) <> p_evidence_reference
     OR length(p_reason) NOT BETWEEN 8 AND 512
     OR btrim(p_reason) <> p_reason THEN
    RAISE EXCEPTION 'MARKETPLACE_EXPORT_CANDIDATE_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO source
  FROM app.resolve_marketplace_export_candidate_source(p_packet_id, p_mapping_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MARKETPLACE_EXPORT_CANDIDATE_SOURCE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO packet FROM app.marketplace_qualification_packets
  WHERE id = p_packet_id FOR UPDATE;

  SELECT * INTO existing FROM app.marketplace_export_candidates
  WHERE marketplace_qualification_packet_id = p_packet_id
     OR provider_mapping_id = p_mapping_id
  FOR UPDATE;
  IF FOUND THEN
    IF existing.marketplace_qualification_packet_id IS DISTINCT FROM p_packet_id
       OR existing.provider_mapping_id IS DISTINCT FROM p_mapping_id
       OR existing.mapping_provider_resource_fingerprint IS DISTINCT FROM
          p_provider_resource_fingerprint
       OR existing.reviewed_by IS DISTINCT FROM p_actor
       OR existing.review_reason IS DISTINCT FROM p_reason
       OR existing.evidence_reference IS DISTINCT FROM p_evidence_reference
       OR existing.state IS DISTINCT FROM 'disabled_candidate' THEN
      RAISE EXCEPTION 'MARKETPLACE_EXPORT_CANDIDATE_REPLAY_CONFLICT'
        USING ERRCODE = '55000';
    END IF;
    RETURN QUERY SELECT p_mapping_id, 'linkedin-posts'::text, 2,
      'disabled'::text, 'replayed'::text;
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM app.provider_mappings WHERE id = p_mapping_id) THEN
    RAISE EXCEPTION 'MARKETPLACE_EXPORT_CANDIDATE_REPLAY_CONFLICT'
      USING ERRCODE = '55000';
  END IF;
  IF p_provider_resource_fingerprint = source.provider_resource_fingerprint THEN
    RAISE EXCEPTION 'MARKETPLACE_EXPORT_CANDIDATE_AAD_NOT_CHANGED'
      USING ERRCODE = '22023';
  END IF;

  SELECT adapter.id INTO resolved_adapter_id
  FROM app.adapter_versions AS adapter
  JOIN app.adapter_definitions AS definition
    ON definition.id = adapter.adapter_definition_id
  WHERE definition.code = 'bright_data.marketplace.filter'
    AND definition.product_family = 'marketplace_dataset'
    AND adapter.semantic_version = '1.0.0-m10-candidate'
    AND adapter.state = 'disabled'
    AND adapter.capability_metadata @> '{
      "provider_http_enabled":false,
      "customer_execution_enabled":false,
      "can_purchase":false,
      "can_execute":false,
      "can_publish":false,
      "maximum_records":5,
      "maximum_estimated_cost_micros":12500,
      "maximum_provider_submissions":1,
      "automatic_submission_retries":0
    }'::jsonb;
  IF resolved_adapter_id IS NULL THEN
    RAISE EXCEPTION 'MARKETPLACE_EXPORT_CANDIDATE_ADAPTER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT credential.id INTO resolved_credential_id
  FROM app.catalog_candidates AS candidate
  JOIN app.catalog_imports AS catalog_import
    ON catalog_import.id = candidate.catalog_import_id
  JOIN app.provider_credentials AS credential
    ON credential.id = catalog_import.provider_credential_id
  WHERE candidate.id = source.candidate_id
    AND credential.provider_code = 'bright_data'
    AND credential.environment = source.environment
    AND credential.state IN ('inactive', 'active');
  IF resolved_credential_id IS NULL THEN
    RAISE EXCEPTION 'MARKETPLACE_EXPORT_CANDIDATE_CREDENTIAL_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('marketplace:linkedin-posts:m10', 0));
  SELECT template.id INTO resolved_template_id
  FROM app.service_templates AS template
  WHERE template.slug = 'linkedin-posts'
    AND template.product_family = 'marketplace_dataset'
    AND template.state = 'draft'
    AND template.current_public_version_id IS NULL;
  IF resolved_template_id IS NULL THEN
    RAISE EXCEPTION 'MARKETPLACE_EXPORT_CANDIDATE_TEMPLATE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  calculated_evidence_hash := sha256(convert_to(jsonb_build_object(
    'packet_id', packet.id,
    'request_fingerprint', encode(packet.request_fingerprint, 'hex'),
    'request_checksum', encode(packet.request_checksum, 'hex'),
    'raw_checksum', encode(packet.raw_checksum, 'hex'),
    'normalized_checksum', encode(packet.normalized_checksum, 'hex'),
    'record_count', packet.normalized_record_count,
    'observed_cost_micros', packet.observed_cost_micros,
    'mapping_resource_fingerprint', encode(p_provider_resource_fingerprint, 'hex')
  )::text, 'UTF8'));

  INSERT INTO app.launch_evidence (
    evidence_code, scope_type, scope_key, state, restricted_reference,
    evidence_hash, effective_at, approved_by, approved_at
  ) VALUES (
    'marketplace.export_candidate.' || p_packet_id::text,
    'service_template_version', p_packet_id::text, 'approved',
    p_evidence_reference, calculated_evidence_hash, clock_timestamp(),
    p_actor, clock_timestamp()
  ) ON CONFLICT (evidence_code, scope_type, scope_key) DO NOTHING;

  SELECT evidence.id INTO resolved_evidence_id
  FROM app.launch_evidence AS evidence
  WHERE evidence.evidence_code = 'marketplace.export_candidate.' || p_packet_id::text
    AND evidence.scope_type = 'service_template_version'
    AND evidence.scope_key = p_packet_id::text
    AND evidence.state = 'approved'
    AND evidence.restricted_reference = p_evidence_reference
    AND evidence.evidence_hash = calculated_evidence_hash
    AND evidence.approved_by = p_actor
    AND evidence.effective_at IS NOT NULL
    AND evidence.approved_at IS NOT NULL
    AND evidence.expires_at IS NULL;
  IF resolved_evidence_id IS NULL THEN
    RAISE EXCEPTION 'MARKETPLACE_EXPORT_CANDIDATE_REPLAY_CONFLICT'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO app.service_template_versions (
    service_template_id, version, public_name, public_description,
    input_schema, configuration_schema, output_schema, presentation_metadata,
    availability_copy, availability_state, adapter_version_id,
    launch_evidence_id, effective_at, published_at
  ) VALUES (
    resolved_template_id, 2, 'LinkedIn Posts',
    'Private qualified LinkedIn Posts export candidate. Customer execution is not available.',
    '{
      "$schema":"https://json-schema.org/draft/2020-12/schema",
      "type":"object",
      "additionalProperties":false,
      "required":["records_limit","selected_fields","filter"],
      "properties":{
        "records_limit":{"const":5},
        "selected_fields":{"const":["url","text"]},
        "filter":{"const":{"name":"url","operator":"is_not_null"}}
      }
    }'::jsonb,
    '{"type":"object","additionalProperties":false}'::jsonb,
    '{
      "$schema":"https://json-schema.org/draft/2020-12/schema",
      "type":"array",
      "items":{
        "type":"object",
        "additionalProperties":false,
        "required":["url","text"],
        "properties":{
          "url":{"type":"string","format":"uri"},
          "text":{"type":["string","null"]}
        }
      },
      "maxItems":5
    }'::jsonb,
    '{
      "domain_slug":"linkedin",
      "domain_name":"LinkedIn",
      "category":"social-media",
      "icon_key":"linkedin",
      "operation_group":"LinkedIn datasets",
      "operation_name":"Posts",
      "display_priority":100
    }'::jsonb,
    'Preview available; full export is not enabled.', 'coming_soon',
    resolved_adapter_id, resolved_evidence_id, NULL, NULL
  ) ON CONFLICT (service_template_id, version) DO NOTHING
  RETURNING id INTO resolved_template_version_id;

  IF resolved_template_version_id IS NULL THEN
    SELECT version.id INTO resolved_template_version_id
    FROM app.service_template_versions AS version
    WHERE version.service_template_id = resolved_template_id
      AND version.version = 2
      AND version.adapter_version_id = resolved_adapter_id
      AND version.launch_evidence_id = resolved_evidence_id
      AND version.availability_state = 'coming_soon'
      AND version.effective_at IS NULL
      AND version.published_at IS NULL
      AND version.input_schema = '{
        "$schema":"https://json-schema.org/draft/2020-12/schema",
        "type":"object",
        "additionalProperties":false,
        "required":["records_limit","selected_fields","filter"],
        "properties":{
          "records_limit":{"const":5},
          "selected_fields":{"const":["url","text"]},
          "filter":{"const":{"name":"url","operator":"is_not_null"}}
        }
      }'::jsonb;
  END IF;
  IF resolved_template_version_id IS NULL THEN
    RAISE EXCEPTION 'MARKETPLACE_EXPORT_CANDIDATE_REPLAY_CONFLICT'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO app.provider_mappings (
    id, service_template_version_id, adapter_version_id,
    provider_credential_id, environment, operation_code,
    provider_resource_ciphertext, provider_resource_fingerprint,
    output_policy, commercial_config_version, config_version,
    launch_evidence_id, state, provider_resource_aad_mapping_id
  ) VALUES (
    p_mapping_id, resolved_template_version_id, resolved_adapter_id,
    resolved_credential_id, source.environment, 'marketplace.dataset.filter',
    p_provider_resource_ciphertext, p_provider_resource_fingerprint,
    jsonb_build_object(
      'provider_operation', 'filter',
      'transport', 'provider_candidate',
      'qualification_packet_id', p_packet_id,
      'normalized_projection', jsonb_build_array('url', 'text'),
      'raw_artifact_required', true,
      'normalized_artifact_required', true,
      'maximum_records', 5,
      'maximum_estimated_cost_micros', 12500,
      'currency_code', 'USD',
      'maximum_provider_submissions', 1,
      'automatic_submission_retries', 0,
      'customer_execution_enabled', false
    ),
    'marketplace.linkedin-posts.m10.candidate.v1',
    'marketplace.linkedin-posts.filter.v1', resolved_evidence_id,
    'disabled', p_mapping_id
  );

  INSERT INTO app.marketplace_export_candidates (
    provider_mapping_id, marketplace_qualification_packet_id,
    catalog_candidate_id, service_template_version_id, adapter_version_id,
    launch_evidence_id, source_provider_resource_fingerprint,
    mapping_provider_resource_fingerprint, request_fingerprint,
    request_checksum, raw_checksum, normalized_checksum, evidence_hash,
    state, reviewed_by, review_reason, evidence_reference
  ) VALUES (
    p_mapping_id, p_packet_id, source.candidate_id,
    resolved_template_version_id, resolved_adapter_id, resolved_evidence_id,
    source.provider_resource_fingerprint, p_provider_resource_fingerprint,
    packet.request_fingerprint, packet.request_checksum,
    packet.raw_checksum, packet.normalized_checksum, calculated_evidence_hash,
    'disabled_candidate', p_actor, p_reason, p_evidence_reference
  );

  INSERT INTO app.audit_events (
    action, target_type, target_id, outcome, reason, safe_diff
  ) VALUES (
    'provider.marketplace_export_candidate.register', 'provider_mapping',
    p_mapping_id, 'registered', p_reason,
    jsonb_build_object(
      'qualification_packet_id', p_packet_id,
      'template_slug', 'linkedin-posts',
      'template_version', 2,
      'mapping_state', 'disabled',
      'customer_execution_enabled', false,
      'provider_http_called', false,
      'provider_submission_count', packet.provider_submission_count,
      'automatic_submission_retries', packet.automatic_submission_retries,
      'record_count', packet.normalized_record_count,
      'observed_cost_micros', packet.observed_cost_micros,
      'currency_code', packet.observed_currency_code,
      'source_resource_fingerprint', encode(source.provider_resource_fingerprint, 'hex'),
      'mapping_resource_fingerprint', encode(p_provider_resource_fingerprint, 'hex')
    )
  );

  RETURN QUERY SELECT p_mapping_id, 'linkedin-posts'::text, 2,
    'disabled'::text, 'registered'::text;
END;
$$;

REVOKE ALL ON FUNCTION app.resolve_marketplace_export_candidate_source(uuid,uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app.register_marketplace_export_candidate_v1(
  uuid,uuid,bytea,bytea,text,text,text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.resolve_marketplace_export_candidate_source(uuid,uuid)
  TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.register_marketplace_export_candidate_v1(
  uuid,uuid,bytea,bytea,text,text,text
) TO dhumi_operator;

RESET ROLE;
