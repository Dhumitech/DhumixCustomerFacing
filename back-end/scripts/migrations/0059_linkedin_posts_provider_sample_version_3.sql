-- Move the exact LinkedIn Posts provider sample to immutable sample version 3.
--
-- Sample version 2 is already occupied by the retained historical synthetic
-- expiry/deletion proof. Its immutable PostgreSQL row must not be updated or
-- deleted. This forward-only replacement preserves that evidence and admits
-- the exact qualified provider sample only as version 3.
--
-- This migration performs no provider request and does not enable purchase,
-- customer execution, the M10 mapping, a public Template, Service or Run.

SET ROLE dhumi_owner;

CREATE OR REPLACE FUNCTION app.record_marketplace_provider_sample_v1(
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
    '/3/' || encode(p_checksum, 'hex') || '.json';

  IF source.packet_id IS NULL
     OR p_sample_id IS NULL
     OR p_template_version_id IS DISTINCT FROM source.template_version_id
     OR p_sample_version <> 3
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
       AND existing.sample_version = 3
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
    p_sample_id, p_template_version_id, 3, 'provider_qualification',
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
      'sample_version', 3,
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

REVOKE ALL ON FUNCTION app.record_marketplace_provider_sample_v1(
  uuid, uuid, uuid, integer, text, integer, bigint, bytea, bytea, jsonb,
  text, timestamptz, timestamptz, text
) FROM PUBLIC;

RESET ROLE;
