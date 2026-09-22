-- Priority 2: standard LinkedIn People governed synthetic preview.
--
-- The exact provider metadata observation captured by migration 0060 is the
-- schema authority. This migration admits only a five-record synthetic sample,
-- keeps all PII-marked active fields masked and non-filterable, excludes
-- inactive fields, and reuses the existing authenticated sample APIs. It does
-- not call Bright Data, enable contact enrichment, publish a public Template
-- pointer, create a Service/Run/outbox job, or enable paid export.

SET ROLE dhumi_owner;

ALTER TABLE app.marketplace_sample_versions
  DROP CONSTRAINT marketplace_sample_versions_retention_policy_v2_check;

ALTER TABLE app.marketplace_sample_versions
  ADD CONSTRAINT marketplace_sample_versions_retention_policy_v3_check CHECK (
    retention_policy_version IN (
      'linkedin-posts-sample-30d-v1',
      'linkedin-people-sample-30d-v1'
    )
    AND expires_at = collected_at + interval '720 hours'
  );

CREATE FUNCTION app.resolve_linkedin_people_synthetic_sample_source()
RETURNS TABLE (
  observation_id uuid,
  candidate_id uuid,
  template_version_id uuid,
  template_slug text,
  template_version integer,
  evidence_object_key text,
  metadata_checksum bytea,
  metadata_byte_count bigint,
  metadata_field_count integer,
  observed_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT
    observation.id,
    candidate.id,
    version.id,
    template.slug,
    version.version,
    observation.evidence_object_key,
    observation.metadata_checksum,
    observation.byte_count,
    observation.field_count,
    observation.observed_at
  FROM app.marketplace_catalog_metadata_observations AS observation
  JOIN app.catalog_candidates AS candidate
    ON candidate.id = observation.catalog_candidate_id
  JOIN app.service_template_versions AS version
    ON version.id = candidate.service_template_version_id
  JOIN app.service_templates AS template
    ON template.id = version.service_template_id
  JOIN app.adapter_versions AS adapter
    ON adapter.id = version.adapter_version_id
  JOIN app.adapter_definitions AS definition
    ON definition.id = adapter.adapter_definition_id
  WHERE candidate.id = 'f60af142-3f00-4b0f-b159-86b41ff74b7f'::uuid
    AND candidate.resource_code = 'linkedin.people.standard'
    AND candidate.review_state = 'approved'
    AND observation.metadata_checksum = decode(
      '9b3b7be895b1e063363e46e205c1f9e46864011e6ee76e666ac8a27e0d7a86eb',
      'hex'
    )
    AND observation.byte_count = 32401
    AND observation.field_count = 46
    AND observation.content_type = 'application/json'
    AND template.slug = 'linkedin-people'
    AND template.product_family = 'marketplace_dataset'
    AND template.state = 'draft'
    AND template.current_public_version_id IS NULL
    AND version.version = 1
    AND version.availability_state = 'coming_soon'
    AND version.effective_at IS NULL
    AND version.published_at IS NULL
    AND definition.code = 'bright_data.marketplace.catalogue'
    AND adapter.semantic_version = '1.0.0-m2'
    AND adapter.state = 'disabled'
  ORDER BY observation.observed_at DESC, observation.id DESC
  LIMIT 1;
$$;

CREATE FUNCTION app.record_linkedin_people_synthetic_sample_v1(
  p_sample_id uuid,
  p_observation_id uuid,
  p_template_version_id uuid,
  p_sample_version integer,
  p_object_key text,
  p_record_count integer,
  p_byte_count bigint,
  p_checksum bytea,
  p_metadata_checksum bytea,
  p_field_dictionary jsonb,
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
    'about','activity','first_name','id','input_url','last_name','linkedin_id',
    'name','people_also_viewed','recommendations','similar_profiles','url'
  ]::text[];
BEGIN
  SELECT * INTO source
  FROM app.resolve_linkedin_people_synthetic_sample_source()
  WHERE observation_id = p_observation_id;

  expected_object_key := 'marketplace/samples/' || p_template_version_id::text ||
    '/1/' || encode(p_checksum, 'hex') || '.json';

  IF source.observation_id IS NULL
     OR p_sample_id IS NULL
     OR p_template_version_id IS DISTINCT FROM source.template_version_id
     OR p_sample_version <> 1
     OR p_object_key IS DISTINCT FROM expected_object_key
     OR p_record_count <> 5
     OR p_byte_count < 2
     OR p_checksum IS NULL OR octet_length(p_checksum) <> 32
     OR p_metadata_checksum IS DISTINCT FROM source.metadata_checksum
     OR p_metadata_checksum IS DISTINCT FROM decode(
       '9b3b7be895b1e063363e46e205c1f9e46864011e6ee76e666ac8a27e0d7a86eb',
       'hex'
     )
     OR jsonb_typeof(p_field_dictionary) <> 'array'
     OR jsonb_array_length(p_field_dictionary) <> 42
     OR p_collected_at IS DISTINCT FROM source.observed_at
     OR p_expires_at IS DISTINCT FROM p_collected_at + interval '720 hours'
     OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$' THEN
    RAISE EXCEPTION 'LINKEDIN_PEOPLE_SYNTHETIC_SAMPLE_INVALID'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    WITH expected(name, field_type, required, masked) AS (VALUES
      ('id','text',false,true),
      ('name','text',false,true),
      ('city','text',false,false),
      ('country_code','text',false,false),
      ('position','text',false,false),
      ('about','text',false,true),
      ('posts','array',false,false),
      ('current_company','object',false,false),
      ('experience','array',false,false),
      ('url','url',true,true),
      ('people_also_viewed','array',false,true),
      ('educations_details','text',false,false),
      ('education','array',false,false),
      ('recommendations_count','number',false,false),
      ('avatar','url',false,false),
      ('courses','array',false,false),
      ('languages','array',false,false),
      ('certifications','array',false,false),
      ('recommendations','array',false,true),
      ('volunteer_experience','array',false,false),
      ('followers','number',false,false),
      ('connections','number',false,false),
      ('current_company_company_id','text',false,false),
      ('current_company_name','text',false,false),
      ('publications','array',false,false),
      ('patents','array',false,false),
      ('projects','array',false,false),
      ('organizations','array',false,false),
      ('location','text',false,false),
      ('input_url','url',false,true),
      ('linkedin_id','text',false,true),
      ('activity','array',false,true),
      ('linkedin_num_id','text',true,false),
      ('banner_image','url',false,false),
      ('honors_and_awards','array',false,false),
      ('similar_profiles','array',false,true),
      ('default_avatar','boolean',false,false),
      ('memorialized_account','boolean',false,false),
      ('bio_links','array',false,false),
      ('first_name','text',false,true),
      ('last_name','text',false,true),
      ('influencer','boolean',false,false)
    )
    SELECT 1
    FROM jsonb_array_elements(p_field_dictionary) AS item(field)
    LEFT JOIN expected ON expected.name = item.field->>'name'
    WHERE expected.name IS NULL
       OR jsonb_typeof(item.field) <> 'object'
       OR item.field->>'name' !~ '^[a-z][a-z0-9_]{0,127}$'
       OR item.field->>'type' IS DISTINCT FROM expected.field_type
       OR item.field->'active' IS DISTINCT FROM 'true'::jsonb
       OR item.field->'required' IS DISTINCT FROM to_jsonb(expected.required)
       OR length(item.field->>'description') NOT BETWEEN 1 AND 4000
       OR item.field->>'sample_visibility' IS DISTINCT FROM
          CASE WHEN expected.masked THEN 'masked' ELSE 'visible' END
       OR item.field->>'post_purchase_visibility' IS DISTINCT FROM 'visible'
       OR item.field->'allowed_operators' IS DISTINCT FROM
          CASE
            WHEN expected.masked THEN '[]'::jsonb
            WHEN expected.field_type IN ('array','object')
              THEN '["is_null","is_not_null"]'::jsonb
            WHEN expected.field_type IN ('number','boolean')
              THEN '["=","!=","in","not_in","is_null","is_not_null"]'::jsonb
            ELSE '["=","!=","in","not_in","includes","not_includes","is_null","is_not_null"]'::jsonb
          END
  ) OR (
    SELECT count(DISTINCT field->>'name')
    FROM jsonb_array_elements(p_field_dictionary) AS item(field)
  ) <> 42 OR (
    SELECT array_agg(field->>'name' ORDER BY field->>'name')
    FROM jsonb_array_elements(p_field_dictionary) AS item(field)
    WHERE field->>'sample_visibility' = 'masked'
  ) IS DISTINCT FROM masked_names THEN
    RAISE EXCEPTION 'LINKEDIN_PEOPLE_SYNTHETIC_FIELD_POLICY_INVALID'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_template_version_id::text || ':1', 0)
  );

  SELECT sample.* INTO existing
  FROM app.marketplace_sample_versions AS sample
  WHERE sample.service_template_version_id = p_template_version_id
    AND sample.sample_version = 1;

  IF FOUND THEN
    IF existing.object_key = p_object_key
       AND existing.content_type = 'application/json'
       AND existing.record_count = 5
       AND existing.byte_count = p_byte_count
       AND existing.checksum = p_checksum
       AND existing.source_metadata_checksum = p_metadata_checksum
       AND existing.schema_version = 1
       AND existing.masking_policy_version =
         'linkedin-people-provider-metadata-pii-mask-v1'
       AND existing.retention_policy_version = 'linkedin-people-sample-30d-v1'
       AND existing.provenance_evidence_reference =
         'fixture://marketplace/linkedin-people/metadata-derived-v1'
       AND existing.rights_evidence_reference IS NULL
       AND existing.collected_at = p_collected_at
       AND existing.published_at IS NULL
       AND existing.expires_at = p_expires_at
       AND existing.source_kind = 'synthetic_fixture'
       AND existing.state = 'validated_fixture'
       AND existing.qualification_packet_id IS NULL
       AND existing.field_dictionary = p_field_dictionary
       AND existing.governance_state = 'synthetic_fixture'
       AND existing.interim_decision_reference IS NULL THEN
      RETURN QUERY SELECT existing.id, 'existing'::text;
      RETURN;
    END IF;
    RAISE EXCEPTION 'LINKEDIN_PEOPLE_SYNTHETIC_SAMPLE_VERSION_CONFLICT'
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
    p_sample_id, p_template_version_id, 1, 'synthetic_fixture',
    p_object_key, 'application/json', 5, p_byte_count, p_checksum,
    p_metadata_checksum, 1, 'linkedin-people-provider-metadata-pii-mask-v1',
    'linkedin-people-sample-30d-v1',
    'fixture://marketplace/linkedin-people/metadata-derived-v1',
    NULL, p_collected_at, NULL, p_expires_at, 'validated_fixture',
    NULL, p_field_dictionary, 'synthetic_fixture', NULL
  );

  INSERT INTO app.audit_events (action, target_type, target_id, outcome, safe_diff)
  VALUES (
    'marketplace.sample_fixture.ingest',
    'marketplace_sample_version',
    p_sample_id,
    'completed',
    jsonb_build_object(
      'actor', p_actor,
      'template_slug', 'linkedin-people',
      'template_version', 1,
      'sample_version', 1,
      'source_observation_id', p_observation_id,
      'record_count', 5,
      'provider_metadata_field_count', 46,
      'active_field_count', 42,
      'masked_field_count', 12,
      'inactive_field_count', 4,
      'metadata_checksum', encode(p_metadata_checksum, 'hex'),
      'checksum', encode(p_checksum, 'hex'),
      'pre_purchase_masking', true,
      'masked_field_filtering', false,
      'contact_enrichment_enabled', false,
      'customer_execution_enabled', false,
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
STABLE
SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT
    template.id,
    template.slug,
    version.version,
    version.public_name,
    CASE template.slug
      WHEN 'linkedin-posts' THEN
        'Preview a governed LinkedIn Posts sample before purchase.'
      ELSE 'Preview a governed LinkedIn People sample before purchase.'
    END,
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
      FROM jsonb_array_elements(sample.field_dictionary)
        WITH ORDINALITY AS item(field, ordinal)
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
      AND stored.collected_at <= p_as_of
      AND stored.expires_at > p_as_of
      AND NOT EXISTS (
        SELECT 1 FROM app.marketplace_sample_deletions AS deletion
        WHERE deletion.sample_version_id = stored.id
      )
      AND (
        (
          template.slug = 'linkedin-posts'
          AND stored.retention_policy_version = 'linkedin-posts-sample-30d-v1'
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
        )
        OR
        (
          template.slug = 'linkedin-people'
          AND stored.sample_version = 1
          AND stored.source_kind = 'synthetic_fixture'
          AND stored.state = 'validated_fixture'
          AND stored.governance_state = 'synthetic_fixture'
          AND stored.qualification_packet_id IS NULL
          AND stored.rights_evidence_reference IS NULL
          AND stored.published_at IS NULL
          AND stored.masking_policy_version =
            'linkedin-people-provider-metadata-pii-mask-v1'
          AND stored.retention_policy_version = 'linkedin-people-sample-30d-v1'
          AND stored.source_metadata_checksum = decode(
            '9b3b7be895b1e063363e46e205c1f9e46864011e6ee76e666ac8a27e0d7a86eb',
            'hex'
          )
          AND jsonb_array_length(stored.field_dictionary) = 42
        )
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
  WHERE p_as_of IS NOT NULL
    AND (p_template_slug IS NULL OR template.slug = p_template_slug)
    AND template.slug IN ('linkedin-posts', 'linkedin-people')
    AND template.product_family = 'marketplace_dataset'
    AND template.state = 'draft'
    AND template.current_public_version_id IS NULL
    AND version.version = 1
    AND version.availability_state = 'coming_soon'
    AND version.effective_at IS NULL
    AND version.published_at IS NULL
    AND candidate.resource_code = CASE template.slug
      WHEN 'linkedin-posts' THEN 'linkedin.posts'
      ELSE 'linkedin.people.standard'
    END
    AND candidate.review_state = 'approved'
    AND definition.code = 'bright_data.marketplace.catalogue'
    AND adapter.semantic_version = '1.0.0-m2'
    AND adapter.state = 'disabled'
  ORDER BY template.slug;
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
    AND sample.retention_policy_version IN (
      'linkedin-posts-sample-30d-v1',
      'linkedin-people-sample-30d-v1'
    )
    AND sample.expires_at <= p_as_of
    AND NOT EXISTS (
      SELECT 1 FROM app.marketplace_sample_deletions AS deletion
      WHERE deletion.sample_version_id = sample.id
    )
  ORDER BY sample.expires_at, sample.id
  LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION app.resolve_linkedin_people_synthetic_sample_source()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app.record_linkedin_people_synthetic_sample_v1(
  uuid, uuid, uuid, integer, text, integer, bigint, bytea, bytea, jsonb,
  timestamptz, timestamptz, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.resolve_linkedin_people_synthetic_sample_source()
  TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.record_linkedin_people_synthetic_sample_v1(
  uuid, uuid, uuid, integer, text, integer, bigint, bytea, bytea, jsonb,
  timestamptz, timestamptz, text
) TO dhumi_operator;

REVOKE ALL ON FUNCTION app.resolve_marketplace_sample_preview(text, timestamptz)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_marketplace_sample_preview(text, timestamptz)
  TO dhumi_customer_api;

RESET ROLE;
