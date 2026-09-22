-- Privileged, rollback-only M3 fixture-ingestion proof. No provider is contacted.
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

SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'app.marketplace_sample_versions'::regclass
      AND tgname = 'marketplace_sample_versions_immutable'
      AND NOT tgisinternal
  ),
  'sample versions must be immutable'
);

SET LOCAL ROLE dhumi_operator;

SELECT * FROM app.begin_marketplace_catalog_import(
  '7e000000-0000-4000-8000-000000000010',
  'test',
  'm3.database.proof',
  'checkpoint://dataset-market/m3/database-proof'
);

SELECT app.complete_marketplace_catalog_import(
  '7e000000-0000-4000-8000-000000000010',
  jsonb_build_array(
    jsonb_build_object(
      'id', '7e000000-0000-4000-8000-000000000011',
      'offer_code', 'linkedin.posts',
      'provider_name', 'LinkedIn posts',
      'record_count', NULL,
      'catalogue_entry_checksum_hex', repeat('11', 32),
      'ciphertext_hex', repeat('21', 40),
      'fingerprint_hex', repeat('31', 32),
      'metadata_object_key',
        'qualification/catalog-imports/7e000000-0000-4000-8000-000000000010/metadata/linkedin-posts.json',
      'metadata_checksum_hex',
        'c210bf596129141cee74e7d4b339fc70b12fd4117201c693116073bcdde7d3a4',
      'metadata_observed_at', '2026-09-11T10:00:00.000Z'
    ),
    jsonb_build_object(
      'id', '7e000000-0000-4000-8000-000000000012',
      'offer_code', 'linkedin.people.standard',
      'provider_name', 'LinkedIn people profiles',
      'record_count', NULL,
      'catalogue_entry_checksum_hex', repeat('12', 32),
      'ciphertext_hex', repeat('22', 40),
      'fingerprint_hex', repeat('32', 32),
      'metadata_object_key',
        'qualification/catalog-imports/7e000000-0000-4000-8000-000000000010/metadata/linkedin-people-standard.json',
      'metadata_checksum_hex', repeat('42', 32),
      'metadata_observed_at', '2026-09-11T10:00:00.000Z'
    )
  ),
  'qualification/catalog-imports/7e000000-0000-4000-8000-000000000010/marketplace-dataset-list.json',
  decode(repeat('51', 32), 'hex'),
  'm3.database.proof'
);

SELECT * FROM app.review_marketplace_catalog_candidate(
  '7e000000-0000-4000-8000-000000000011',
  'approve',
  'm3.database.reviewer'
);

SELECT template_version_id, metadata_checksum
FROM app.resolve_marketplace_sample_ingestion_target('linkedin-posts', 1)
\gset m3_

SELECT * FROM app.record_marketplace_fixture_sample(
  '7e000000-0000-4000-8000-000000000020',
  :'m3_template_version_id'::uuid,
  1,
  'marketplace/samples/' || :'m3_template_version_id' || '/1/' || repeat('61', 32) || '.json',
  'application/json',
  2,
  321,
  decode(repeat('61', 32), 'hex'),
  :'m3_metadata_checksum'::bytea,
  1,
  'linkedin-posts-provider-mask-preservation-v1',
  'linkedin-posts-sample-30d-v1',
  'fixture://marketplace-samples/linkedin-posts-v1',
  '2026-09-11T09:00:00.000Z',
  '2026-10-11T09:00:00.000Z',
  'm3.database.proof'
) \gset m3_created_

-- Exact replay must reuse the immutable row, not create a duplicate.
SELECT * FROM app.record_marketplace_fixture_sample(
  '7e000000-0000-4000-8000-000000000021',
  :'m3_template_version_id'::uuid,
  1,
  'marketplace/samples/' || :'m3_template_version_id' || '/1/' || repeat('61', 32) || '.json',
  'application/json',
  2,
  321,
  decode(repeat('61', 32), 'hex'),
  :'m3_metadata_checksum'::bytea,
  1,
  'linkedin-posts-provider-mask-preservation-v1',
  'linkedin-posts-sample-30d-v1',
  'fixture://marketplace-samples/linkedin-posts-v1',
  '2026-09-11T09:00:00.000Z',
  '2026-10-11T09:00:00.000Z',
  'm3.database.proof'
) \gset m3_replayed_

DO $$
DECLARE
  target_id uuid;
BEGIN
  SELECT template_version_id INTO target_id
  FROM app.resolve_marketplace_sample_ingestion_target('linkedin-posts', 1);

  BEGIN
    PERFORM app.record_marketplace_fixture_sample(
      '7e000000-0000-4000-8000-000000000022',
      target_id,
      2,
      'marketplace/samples/' || target_id::text || '/2/' || repeat('62', 32) || '.json',
      'application/json',
      2,
      321,
      decode(repeat('62', 32), 'hex'),
      decode(repeat('41', 32), 'hex'),
      1,
      'linkedin-posts-provider-mask-preservation-v1',
      'linkedin-posts-sample-30d-v1',
      'fixture://marketplace-samples/linkedin-posts-v2',
      '2026-09-11T09:00:00.000Z',
      '2026-10-11T09:00:00.000Z',
      'm3.database.proof'
    );
    RAISE EXCEPTION 'metadata drift was accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;
END;
$$;

RESET ROLE;

