-- Rollback-only Priority 2 database proof. Provider calls: zero.
\set ON_ERROR_STOP on

BEGIN;

CREATE FUNCTION pg_temp.assert_true(value boolean, message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'assertion failed: %', message;
  END IF;
END;
$$;

SET LOCAL ROLE dhumi_operator;

SELECT * FROM app.begin_marketplace_catalog_import(
  '8c000000-0000-4000-8000-000000000001',
  'test',
  'people.sample.database.proof',
  'checkpoint://dataset-market/linkedin-people/sample-database-proof'
);

SELECT app.complete_marketplace_catalog_import(
  '8c000000-0000-4000-8000-000000000001',
  jsonb_build_array(
    jsonb_build_object(
      'id', '8c000000-0000-4000-8000-000000000002',
      'offer_code', 'linkedin.posts',
      'provider_name', 'LinkedIn posts',
      'record_count', NULL,
      'catalogue_entry_checksum_hex', repeat('11', 32),
      'ciphertext_hex', repeat('21', 40),
      'fingerprint_hex', repeat('31', 32),
      'metadata_object_key',
        'qualification/catalog-imports/8c000000-0000-4000-8000-000000000001/metadata/linkedin-posts.json',
      'metadata_checksum_hex', repeat('41', 32),
      'metadata_observed_at', '2026-09-13T17:00:00.000Z'
    ),
    jsonb_build_object(
      'id', 'f60af142-3f00-4b0f-b159-86b41ff74b7f',
      'offer_code', 'linkedin.people.standard',
      'provider_name', 'LinkedIn people profiles',
      'record_count', 115000000,
      'catalogue_entry_checksum_hex', repeat('12', 32),
      'ciphertext_hex', repeat('22', 40),
      'fingerprint_hex', repeat('32', 32),
      'metadata_object_key',
        'qualification/catalog-imports/8c000000-0000-4000-8000-000000000001/metadata/linkedin-people-standard.json',
      'metadata_checksum_hex', repeat('42', 32),
      'metadata_observed_at', '2026-09-13T17:00:00.000Z'
    )
  ),
  'qualification/catalog-imports/8c000000-0000-4000-8000-000000000001/marketplace-dataset-list.json',
  decode(repeat('51', 32), 'hex'),
  'people.sample.database.proof'
);

SELECT * FROM app.review_marketplace_catalog_candidate(
  '8c000000-0000-4000-8000-000000000002',
  'reject',
  'people.sample.database.reviewer'
);

SELECT * FROM app.review_marketplace_catalog_candidate(
  'f60af142-3f00-4b0f-b159-86b41ff74b7f',
  'approve',
  'people.sample.database.reviewer'
);

SELECT * FROM app.record_linkedin_people_metadata_observation(
  '8c000000-0000-4000-8000-000000000004',
  'f60af142-3f00-4b0f-b159-86b41ff74b7f',
  'qualification/catalog-imports/8c000000-0000-4000-8000-000000000004/metadata/linkedin-people-standard.json',
  decode('9b3b7be895b1e063363e46e205c1f9e46864011e6ee76e666ac8a27e0d7a86eb', 'hex'),
  32401,
  46,
  'application/json',
  'checkpoint://dataset-market/linkedin-people/metadata-v1',
  'people.sample.database.proof'
);

WITH expected(name, field_type, required, masked) AS (VALUES
  ('id','text',false,true), ('name','text',false,true),
  ('city','text',false,false), ('country_code','text',false,false),
  ('position','text',false,false), ('about','text',false,true),
  ('posts','array',false,false), ('current_company','object',false,false),
  ('experience','array',false,false), ('url','url',true,true),
  ('people_also_viewed','array',false,true),
  ('educations_details','text',false,false), ('education','array',false,false),
  ('recommendations_count','number',false,false), ('avatar','url',false,false),
  ('courses','array',false,false), ('languages','array',false,false),
  ('certifications','array',false,false), ('recommendations','array',false,true),
  ('volunteer_experience','array',false,false), ('followers','number',false,false),
  ('connections','number',false,false),
  ('current_company_company_id','text',false,false),
  ('current_company_name','text',false,false), ('publications','array',false,false),
  ('patents','array',false,false), ('projects','array',false,false),
  ('organizations','array',false,false), ('location','text',false,false),
  ('input_url','url',false,true), ('linkedin_id','text',false,true),
  ('activity','array',false,true), ('linkedin_num_id','text',true,false),
  ('banner_image','url',false,false), ('honors_and_awards','array',false,false),
  ('similar_profiles','array',false,true), ('default_avatar','boolean',false,false),
  ('memorialized_account','boolean',false,false), ('bio_links','array',false,false),
  ('first_name','text',false,true), ('last_name','text',false,true),
  ('influencer','boolean',false,false)
), dictionary AS (
  SELECT jsonb_agg(jsonb_build_object(
    'name', name,
    'type', field_type,
    'active', true,
    'required', required,
    'description', 'Verified ' || name || ' field',
    'sample_visibility', CASE WHEN masked THEN 'masked' ELSE 'visible' END,
    'allowed_operators', CASE
      WHEN masked THEN '[]'::jsonb
      WHEN field_type IN ('array','object')
        THEN '["is_null","is_not_null"]'::jsonb
      WHEN field_type IN ('number','boolean')
        THEN '["=","!=","in","not_in","is_null","is_not_null"]'::jsonb
      ELSE '["=","!=","in","not_in","includes","not_includes","is_null","is_not_null"]'::jsonb
    END,
    'post_purchase_visibility', 'visible'
  ) ORDER BY name) AS value
  FROM expected
), source AS (
  SELECT * FROM app.resolve_linkedin_people_synthetic_sample_source()
)
SELECT recorded.*
FROM source
CROSS JOIN dictionary
CROSS JOIN LATERAL app.record_linkedin_people_synthetic_sample_v2(
  '8c000000-0000-4000-8000-000000000005',
  source.observation_id,
  source.template_version_id,
  1,
  'marketplace/samples/' || source.template_version_id::text || '/1/' ||
    repeat('71', 32) || '.json',
  5,
  8192,
  decode(repeat('71', 32), 'hex'),
  source.metadata_checksum,
  dictionary.value,
  'people.sample.database.proof'
) AS recorded;

RESET ROLE;

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
      AND bool_and(sample_version = 1)
      AND bool_and(source_kind = 'synthetic_fixture')
      AND bool_and(state = 'validated_fixture')
      AND bool_and(record_count = 5)
      AND bool_and(jsonb_array_length(field_dictionary) = 42)
      AND bool_and(masking_policy_version =
        'linkedin-people-provider-metadata-pii-mask-v1')
      AND bool_and(retention_policy_version = 'linkedin-people-sample-30d-v1')
      AND bool_and(expires_at = collected_at + interval '720 hours')
      AND bool_and(rights_evidence_reference IS NULL)
      AND bool_and(published_at IS NULL)
    FROM app.marketplace_sample_versions
    WHERE id = '8c000000-0000-4000-8000-000000000005'
  ),
  'one immutable governed People synthetic sample must be recorded'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
      AND bool_and(template_slug = 'linkedin-people')
      AND bool_and(template_version = 1)
      AND bool_and(sample_version = 1)
      AND bool_and(sample_record_count = 5)
      AND bool_and(jsonb_array_length(fields) = 42)
      AND bool_and((
        SELECT count(*) = 12
        FROM jsonb_array_elements(fields) AS item(field)
        WHERE field->>'sample_visibility' = 'masked'
          AND field->'allowed_operators' = '[]'::jsonb
      ))
      AND bool_and((
        SELECT count(*) = 3
        FROM jsonb_array_elements(fields) AS item(field)
        WHERE field->>'type' = 'boolean'
      ))
    FROM app.resolve_marketplace_sample_preview(
      'linkedin-people',
      (SELECT observed_at + interval '1 second'
       FROM app.marketplace_catalog_metadata_observations
       WHERE id = '8c000000-0000-4000-8000-000000000004')
    )
  ),
  'customer preview must expose 42 governed fields and exact masking'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
      AND bool_and((safe_diff->>'provider_metadata_field_count')::integer = 46)
      AND bool_and((safe_diff->>'active_field_count')::integer = 42)
      AND bool_and((safe_diff->>'masked_field_count')::integer = 12)
      AND bool_and((safe_diff->>'contact_enrichment_enabled')::boolean = false)
      AND bool_and((safe_diff->>'customer_execution_enabled')::boolean = false)
      AND bool_and((safe_diff->>'provider_calls')::integer = 0)
    FROM app.audit_events
    WHERE action = 'marketplace.sample_fixture.ingest'
      AND target_id = '8c000000-0000-4000-8000-000000000005'
  ),
  'sample ingestion must record exact no-provider/no-execution audit evidence'
);

