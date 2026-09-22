-- Privileged, rollback-only M4 stored-sample preview proof. No provider is contacted.
\set ON_ERROR_STOP on

BEGIN;

CREATE FUNCTION pg_temp.assert_true(value boolean, message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'assertion failed: %', message;
  END IF;
END;
$$;

SET LOCAL ROLE dhumi_operator;

SELECT * FROM app.begin_marketplace_catalog_import(
  '7f000000-0000-4000-8000-000000000010',
  'test',
  'm4.database.proof',
  'checkpoint://dataset-market/m4/database-proof'
);

SELECT app.complete_marketplace_catalog_import(
  '7f000000-0000-4000-8000-000000000010',
  jsonb_build_array(
    jsonb_build_object(
      'id', '7f000000-0000-4000-8000-000000000011',
      'offer_code', 'linkedin.posts',
      'provider_name', 'LinkedIn posts',
      'record_count', 1000000,
      'catalogue_entry_checksum_hex', repeat('11', 32),
      'ciphertext_hex', repeat('21', 40),
      'fingerprint_hex', repeat('31', 32),
      'metadata_object_key',
        'qualification/catalog-imports/7f000000-0000-4000-8000-000000000010/metadata/linkedin-posts.json',
      'metadata_checksum_hex',
        'c210bf596129141cee74e7d4b339fc70b12fd4117201c693116073bcdde7d3a4',
      'metadata_observed_at', '2026-09-11T10:00:00.000Z'
    ),
    jsonb_build_object(
      'id', '7f000000-0000-4000-8000-000000000012',
      'offer_code', 'linkedin.people.standard',
      'provider_name', 'LinkedIn people profiles',
      'record_count', 2000000,
      'catalogue_entry_checksum_hex', repeat('12', 32),
      'ciphertext_hex', repeat('22', 40),
      'fingerprint_hex', repeat('32', 32),
      'metadata_object_key',
        'qualification/catalog-imports/7f000000-0000-4000-8000-000000000010/metadata/linkedin-people-standard.json',
      'metadata_checksum_hex', repeat('42', 32),
      'metadata_observed_at', '2026-09-11T10:00:00.000Z'
    )
  ),
  'qualification/catalog-imports/7f000000-0000-4000-8000-000000000010/marketplace-dataset-list.json',
  decode(repeat('51', 32), 'hex'),
  'm4.database.proof'
);

SELECT * FROM app.review_marketplace_catalog_candidate(
  '7f000000-0000-4000-8000-000000000011',
  'approve',
  'm4.database.reviewer'
);

SELECT template_version_id, metadata_checksum
FROM app.resolve_marketplace_sample_ingestion_target('linkedin-posts', 1)
\gset m4_

SELECT * FROM app.record_marketplace_fixture_sample(
  '7f000000-0000-4000-8000-000000000020',
  :'m4_template_version_id'::uuid,
  1,
  'marketplace/samples/' || :'m4_template_version_id' || '/1/' || repeat('61', 32) || '.json',
  'application/json',
  2,
  321,
  decode(repeat('61', 32), 'hex'),
  :'m4_metadata_checksum'::bytea,
  1,
  'linkedin-posts-provider-mask-preservation-v1',
  'linkedin-posts-sample-30d-v1',
  'fixture://marketplace-samples/linkedin-posts-v1',
  '2026-09-11T09:00:00.000Z',
  '2026-10-11T09:00:00.000Z',
  'm4.database.proof'
);

RESET ROLE;
SET LOCAL ROLE dhumi_customer_api;
SELECT set_config('app.tenant_id', '7f000000-0000-4000-8000-000000000099', true);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
      AND bool_and(template_slug = 'linkedin-posts')
      AND bool_and(template_version = 1)
      AND bool_and(sample_version = 1)
      AND bool_and(sample_record_count = 2)
      AND bool_and(provider_record_count = 1000000)
    FROM app.resolve_marketplace_sample_preview(
      NULL,
      '2026-09-12T09:00:00.000Z'
    )
  ),
  'the Marketplace list projection must expose exactly one governed Posts sample'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
      AND bool_and(jsonb_array_length(fields) = 2)
      AND bool_and(fields @> '[{"name":"url","sample_visibility":"visible"}]'::jsonb)
      AND bool_and(fields @> '[{"name":"text","sample_visibility":"masked"}]'::jsonb)
    FROM app.resolve_marketplace_sample_preview(
      'linkedin-posts',
      '2026-09-12T09:00:00.000Z'
    )
  ),
  'the Posts detail projection must expose only the two reviewed fields and their masking policy'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM app.resolve_marketplace_sample_preview(
      'linkedin-people',
      '2026-09-12T09:00:00.000Z'
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM app.resolve_marketplace_sample_preview(
      'linkedin-people-contact-enriched',
      '2026-09-12T09:00:00.000Z'
    )
  ),
  'LinkedIn People and contact-enriched People must remain absent from M4'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM app.resolve_marketplace_sample_preview(
      'linkedin-posts',
      '2026-10-11T09:00:00.000Z'
    )
  ),
  'the preview must disappear exactly when the 30-day fixture expires'
);

RESET ROLE;

SELECT pg_temp.assert_true(
  has_function_privilege(
    'dhumi_customer_api',
    'app.resolve_marketplace_sample_preview(text,timestamp with time zone)',
    'EXECUTE'
  )
  AND NOT has_table_privilege(
    'dhumi_customer_api',
    'app.marketplace_sample_versions',
    'SELECT'
  )
  AND NOT has_table_privilege(
    'dhumi_customer_api',
    'app.catalog_candidates',
    'SELECT'
  ),
  'the Customer API must use the narrow projection rather than private tables'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM app.provider_mappings AS mapping
    JOIN app.service_template_versions AS version
      ON version.id = mapping.service_template_version_id
    WHERE version.id = :'m4_template_version_id'::uuid
  ),
  'M4 must not create a provider execution mapping'
);

ROLLBACK;
