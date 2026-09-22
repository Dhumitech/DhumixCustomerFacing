-- Privileged, rollback-only M2 proof. The provider is never contacted.
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
  (
    SELECT count(*) = 1
      AND bool_and(version.state = 'disabled')
      AND bool_and(version.capability_metadata ->> 'can_filter' = 'false')
      AND bool_and(version.capability_metadata ->> 'can_purchase' = 'false')
      AND bool_and(version.capability_metadata ->> 'can_execute' = 'false')
      AND bool_and(version.capability_metadata ->> 'can_publish' = 'false')
    FROM app.adapter_definitions AS definition
    JOIN app.adapter_versions AS version
      ON version.adapter_definition_id = definition.id
    WHERE definition.code = 'bright_data.marketplace.catalogue'
      AND version.semantic_version = '1.0.0-m2'
  ),
  'M2 adapter must be disabled and restricted to private catalogue reads'
);

SET LOCAL ROLE dhumi_operator;

SELECT * FROM app.begin_marketplace_catalog_import(
  '7d000000-0000-4000-8000-000000000010',
  'test',
  'm2.database.proof',
  'checkpoint://dataset-market/m2/database-proof'
);

SELECT app.complete_marketplace_catalog_import(
  '7d000000-0000-4000-8000-000000000010',
  jsonb_build_array(
    jsonb_build_object(
      'id', '7d000000-0000-4000-8000-000000000011',
      'offer_code', 'linkedin.posts',
      'provider_name', 'LinkedIn posts',
      'record_count', NULL,
      'catalogue_entry_checksum_hex', repeat('11', 32),
      'ciphertext_hex', repeat('21', 40),
      'fingerprint_hex', repeat('31', 32),
      'metadata_object_key',
        'qualification/catalog-imports/7d000000-0000-4000-8000-000000000010/metadata/linkedin-posts.json',
      'metadata_checksum_hex', repeat('41', 32),
      'metadata_observed_at', '2026-09-11T10:00:00.000Z'
    ),
    jsonb_build_object(
      'id', '7d000000-0000-4000-8000-000000000012',
      'offer_code', 'linkedin.people.standard',
      'provider_name', 'LinkedIn people profiles',
      'record_count', 115000000,
      'catalogue_entry_checksum_hex', repeat('12', 32),
      'ciphertext_hex', repeat('22', 40),
      'fingerprint_hex', repeat('32', 32),
      'metadata_object_key',
        'qualification/catalog-imports/7d000000-0000-4000-8000-000000000010/metadata/linkedin-people-standard.json',
      'metadata_checksum_hex', repeat('42', 32),
      'metadata_observed_at', '2026-09-11T10:00:00.000Z'
    )
  ),
  'qualification/catalog-imports/7d000000-0000-4000-8000-000000000010/marketplace-dataset-list.json',
  decode(repeat('51', 32), 'hex'),
  'm2.database.proof'
);

SELECT * FROM app.review_marketplace_catalog_candidate(
  '7d000000-0000-4000-8000-000000000011',
  'approve',
  'm2.database.reviewer'
);

SELECT * FROM app.review_marketplace_catalog_candidate(
  '7d000000-0000-4000-8000-000000000012',
  'reject',
  'm2.database.reviewer'
);

-- Exact observations in another import must reuse the reviewed candidates.
SELECT * FROM app.begin_marketplace_catalog_import(
  '7d000000-0000-4000-8000-000000000020',
  'test',
  'm2.database.proof',
  'checkpoint://dataset-market/m2/database-proof'
);

SELECT app.complete_marketplace_catalog_import(
  '7d000000-0000-4000-8000-000000000020',
  jsonb_build_array(
    jsonb_build_object(
      'id', '7d000000-0000-4000-8000-000000000021',
      'offer_code', 'linkedin.posts',
      'provider_name', 'LinkedIn posts',
      'record_count', NULL,
      'catalogue_entry_checksum_hex', repeat('11', 32),
      'ciphertext_hex', repeat('23', 40),
      'fingerprint_hex', repeat('31', 32),
      'metadata_object_key',
        'qualification/catalog-imports/7d000000-0000-4000-8000-000000000020/metadata/linkedin-posts.json',
      'metadata_checksum_hex', repeat('41', 32),
      'metadata_observed_at', '2026-09-11T11:00:00.000Z'
    ),
    jsonb_build_object(
      'id', '7d000000-0000-4000-8000-000000000022',
      'offer_code', 'linkedin.people.standard',
      'provider_name', 'LinkedIn people profiles',
      'record_count', 115000000,
      'catalogue_entry_checksum_hex', repeat('12', 32),
      'ciphertext_hex', repeat('24', 40),
      'fingerprint_hex', repeat('32', 32),
      'metadata_object_key',
        'qualification/catalog-imports/7d000000-0000-4000-8000-000000000020/metadata/linkedin-people-standard.json',
      'metadata_checksum_hex', repeat('42', 32),
      'metadata_observed_at', '2026-09-11T11:00:00.000Z'
    )
  ),
  'qualification/catalog-imports/7d000000-0000-4000-8000-000000000020/marketplace-dataset-list.json',
  decode(repeat('52', 32), 'hex'),
  'm2.database.proof'
);

