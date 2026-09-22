-- Rollback-only Priority 2 proof. Provider calls: zero.
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
  '8b000000-0000-4000-8000-000000000001',
  'test',
  'people.metadata.database.proof',
  'checkpoint://dataset-market/linkedin-people/database-proof'
);

SELECT app.complete_marketplace_catalog_import(
  '8b000000-0000-4000-8000-000000000001',
  jsonb_build_array(
    jsonb_build_object(
      'id', '8b000000-0000-4000-8000-000000000002',
      'offer_code', 'linkedin.posts',
      'provider_name', 'LinkedIn posts',
      'record_count', NULL,
      'catalogue_entry_checksum_hex', repeat('11', 32),
      'ciphertext_hex', repeat('21', 40),
      'fingerprint_hex', repeat('31', 32),
      'metadata_object_key',
        'qualification/catalog-imports/8b000000-0000-4000-8000-000000000001/metadata/linkedin-posts.json',
      'metadata_checksum_hex', repeat('41', 32),
      'metadata_observed_at', '2026-09-13T20:00:00.000Z'
    ),
    jsonb_build_object(
      'id', '8b000000-0000-4000-8000-000000000003',
      'offer_code', 'linkedin.people.standard',
      'provider_name', 'LinkedIn people profiles',
      'record_count', 115000000,
      'catalogue_entry_checksum_hex', repeat('12', 32),
      'ciphertext_hex', repeat('22', 40),
      'fingerprint_hex', repeat('32', 32),
      'metadata_object_key',
        'qualification/catalog-imports/8b000000-0000-4000-8000-000000000001/metadata/linkedin-people-standard.json',
      'metadata_checksum_hex', repeat('42', 32),
      'metadata_observed_at', '2026-09-13T20:00:00.000Z'
    )
  ),
  'qualification/catalog-imports/8b000000-0000-4000-8000-000000000001/marketplace-dataset-list.json',
  decode(repeat('51', 32), 'hex'),
  'people.metadata.database.proof'
);

SELECT * FROM app.review_marketplace_catalog_candidate(
  '8b000000-0000-4000-8000-000000000002',
  'reject',
  'people.metadata.database.reviewer'
);

SELECT * FROM app.review_marketplace_catalog_candidate(
  '8b000000-0000-4000-8000-000000000003',
  'approve',
  'people.metadata.database.reviewer'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
      AND bool_and(candidate_id = '8b000000-0000-4000-8000-000000000003'::uuid)
      AND bool_and(environment = 'test')
      AND bool_and(resource_code = 'linkedin.people.standard')
      AND bool_and(octet_length(provider_resource_ciphertext) = 40)
      AND bool_and(octet_length(provider_resource_fingerprint) = 32)
    FROM app.resolve_linkedin_people_metadata_candidate(
      '8b000000-0000-4000-8000-000000000003'
    )
  ),
  'only the approved standard People candidate may resolve'
);

SELECT * FROM app.record_linkedin_people_metadata_observation(
  '8b000000-0000-4000-8000-000000000004',
  '8b000000-0000-4000-8000-000000000003',
  'qualification/catalog-imports/8b000000-0000-4000-8000-000000000004/metadata/linkedin-people-standard.json',
  decode(repeat('61', 32), 'hex'),
  4096,
  37,
  'application/json',
  'checkpoint://dataset-market/linkedin-people/metadata-v1',
  'people.metadata.database.proof'
);

RESET ROLE;

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
      AND bool_and(field_count = 37)
      AND bool_and(byte_count = 4096)
      AND bool_and(content_type = 'application/json')
      AND bool_and(octet_length(metadata_checksum) = 32)
    FROM app.marketplace_catalog_metadata_observations
    WHERE id = '8b000000-0000-4000-8000-000000000004'
  ),
  'one exact private metadata observation must be retained'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
      AND bool_and(outcome = 'completed')
      AND bool_and(safe_diff->>'resource_code' = 'linkedin.people.standard')
      AND bool_and(safe_diff->>'provider_method' = 'GET')
      AND bool_and((safe_diff->>'provider_call_count')::integer = 1)
      AND bool_and((safe_diff->>'public_template_changed')::boolean = false)
      AND bool_and((safe_diff->>'customer_execution_enabled')::boolean = false)
    FROM app.audit_events
    WHERE target_id = '8b000000-0000-4000-8000-000000000004'
      AND action = 'provider.catalog_metadata.capture'
  ),
  'capture must produce exactly one safe audit record'
);

SELECT pg_temp.assert_true(
  (SELECT current_public_version_id IS NULL
   FROM app.service_templates WHERE slug = 'linkedin-people')
  AND NOT EXISTS (SELECT 1 FROM app.services)
  AND NOT EXISTS (SELECT 1 FROM app.runs)
  AND NOT EXISTS (SELECT 1 FROM app.outbox_events),
  'metadata capture must not publish or create customer/provider work'
);

SELECT pg_temp.assert_true(
  NOT has_table_privilege(
    'dhumi_customer_api',
    'app.marketplace_catalog_metadata_observations',
    'SELECT'
  )
  AND NOT has_function_privilege(
    'dhumi_customer_api',
    'app.resolve_linkedin_people_metadata_candidate(uuid)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'dhumi_customer_api',
    'app.record_linkedin_people_metadata_observation(uuid,uuid,text,bytea,bigint,integer,text,text,text)',
    'EXECUTE'
  ),
  'customer capability must not reach private metadata evidence'
);

DO $$
BEGIN
  BEGIN
    SET LOCAL ROLE dhumi_owner;
    UPDATE app.marketplace_catalog_metadata_observations
    SET byte_count = 4097
    WHERE id = '8b000000-0000-4000-8000-000000000004';
    RAISE EXCEPTION 'immutable observation unexpectedly changed';
  EXCEPTION
    WHEN SQLSTATE '55000' THEN NULL;
  END;
END;
$$;

ROLLBACK;
