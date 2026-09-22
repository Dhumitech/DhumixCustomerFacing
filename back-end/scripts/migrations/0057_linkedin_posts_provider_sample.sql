-- Real LinkedIn Posts sample promotion from the exact retained M9 evidence.
--
-- This migration admits one immutable five-record provider sample for the
-- local pre-purchase demo. It does not call Bright Data, expose provider IDs,
-- enable the M10 export mapping, grant an entitlement, or create paid work.
-- The formal agreement reference remains explicitly pending. Pre-purchase PII
-- fields are masked and cannot be filtered or sorted. A future paid delivery
-- must pass the separate MPayment entitlement and selected-field boundary.

SET ROLE dhumi_owner;

ALTER TABLE app.marketplace_sample_versions
  DROP CONSTRAINT marketplace_sample_versions_source_kind_check,
  DROP CONSTRAINT marketplace_sample_versions_state_check,
  DROP CONSTRAINT marketplace_sample_versions_fixture_only_check,
  DROP CONSTRAINT marketplace_sample_versions_provenance_evidence_reference_check;

ALTER TABLE app.marketplace_sample_versions
  ADD COLUMN qualification_packet_id uuid
    REFERENCES app.marketplace_qualification_packets(id) ON DELETE RESTRICT,
  ADD COLUMN field_dictionary jsonb NOT NULL DEFAULT
    '[
      {
        "name":"url","type":"url","active":true,"required":true,
        "description":"LinkedIn post URL","sample_visibility":"visible",
        "allowed_operators":["=","!=","in","not_in","includes","not_includes","is_null","is_not_null"],
        "post_purchase_visibility":"visible"
      },
      {
        "name":"text","type":"text","active":true,"required":false,
        "description":"LinkedIn post text","sample_visibility":"masked",
        "allowed_operators":[],"post_purchase_visibility":"visible"
      }
    ]'::jsonb,
  ADD COLUMN governance_state text NOT NULL DEFAULT 'synthetic_fixture',
  ADD COLUMN interim_decision_reference text;

ALTER TABLE app.marketplace_sample_versions
  ALTER COLUMN field_dictionary DROP DEFAULT,
  ALTER COLUMN governance_state DROP DEFAULT,
  ADD CONSTRAINT marketplace_sample_versions_source_kind_v2_check
    CHECK (source_kind IN ('synthetic_fixture', 'provider_qualification')),
  ADD CONSTRAINT marketplace_sample_versions_state_v2_check
    CHECK (state IN ('validated_fixture', 'validated_provider_sample')),
  ADD CONSTRAINT marketplace_sample_versions_provenance_reference_v2_check
    CHECK (
      provenance_evidence_reference ~
        '^(fixture|qualification)://[A-Za-z0-9][A-Za-z0-9._/-]*$'
      AND length(provenance_evidence_reference) BETWEEN 16 AND 1024
    ),
  ADD CONSTRAINT marketplace_sample_versions_field_dictionary_check
    CHECK (
      jsonb_typeof(field_dictionary) = 'array'
      AND jsonb_array_length(field_dictionary) BETWEEN 1 AND 100
    ),
  ADD CONSTRAINT marketplace_sample_versions_governance_v2_check CHECK (
    (
      source_kind = 'synthetic_fixture'
      AND state = 'validated_fixture'
      AND qualification_packet_id IS NULL
      AND rights_evidence_reference IS NULL
      AND published_at IS NULL
      AND governance_state = 'synthetic_fixture'
      AND interim_decision_reference IS NULL
    )
    OR
    (
      source_kind = 'provider_qualification'
      AND state = 'validated_provider_sample'
      AND qualification_packet_id IS NOT NULL
      AND rights_evidence_reference IS NULL
      AND published_at IS NOT NULL
      AND governance_state = 'formal_agreement_pending_local_demo'
      AND interim_decision_reference =
        'decision://product-owner/2026-09-13/linkedin-posts-real-sample-local-demo-formal-agreement-pending'
    )
  );

CREATE UNIQUE INDEX marketplace_sample_versions_qualification_packet_idx
  ON app.marketplace_sample_versions (qualification_packet_id)
  WHERE qualification_packet_id IS NOT NULL;

