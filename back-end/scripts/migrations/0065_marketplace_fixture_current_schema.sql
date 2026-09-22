-- Keep the private M3 synthetic-fixture recorder compatible with the
-- mandatory dictionary and governance columns introduced by 0057.
-- The signature and operator-only boundary are unchanged. This migration
-- performs no data rewrite, provider request, publication, or paid work.

SET ROLE dhumi_owner;

CREATE OR REPLACE FUNCTION app.record_marketplace_fixture_sample(
  p_sample_id uuid,
  p_template_version_id uuid,
  p_sample_version integer,
  p_object_key text,
  p_content_type text,
  p_record_count integer,
  p_byte_count bigint,
  p_checksum bytea,
  p_metadata_checksum bytea,
  p_schema_version integer,
  p_masking_policy_version text,
  p_retention_policy_version text,
  p_provenance_evidence_reference text,
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
  existing_sample app.marketplace_sample_versions%ROWTYPE;
  expected_object_key text;
  fixture_field_dictionary CONSTANT jsonb :=
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
    ]'::jsonb;
BEGIN
  expected_object_key := 'marketplace/samples/' || p_template_version_id::text ||
    '/' || p_sample_version::text || '/' || encode(p_checksum, 'hex') || '.json';

  IF p_sample_id IS NULL
     OR p_template_version_id IS NULL
     OR p_sample_version IS NULL OR p_sample_version < 1
     OR p_content_type <> 'application/json'
     OR p_record_count IS NULL OR p_record_count < 1
     OR p_byte_count IS NULL OR p_byte_count < 2
     OR p_checksum IS NULL OR octet_length(p_checksum) <> 32
     OR p_metadata_checksum IS DISTINCT FROM decode(
       'c210bf596129141cee74e7d4b339fc70b12fd4117201c693116073bcdde7d3a4',
       'hex'
     )
     OR p_schema_version IS NULL OR p_schema_version < 1
     OR p_masking_policy_version !~ '^[a-z][a-z0-9._-]{2,127}$'
     OR p_retention_policy_version !~ '^[a-z][a-z0-9._-]{2,127}$'
     OR p_provenance_evidence_reference !~
       '^fixture://[A-Za-z0-9][A-Za-z0-9._/-]*$'
     OR length(p_provenance_evidence_reference) NOT BETWEEN 16 AND 1024
     OR p_collected_at IS NULL
     OR p_expires_at IS NULL OR p_expires_at <= p_collected_at
     OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$'
     OR p_object_key IS DISTINCT FROM expected_object_key THEN
    RAISE EXCEPTION 'MARKETPLACE_FIXTURE_SAMPLE_INVALID' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM app.resolve_marketplace_sample_ingestion_target('linkedin-posts', 1) AS target
    WHERE target.template_version_id = p_template_version_id
      AND target.metadata_checksum = p_metadata_checksum
  ) THEN
    RAISE EXCEPTION 'MARKETPLACE_SAMPLE_TARGET_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_template_version_id::text || ':' || p_sample_version::text, 0)
  );

  SELECT sample.*
  INTO existing_sample
  FROM app.marketplace_sample_versions AS sample
  WHERE sample.service_template_version_id = p_template_version_id
    AND sample.sample_version = p_sample_version;

  IF FOUND THEN
    IF existing_sample.object_key = p_object_key
       AND existing_sample.content_type = p_content_type
       AND existing_sample.record_count = p_record_count
       AND existing_sample.byte_count = p_byte_count
       AND existing_sample.checksum = p_checksum
       AND existing_sample.source_metadata_checksum = p_metadata_checksum
       AND existing_sample.schema_version = p_schema_version
       AND existing_sample.masking_policy_version = p_masking_policy_version
       AND existing_sample.retention_policy_version = p_retention_policy_version
       AND existing_sample.provenance_evidence_reference = p_provenance_evidence_reference
       AND existing_sample.collected_at = p_collected_at
       AND existing_sample.expires_at = p_expires_at
       AND existing_sample.source_kind = 'synthetic_fixture'
       AND existing_sample.state = 'validated_fixture'
       AND existing_sample.field_dictionary = fixture_field_dictionary
       AND existing_sample.governance_state = 'synthetic_fixture'
       AND existing_sample.qualification_packet_id IS NULL
       AND existing_sample.interim_decision_reference IS NULL
       AND existing_sample.rights_evidence_reference IS NULL
       AND existing_sample.published_at IS NULL THEN
      RETURN QUERY SELECT existing_sample.id, 'existing'::text;
      RETURN;
    END IF;
    RAISE EXCEPTION 'MARKETPLACE_SAMPLE_VERSION_CONFLICT' USING ERRCODE = '23505';
  END IF;

  INSERT INTO app.marketplace_sample_versions (
    id,
    service_template_version_id,
    sample_version,
    source_kind,
    object_key,
    content_type,
    record_count,
    byte_count,
    checksum,
    source_metadata_checksum,
    schema_version,
    masking_policy_version,
    retention_policy_version,
    provenance_evidence_reference,
    rights_evidence_reference,
    collected_at,
    published_at,
    expires_at,
    state,
    qualification_packet_id,
    field_dictionary,
    governance_state,
    interim_decision_reference
  ) VALUES (
    p_sample_id,
    p_template_version_id,
    p_sample_version,
    'synthetic_fixture',
    p_object_key,
    p_content_type,
    p_record_count,
    p_byte_count,
    p_checksum,
    p_metadata_checksum,
    p_schema_version,
    p_masking_policy_version,
    p_retention_policy_version,
    p_provenance_evidence_reference,
    NULL,
    p_collected_at,
    NULL,
    p_expires_at,
    'validated_fixture',
    NULL,
    fixture_field_dictionary,
    'synthetic_fixture',
    NULL
  );

  INSERT INTO app.audit_events (
    action, target_type, target_id, outcome, safe_diff
  ) VALUES (
    'marketplace.sample_fixture.ingest',
    'marketplace_sample_version',
    p_sample_id,
    'completed',
    jsonb_build_object(
      'actor', p_actor,
      'template_slug', 'linkedin-posts',
      'template_version', 1,
      'sample_version', p_sample_version,
      'record_count', p_record_count,
      'byte_count', p_byte_count,
      'checksum', encode(p_checksum, 'hex'),
      'schema_version', p_schema_version,
      'masking_policy_version', p_masking_policy_version,
      'retention_policy_version', p_retention_policy_version,
      'expires_at', p_expires_at,
      'source_kind', 'synthetic_fixture',
      'customer_visible', false,
      'provider_calls', 0
    )
  );

  RETURN QUERY SELECT p_sample_id, 'created'::text;
END;
$$;

REVOKE ALL ON FUNCTION app.record_marketplace_fixture_sample(
  uuid, uuid, integer, text, text, integer, bigint, bytea, bytea, integer,
  text, text, text, timestamptz, timestamptz, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_marketplace_fixture_sample(
  uuid, uuid, integer, text, text, integer, bigint, bytea, bytea, integer,
  text, text, text, timestamptz, timestamptz, text
) TO dhumi_operator;

RESET ROLE;