SELECT pg_temp.assert_true(
  (SELECT current_public_version_id IS NULL
   FROM app.service_templates WHERE slug = 'linkedin-people')
  AND NOT EXISTS (SELECT 1 FROM app.services)
  AND NOT EXISTS (SELECT 1 FROM app.runs)
  AND NOT EXISTS (SELECT 1 FROM app.outbox_events),
  'People preview must not publish or create customer/provider work'
);

SELECT pg_temp.assert_true(
  NOT has_table_privilege(
    'dhumi_customer_api', 'app.marketplace_catalog_metadata_observations', 'SELECT'
  )
  AND NOT has_table_privilege(
    'dhumi_customer_api', 'app.marketplace_sample_versions', 'SELECT'
  )
  AND has_function_privilege(
    'dhumi_customer_api',
    'app.resolve_marketplace_sample_preview(text,timestamp with time zone)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'dhumi_customer_api',
    'app.resolve_linkedin_people_synthetic_sample_source()',
    'EXECUTE'
  ),
  'customer capability must be limited to the safe preview projection'
);

DO $$
BEGIN
  BEGIN
    UPDATE app.marketplace_sample_versions
    SET record_count = 6
    WHERE id = '8c000000-0000-4000-8000-000000000005';
    RAISE EXCEPTION 'immutable sample unexpectedly changed';
  EXCEPTION
    WHEN SQLSTATE '55000' THEN NULL;
  END;
END;
$$;

ROLLBACK;