DROP POLICY marketplace_sample_versions_m3_owner_select
  ON app.marketplace_sample_versions;
DROP POLICY marketplace_sample_versions_m3_owner_insert
  ON app.marketplace_sample_versions;

CREATE POLICY marketplace_sample_versions_owner_select_v2
  ON app.marketplace_sample_versions
  FOR SELECT TO dhumi_owner USING (true);
CREATE POLICY marketplace_sample_versions_owner_insert_v2
  ON app.marketplace_sample_versions
  FOR INSERT TO dhumi_owner WITH CHECK (
    (source_kind = 'synthetic_fixture' AND state = 'validated_fixture')
    OR
    (source_kind = 'provider_qualification' AND state = 'validated_provider_sample')
  );

CREATE POLICY audit_events_marketplace_provider_sample_definer_insert
  ON app.audit_events
  FOR INSERT TO dhumi_owner
  WITH CHECK (
    tenant_id IS NULL
    AND actor_user_id IS NULL
    AND actor_api_key_id IS NULL
    AND request_id IS NULL
    AND ip_fingerprint IS NULL
    AND action = 'marketplace.provider_sample.promote'
    AND target_type = 'marketplace_sample_version'
    AND target_id IS NOT NULL
  );

CREATE POLICY audit_events_marketplace_provider_sample_expiry_definer_insert
  ON app.audit_events
  FOR INSERT TO dhumi_owner
  WITH CHECK (
    tenant_id IS NULL
    AND actor_user_id IS NULL
    AND actor_api_key_id IS NULL
    AND request_id IS NULL
    AND ip_fingerprint IS NULL
    AND action = 'marketplace.provider_sample.expire'
    AND target_type = 'marketplace_sample_version'
    AND target_id IS NOT NULL
  );