-- Changed Posts metadata must create a new pending review candidate, while
-- unchanged People metadata remains the same rejected candidate.
SELECT * FROM app.begin_marketplace_catalog_import(
  '7d000000-0000-4000-8000-000000000030',
  'test',
  'm2.database.proof',
  'checkpoint://dataset-market/m2/database-proof'
);

SELECT app.complete_marketplace_catalog_import(
  '7d000000-0000-4000-8000-000000000030',
  jsonb_build_array(
    jsonb_build_object(
      'id', '7d000000-0000-4000-8000-000000000031',
      'offer_code', 'linkedin.posts',
      'provider_name', 'LinkedIn posts',
      'record_count', NULL,
      'catalogue_entry_checksum_hex', repeat('11', 32),
      'ciphertext_hex', repeat('25', 40),
      'fingerprint_hex', repeat('31', 32),
      'metadata_object_key',
        'qualification/catalog-imports/7d000000-0000-4000-8000-000000000030/metadata/linkedin-posts.json',
      'metadata_checksum_hex', repeat('49', 32),
      'metadata_observed_at', '2026-09-11T12:00:00.000Z'
    ),
    jsonb_build_object(
      'id', '7d000000-0000-4000-8000-000000000032',
      'offer_code', 'linkedin.people.standard',
      'provider_name', 'LinkedIn people profiles',
      'record_count', 115000000,
      'catalogue_entry_checksum_hex', repeat('12', 32),
      'ciphertext_hex', repeat('26', 40),
      'fingerprint_hex', repeat('32', 32),
      'metadata_object_key',
        'qualification/catalog-imports/7d000000-0000-4000-8000-000000000030/metadata/linkedin-people-standard.json',
      'metadata_checksum_hex', repeat('42', 32),
      'metadata_observed_at', '2026-09-11T12:00:00.000Z'
    )
  ),
  'qualification/catalog-imports/7d000000-0000-4000-8000-000000000030/marketplace-dataset-list.json',
  decode(repeat('53', 32), 'hex'),
  'm2.database.proof'
);

RESET ROLE;

SELECT pg_temp.assert_true(
  (SELECT count(*) = 3 FROM app.catalog_candidates WHERE resource_code IS NOT NULL),
  'exact re-imports must be idempotent and metadata drift must remain reviewable'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 6
    FROM app.catalog_import_candidate_observations AS observation
    JOIN app.catalog_candidates AS candidate
      ON candidate.id = observation.catalog_candidate_id
    WHERE candidate.resource_code IS NOT NULL
  ),
  'every import must retain its immutable candidate observation lineage'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
      AND bool_and(template.state = 'draft')
      AND bool_and(template.current_public_version_id IS NULL)
      AND bool_and(version.availability_state = 'coming_soon')
      AND bool_and(version.effective_at IS NULL)
      AND bool_and(version.published_at IS NULL)
      AND bool_and(evidence.state = 'pending')
    FROM app.service_templates AS template
    JOIN app.service_template_versions AS version
      ON version.service_template_id = template.id
    JOIN app.launch_evidence AS evidence ON evidence.id = version.launch_evidence_id
    WHERE template.slug = 'linkedin-posts'
  ),
  'approval must create one evidence-linked draft and never publish it'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM app.service_templates WHERE slug = 'linkedin-people'
  ),
  'rejection must not create a Template'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM app.provider_mappings AS mapping
    JOIN app.adapter_versions AS adapter ON adapter.id = mapping.adapter_version_id
    JOIN app.adapter_definitions AS definition
      ON definition.id = adapter.adapter_definition_id
    WHERE definition.code = 'bright_data.marketplace.catalogue'
  ),
  'M2 must never create a provider execution mapping'
);

SELECT pg_temp.assert_true(
  NOT has_function_privilege(
    'dhumi_customer_api',
    'app.begin_marketplace_catalog_import(uuid,text,text,text)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'dhumi_customer_api',
    'app.complete_marketplace_catalog_import(uuid,jsonb,text,bytea,text)',
    'EXECUTE'
  )
  AND NOT has_table_privilege(
    'dhumi_customer_api',
    'app.catalog_candidates',
    'SELECT'
  ),
  'provider references and import controls must remain outside the Customer API role'
);

SET LOCAL ROLE dhumi_customer_api;
SELECT set_config('app.tenant_id', '7d000000-0000-4000-8000-000000000099', true);
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM app.service_templates
    WHERE product_family = 'marketplace_dataset'
  ),
  'M2 draft candidates must not be customer-visible'
);
RESET ROLE;

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname LIKE 'dhumi%marketplace%'
       OR rolname LIKE 'dhumi%m2%'
  ),
  'M2 must reuse the existing operator identity'
);

ROLLBACK;