SELECT pg_temp.assert_true(
  :'m3_created_disposition' = 'created'
  AND :'m3_replayed_disposition' = 'existing'
  AND :'m3_created_sample_id' = :'m3_replayed_sample_id',
  'fixture ingestion must be idempotent on the current schema'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
      AND bool_and(source_kind = 'synthetic_fixture')
      AND bool_and(state = 'validated_fixture')
      AND bool_and(rights_evidence_reference IS NULL)
      AND bool_and(published_at IS NULL)
      AND bool_and(retention_policy_version = 'linkedin-posts-sample-30d-v1')
      AND bool_and(expires_at = collected_at + interval '720 hours')
      AND bool_and(governance_state = 'synthetic_fixture')
      AND bool_and(qualification_packet_id IS NULL)
      AND bool_and(interim_decision_reference IS NULL)
      AND bool_and(jsonb_array_length(field_dictionary) = 2)
      AND bool_and(field_dictionary @> '[{"name":"url","sample_visibility":"visible"}]'::jsonb)
      AND bool_and(field_dictionary @> '[{"name":"text","sample_visibility":"masked","allowed_operators":[]}]'::jsonb)
    FROM app.marketplace_sample_versions
  ),
  'M3 must retain one private fixture-only sample with the current governed dictionary'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
    FROM app.resolve_marketplace_fixture_sample(
      'linkedin-posts',
      1,
      1,
      '2026-10-11T08:59:59.999Z'
    )
  ),
  'an unexpired fixture must be internally resolvable'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM app.resolve_marketplace_fixture_sample(
      'linkedin-posts',
      1,
      1,
      '2026-10-11T09:00:00.000Z'
    )
  ),
  'a fixture must become unavailable exactly at expiry'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
    FROM app.list_expired_marketplace_fixture_samples(
      '2026-10-11T09:00:00.000Z',
      25
    )
  ),
  'an expired fixture must enter the private deletion workflow'
);

SET LOCAL ROLE dhumi_operator;

SELECT * FROM app.record_marketplace_fixture_deletion(
  '7e000000-0000-4000-8000-000000000020',
  '2026-10-11T09:00:00.000Z',
  'deleted',
  'm3.database.expiry'
);

-- Exact replay is idempotent and cannot create duplicate evidence.
SELECT * FROM app.record_marketplace_fixture_deletion(
  '7e000000-0000-4000-8000-000000000020',
  '2026-10-11T09:00:00.000Z',
  'deleted',
  'm3.database.expiry'
);

RESET ROLE;

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
    FROM app.marketplace_sample_deletions
  )
  AND NOT EXISTS (
    SELECT 1
    FROM app.list_expired_marketplace_fixture_samples(
      '2026-10-11T09:00:00.000Z',
      25
    )
  ),
  'deletion evidence must be immutable and remove the fixture from due work'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
      AND bool_and(NOT (safe_diff ? 'object_key'))
      AND bool_and(safe_diff ->> 'sample_content_retained' = 'false')
      AND bool_and(safe_diff ->> 'provider_calls' = '0')
    FROM app.audit_events
    WHERE action = 'marketplace.sample_fixture.expire'
  ),
  'expiry must write exactly one safe audit without content or object key'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
      AND bool_and(NOT (safe_diff ? 'object_key'))
      AND bool_and(safe_diff ->> 'customer_visible' = 'false')
      AND bool_and(safe_diff ->> 'provider_calls' = '0')
    FROM app.audit_events
    WHERE action = 'marketplace.sample_fixture.ingest'
  ),
  'M3 fixture ingestion must write one safe audit without its private object key'
);

SELECT pg_temp.assert_true(
  NOT has_table_privilege(
    'dhumi_customer_api',
    'app.marketplace_sample_versions',
    'SELECT'
  )
  AND NOT has_function_privilege(
    'dhumi_customer_api',
    'app.resolve_marketplace_sample_ingestion_target(text,integer)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'dhumi_customer_api',
    'app.record_marketplace_fixture_sample(uuid,uuid,integer,text,text,integer,bigint,bytea,bytea,integer,text,text,text,timestamptz,timestamptz,text)',
    'EXECUTE'
  )
  AND NOT has_table_privilege(
    'dhumi_customer_api',
    'app.marketplace_sample_deletions',
    'SELECT'
  )
  AND NOT has_function_privilege(
    'dhumi_customer_api',
    'app.resolve_marketplace_fixture_sample(text,integer,integer,timestamp with time zone)',
    'EXECUTE'
  ),
  'M3 fixture records and controls must remain outside the Customer API role'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
      AND bool_and(template.state = 'draft')
      AND bool_and(template.current_public_version_id IS NULL)
      AND bool_and(version.availability_state = 'coming_soon')
      AND bool_and(version.published_at IS NULL)
    FROM app.service_templates AS template
    JOIN app.service_template_versions AS version
      ON version.service_template_id = template.id
    WHERE template.slug = 'linkedin-posts'
  ),
  'M3 fixture ingestion must not publish its Template'
);

DO $$
BEGIN
  BEGIN
    UPDATE app.marketplace_sample_versions SET sample_version = 2;
    RAISE EXCEPTION 'expected immutable sample update rejection';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;
  BEGIN
    DELETE FROM app.marketplace_sample_versions;
    RAISE EXCEPTION 'expected immutable sample delete rejection';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
      NULL;
  END;
  BEGIN
    DELETE FROM app.marketplace_sample_deletions;
    RAISE EXCEPTION 'expected immutable sample deletion-evidence rejection';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;
END;
$$;

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname LIKE 'dhumi%marketplace%'
       OR rolname LIKE 'dhumi%m3%'
  ),
  'M3 must reuse the existing operator identity'
);

ROLLBACK;