CREATE FUNCTION app.resolve_marketplace_provider_sample_source(p_packet_id uuid)
RETURNS TABLE (
  packet_id uuid,
  template_version_id uuid,
  template_slug text,
  template_version integer,
  environment text,
  provider_resource_ciphertext bytea,
  provider_resource_fingerprint bytea,
  raw_object_key text,
  raw_content_type text,
  raw_record_count integer,
  raw_byte_count bigint,
  raw_checksum bytea,
  completed_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT
    packet.id,
    version.id,
    template.slug,
    version.version,
    packet.environment,
    candidate.provider_resource_ciphertext,
    candidate.provider_resource_fingerprint,
    packet.raw_object_key,
    packet.raw_content_type,
    packet.raw_record_count,
    packet.raw_byte_count,
    packet.raw_checksum,
    packet.execution_completed_at
  FROM app.marketplace_qualification_packets AS packet
  JOIN app.catalog_candidates AS candidate
    ON candidate.id = packet.catalog_candidate_id
  JOIN app.service_template_versions AS version
    ON version.id = packet.service_template_version_id
  JOIN app.service_templates AS template
    ON template.id = version.service_template_id
  JOIN app.marketplace_export_candidates AS export_candidate
    ON export_candidate.marketplace_qualification_packet_id = packet.id
  JOIN app.provider_mappings AS mapping
    ON mapping.id = export_candidate.provider_mapping_id
  WHERE p_packet_id = '2e1560c3-ca8b-40a0-b578-c9e71ecf27cd'::uuid
    AND packet.id = p_packet_id
    AND packet.authorization_state = 'consumed'
    AND packet.execution_state = 'succeeded'
    AND packet.operation_code = 'marketplace.dataset.filter'
    AND packet.provider_submission_count = 1
    AND packet.automatic_submission_retries = 0
    AND packet.raw_object_key =
      'qualification/operations/2e1560c3-ca8b-40a0-b578-c9e71ecf27cd/raw.json'
    AND packet.raw_content_type = 'application/json'
    AND packet.raw_record_count = 5
    AND packet.raw_byte_count = 25858
    AND packet.raw_checksum = decode(
      'd5a9c6c3403959349925d0574195e12e511ab2e861d421938e53b4a6738f6c95',
      'hex'
    )
    AND packet.execution_completed_at IS NOT NULL
    AND candidate.resource_code = 'linkedin.posts'
    AND candidate.review_state = 'approved'
    AND candidate.provider_resource_ciphertext IS NOT NULL
    AND octet_length(candidate.provider_resource_ciphertext) > 29
    AND candidate.provider_resource_fingerprint = packet.provider_resource_fingerprint
    AND template.slug = 'linkedin-posts'
    AND template.product_family = 'marketplace_dataset'
    AND template.state = 'draft'
    AND template.current_public_version_id IS NULL
    AND version.version = 1
    AND version.availability_state = 'coming_soon'
    AND export_candidate.state = 'disabled_candidate'
    AND mapping.state = 'disabled';
$$;

CREATE FUNCTION app.record_marketplace_provider_sample_v1(
  p_sample_id uuid,
  p_packet_id uuid,
  p_template_version_id uuid,
  p_sample_version integer,
  p_object_key text,
  p_record_count integer,
  p_byte_count bigint,
  p_checksum bytea,
  p_metadata_checksum bytea,
  p_field_dictionary jsonb,
  p_interim_decision_reference text,
  p_collected_at timestamptz,
  p_expires_at timestamptz,
  p_actor text
)
RETURNS TABLE (sample_id uuid, disposition text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  source record;
  existing app.marketplace_sample_versions%ROWTYPE;
  expected_object_key text;
  masked_names text[] := ARRAY[
    'author_profile_pic','external_link_data','headline','repost','tagged_people',
    'title','top_visible_comments','user_id','user_name','user_profile_pic','user_title'
  ]::text[];
BEGIN
  SELECT * INTO source
  FROM app.resolve_marketplace_provider_sample_source(p_packet_id);

  expected_object_key := 'marketplace/samples/' || p_template_version_id::text ||
    '/2/' || encode(p_checksum, 'hex') || '.json';

  IF source.packet_id IS NULL
     OR p_sample_id IS NULL
     OR p_template_version_id IS DISTINCT FROM source.template_version_id
     OR p_sample_version <> 2
     OR p_object_key IS DISTINCT FROM expected_object_key
     OR p_record_count IS DISTINCT FROM source.raw_record_count
     OR p_byte_count IS DISTINCT FROM source.raw_byte_count
     OR p_checksum IS DISTINCT FROM source.raw_checksum
     OR p_metadata_checksum IS DISTINCT FROM decode(
       '039685f485ab09f0a6f9503517a2aa34957920c0f2faf827684c0b600512499b',
       'hex'
     )
     OR jsonb_typeof(p_field_dictionary) <> 'array'
     OR jsonb_array_length(p_field_dictionary) <> 37
     OR p_interim_decision_reference IS DISTINCT FROM
       'decision://product-owner/2026-09-13/linkedin-posts-real-sample-local-demo-formal-agreement-pending'
     OR p_collected_at IS DISTINCT FROM source.completed_at
     OR p_expires_at IS DISTINCT FROM p_collected_at + interval '720 hours'
     OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$' THEN
    RAISE EXCEPTION 'MARKETPLACE_PROVIDER_SAMPLE_INVALID' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_field_dictionary) AS field
    WHERE jsonb_typeof(field) <> 'object'
       OR field->>'name' !~ '^[a-z][a-z0-9_]{0,127}$'
       OR field->>'type' NOT IN ('text','url','date','number','array','object')
       OR field->'active' <> 'true'::jsonb
       OR jsonb_typeof(field->'required') <> 'boolean'
       OR length(field->>'description') NOT BETWEEN 1 AND 4000
       OR field->>'sample_visibility' NOT IN ('visible','masked')
       OR jsonb_typeof(field->'allowed_operators') <> 'array'
       OR field->>'post_purchase_visibility' <> 'visible'
  ) OR (
    SELECT count(DISTINCT field->>'name')
    FROM jsonb_array_elements(p_field_dictionary) AS field
  ) <> 37 OR (
    SELECT array_agg(field->>'name' ORDER BY field->>'name')
    FROM jsonb_array_elements(p_field_dictionary) AS field
    WHERE field->>'sample_visibility' = 'masked'
  ) IS DISTINCT FROM masked_names OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_field_dictionary) AS field
    WHERE field->>'sample_visibility' = 'masked'
      AND jsonb_array_length(field->'allowed_operators') <> 0
  ) THEN
    RAISE EXCEPTION 'MARKETPLACE_PROVIDER_SAMPLE_FIELD_POLICY_INVALID'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_packet_id::text, 0));

  SELECT sample.* INTO existing
  FROM app.marketplace_sample_versions AS sample
  WHERE sample.qualification_packet_id = p_packet_id
     OR (
       sample.service_template_version_id = p_template_version_id
       AND sample.sample_version = p_sample_version
     )
  ORDER BY sample.id
  LIMIT 1;

  IF FOUND THEN
    IF existing.qualification_packet_id = p_packet_id
       AND existing.service_template_version_id = p_template_version_id
       AND existing.sample_version = 2
       AND existing.object_key = p_object_key
       AND existing.record_count = p_record_count
       AND existing.byte_count = p_byte_count
       AND existing.checksum = p_checksum
       AND existing.source_metadata_checksum = p_metadata_checksum
       AND existing.field_dictionary = p_field_dictionary
       AND existing.masking_policy_version =
         'linkedin-posts-provider-metadata-pii-mask-v1'
       AND existing.retention_policy_version = 'linkedin-posts-sample-30d-v1'
       AND existing.provenance_evidence_reference =
         'qualification://operations/2e1560c3-ca8b-40a0-b578-c9e71ecf27cd'
       AND existing.rights_evidence_reference IS NULL
       AND existing.governance_state = 'formal_agreement_pending_local_demo'
       AND existing.interim_decision_reference = p_interim_decision_reference
       AND existing.collected_at = p_collected_at
       AND existing.expires_at = p_expires_at
       AND existing.source_kind = 'provider_qualification'
       AND existing.state = 'validated_provider_sample'
       AND existing.published_at IS NOT NULL THEN
      RETURN QUERY SELECT existing.id, 'existing'::text;
      RETURN;
    END IF;
    RAISE EXCEPTION 'MARKETPLACE_PROVIDER_SAMPLE_VERSION_CONFLICT'
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO app.marketplace_sample_versions (
    id, service_template_version_id, sample_version, source_kind,
    object_key, content_type, record_count, byte_count, checksum,
    source_metadata_checksum, schema_version, masking_policy_version,
    retention_policy_version, provenance_evidence_reference,
    rights_evidence_reference, collected_at, published_at, expires_at, state,
    qualification_packet_id, field_dictionary, governance_state,
    interim_decision_reference
  ) VALUES (
    p_sample_id, p_template_version_id, 2, 'provider_qualification',
    p_object_key, 'application/json', p_record_count, p_byte_count, p_checksum,
    p_metadata_checksum, 1, 'linkedin-posts-provider-metadata-pii-mask-v1',
    'linkedin-posts-sample-30d-v1',
    'qualification://operations/2e1560c3-ca8b-40a0-b578-c9e71ecf27cd',
    NULL, p_collected_at, clock_timestamp(), p_expires_at,
    'validated_provider_sample', p_packet_id, p_field_dictionary,
    'formal_agreement_pending_local_demo', p_interim_decision_reference
  );

  INSERT INTO app.audit_events (
    action, target_type, target_id, outcome, safe_diff
  ) VALUES (
    'marketplace.provider_sample.promote',
    'marketplace_sample_version',
    p_sample_id,
    'completed',
    jsonb_build_object(
      'actor', p_actor,
      'qualification_packet_id', p_packet_id,
      'template_slug', 'linkedin-posts',
      'template_version', 1,
      'sample_version', 2,
      'record_count', p_record_count,
      'byte_count', p_byte_count,
      'checksum', encode(p_checksum, 'hex'),
      'metadata_checksum', encode(p_metadata_checksum, 'hex'),
      'field_count', 37,
      'masked_field_count', 11,
      'pre_purchase_masking', true,
      'masked_field_filtering', false,
      'post_purchase_unmask_requires_entitlement', true,
      'formal_agreement_reference_present', false,
      'governance_state', 'formal_agreement_pending_local_demo',
      'expires_at', p_expires_at,
      'provider_calls', 0
    )
  );

  RETURN QUERY SELECT p_sample_id, 'created'::text;
END;
$$;

CREATE OR REPLACE FUNCTION app.resolve_marketplace_sample_preview(
  p_template_slug text,
  p_as_of timestamptz
)
RETURNS TABLE (
  template_id uuid,
  template_slug text,
  template_version integer,
  public_name text,
  public_description text,
  presentation_metadata jsonb,
  configuration_schema jsonb,
  input_schema jsonb,
  provider_record_count bigint,
  provider_record_count_as_of timestamptz,
  sample_version integer,
  sample_record_count integer,
  sample_byte_count bigint,
  sample_checksum_hex text,
  sample_object_key text,
  collected_at timestamptz,
  expires_at timestamptz,
  fields jsonb
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT
    template.id,
    template.slug,
    version.version,
    version.public_name,
    'Preview a governed LinkedIn Posts sample before purchase.'::text,
    version.presentation_metadata,
    version.configuration_schema,
    version.input_schema,
    candidate.provider_record_count,
    candidate.metadata_observed_at,
    sample.sample_version,
    sample.record_count,
    sample.byte_count,
    encode(sample.checksum, 'hex'),
    sample.object_key,
    sample.collected_at,
    sample.expires_at,
    (
      SELECT jsonb_agg(field - 'post_purchase_visibility' ORDER BY ordinal)
      FROM jsonb_array_elements(sample.field_dictionary) WITH ORDINALITY AS item(field, ordinal)
    )
  FROM app.service_templates AS template
  JOIN app.service_template_versions AS version
    ON version.service_template_id = template.id
  JOIN app.catalog_candidates AS candidate
    ON candidate.service_template_version_id = version.id
  JOIN LATERAL (
    SELECT stored.*
    FROM app.marketplace_sample_versions AS stored
    WHERE stored.service_template_version_id = version.id
      AND (
        (
          stored.source_kind = 'provider_qualification'
          AND stored.state = 'validated_provider_sample'
          AND stored.governance_state = 'formal_agreement_pending_local_demo'
          AND stored.interim_decision_reference =
            'decision://product-owner/2026-09-13/linkedin-posts-real-sample-local-demo-formal-agreement-pending'
          AND stored.qualification_packet_id =
            '2e1560c3-ca8b-40a0-b578-c9e71ecf27cd'::uuid
          AND stored.published_at IS NOT NULL
        )
        OR
        (
          stored.source_kind = 'synthetic_fixture'
          AND stored.state = 'validated_fixture'
          AND stored.governance_state = 'synthetic_fixture'
          AND stored.qualification_packet_id IS NULL
          AND stored.rights_evidence_reference IS NULL
          AND stored.published_at IS NULL
        )
      )
      AND stored.retention_policy_version = 'linkedin-posts-sample-30d-v1'
      AND stored.collected_at <= p_as_of
      AND stored.expires_at > p_as_of
      AND NOT EXISTS (
        SELECT 1 FROM app.marketplace_sample_deletions AS deletion
        WHERE deletion.sample_version_id = stored.id
      )
    ORDER BY
      (stored.source_kind = 'provider_qualification') DESC,
      stored.sample_version DESC,
      stored.id ASC
    LIMIT 1
  ) AS sample ON true
  JOIN app.adapter_versions AS adapter
    ON adapter.id = version.adapter_version_id
  JOIN app.adapter_definitions AS definition
    ON definition.id = adapter.adapter_definition_id
  WHERE (p_template_slug IS NULL OR p_template_slug = 'linkedin-posts')
    AND p_as_of IS NOT NULL
    AND template.slug = 'linkedin-posts'
    AND template.product_family = 'marketplace_dataset'
    AND template.state = 'draft'
    AND template.current_public_version_id IS NULL
    AND version.version = 1
    AND version.availability_state = 'coming_soon'
    AND version.effective_at IS NULL
    AND version.published_at IS NULL
    AND candidate.resource_code = 'linkedin.posts'
    AND candidate.review_state = 'approved'
    AND definition.code = 'bright_data.marketplace.catalogue'
    AND adapter.semantic_version = '1.0.0-m2'
    AND adapter.state = 'disabled'
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION app.list_expired_marketplace_fixture_samples(
  p_as_of timestamptz,
  p_limit integer
)
RETURNS TABLE (sample_id uuid, object_key text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF p_as_of IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'MARKETPLACE_SAMPLE_EXPIRY_INPUT_INVALID'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT sample.id, sample.object_key
  FROM app.marketplace_sample_versions AS sample
  WHERE sample.source_kind IN ('synthetic_fixture', 'provider_qualification')
    AND sample.state IN ('validated_fixture', 'validated_provider_sample')
    AND sample.retention_policy_version = 'linkedin-posts-sample-30d-v1'
    AND sample.expires_at <= p_as_of
    AND NOT EXISTS (
      SELECT 1 FROM app.marketplace_sample_deletions AS deletion
      WHERE deletion.sample_version_id = sample.id
    )
  ORDER BY sample.expires_at, sample.id
  LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION app.record_marketplace_fixture_deletion(
  p_sample_id uuid,
  p_deleted_at timestamptz,
  p_storage_disposition text,
  p_actor text
)
RETURNS TABLE (sample_id uuid, disposition text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  sample app.marketplace_sample_versions%ROWTYPE;
  existing app.marketplace_sample_deletions%ROWTYPE;
  audit_action text;
BEGIN
  IF p_sample_id IS NULL
     OR p_deleted_at IS NULL
     OR p_storage_disposition NOT IN ('deleted', 'already_absent')
     OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$' THEN
    RAISE EXCEPTION 'MARKETPLACE_SAMPLE_DELETION_INPUT_INVALID'
      USING ERRCODE = '22023';
  END IF;

  SELECT candidate.* INTO sample
  FROM app.marketplace_sample_versions AS candidate
  WHERE candidate.id = p_sample_id
    AND candidate.source_kind IN ('synthetic_fixture', 'provider_qualification')
    AND candidate.state IN ('validated_fixture', 'validated_provider_sample')
    AND candidate.expires_at <= p_deleted_at;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MARKETPLACE_SAMPLE_EXPIRY_NOT_DUE' USING ERRCODE = '55000';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_sample_id::text, 0));
  SELECT deletion.* INTO existing
  FROM app.marketplace_sample_deletions AS deletion
  WHERE deletion.sample_version_id = p_sample_id;
  IF FOUND THEN
    RETURN QUERY SELECT existing.sample_version_id, 'existing'::text;
    RETURN;
  END IF;

  INSERT INTO app.marketplace_sample_deletions (
    sample_version_id, deleted_at, storage_disposition, actor
  ) VALUES (p_sample_id, p_deleted_at, p_storage_disposition, p_actor);

  audit_action := CASE sample.source_kind
    WHEN 'provider_qualification' THEN 'marketplace.provider_sample.expire'
    ELSE 'marketplace.sample_fixture.expire'
  END;
  INSERT INTO app.audit_events (action, target_type, target_id, outcome, safe_diff)
  VALUES (
    audit_action, 'marketplace_sample_version', p_sample_id, 'completed',
    jsonb_build_object(
      'actor', p_actor,
      'deleted_at', p_deleted_at,
      'storage_disposition', p_storage_disposition,
      'checksum', encode(sample.checksum, 'hex'),
      'byte_count', sample.byte_count,
      'source_kind', sample.source_kind,
      'sample_content_retained', false,
      'provider_calls', 0
    )
  );
  RETURN QUERY SELECT p_sample_id, 'created'::text;
END;
$$;

REVOKE ALL ON FUNCTION app.resolve_marketplace_provider_sample_source(uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app.record_marketplace_provider_sample_v1(
  uuid, uuid, uuid, integer, text, integer, bigint, bytea, bytea, jsonb,
  text, timestamptz, timestamptz, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.resolve_marketplace_provider_sample_source(uuid)
  TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.record_marketplace_provider_sample_v1(
  uuid, uuid, uuid, integer, text, integer, bigint, bytea, bytea, jsonb,
  text, timestamptz, timestamptz, text
) TO dhumi_operator;

RESET ROLE;
