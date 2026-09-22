-- Privileged, rollback-only proof for Backend Release Closure migration 0041.
\set ON_ERROR_STOP on
\pset pager off

BEGIN;

CREATE FUNCTION pg_temp.assert_true(value boolean, message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'assertion failed: %', message;
  END IF;
END;
$$;

SELECT pg_temp.assert_true(
  has_function_privilege(
    'dhumi_operator',
    'app.publish_qualified_amazon_operation_v1(text,uuid,text,bytea,text,text,timestamptz)',
    'EXECUTE'
  )
  AND NOT has_table_privilege('dhumi_operator', 'app.service_templates', 'UPDATE')
  AND NOT has_table_privilege('dhumi_operator', 'app.provider_mappings', 'INSERT'),
  'operator must receive only the controlled publication function'
);

SET LOCAL ROLE dhumi_operator;

SELECT * FROM app.begin_amazon_scraper_catalog_import_v2(
  '7d000000-0000-4000-8000-000000000001',
  'test',
  'backend.release.proof',
  'restricted://backend-release/catalogue'
);

SELECT pg_temp.assert_true(
  app.complete_amazon_scraper_catalog_import(
    '7d000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'id', '7d000000-0000-4000-8000-000000000002',
      'ciphertext_hex', encode(decode(repeat('11', 40), 'hex'), 'hex'),
      'fingerprint_hex', encode(decode(repeat('22', 32), 'hex'), 'hex')
    )),
    'qualification/catalog-imports/7d000000-0000-4000-8000-000000000001/scrapers.json',
    decode(repeat('33', 32), 'hex'),
    'backend.release.proof'
  ) = 1,
  'one protected candidate must be imported'
);

SELECT pg_temp.assert_true(
  app.review_amazon_scraper_catalog_candidate(
    '7d000000-0000-4000-8000-000000000002',
    'approve',
    'backend.release.proof'
  ),
  'candidate review must be approved'
);

SELECT pg_temp.assert_true(
  app.begin_amazon_provider_qualification_v3(
    '7d000000-0000-4000-8000-000000000003',
    '7d000000-0000-4000-8000-000000000002',
    'amazon.products.collect_by_url',
    'test',
    'scrape',
    'qualification/operations/7d000000-0000-4000-8000-000000000003/request.json',
    decode(repeat('44', 32), 'hex'),
    'backend.release.proof'
  ),
  'qualification must pin the precise v2 contract'
);

SELECT pg_temp.assert_true(
  app.complete_amazon_provider_qualification(
    '7d000000-0000-4000-8000-000000000003',
    'succeeded',
    'inline',
    'qualification/operations/7d000000-0000-4000-8000-000000000003/response.json',
    decode(repeat('55', 32), 'hex'),
    'application/json',
    123,
    1,
    NULL::bytea,
    NULL::bytea,
    NULL::text,
    'backend.release.proof'
  ),
  'qualification evidence must complete'
);

DO $$
BEGIN
  BEGIN
    PERFORM * FROM app.publish_qualified_amazon_operation_v1(
      'test',
      '7d000000-0000-4000-8000-000000000003',
      'restricted://backend-release/products-v3',
      decode(repeat('66', 32), 'hex'),
      'backend.release.reviewer',
      'products-v3-evidence-approved',
      NULL
    );
    RAISE EXCEPTION 'pending qualification was published';
  EXCEPTION
    WHEN SQLSTATE '55000' THEN
      IF SQLERRM <> 'AMAZON_RELEASE_NOT_ACCEPTED' THEN
        RAISE;
      END IF;
  END;
END;
$$;

SELECT * FROM app.accept_amazon_provider_qualification_v3(
  '7d000000-0000-4000-8000-000000000003',
  '7d000000-0000-4000-8000-000000000004',
  decode(repeat('77', 40), 'hex'),
  decode(repeat('88', 32), 'hex'),
  '{
    "provider_submission":{"endpoint":"scrape"},
    "provider_request":{"mode":"collect","limit_per_input":null},
    "snapshot":{"enabled":true,"cancel_enabled":false,"multipart_enabled":false,"format":"json"},
    "normalizer_code":"amazon.products.collect-by-url.projected-array",
    "normalizer_version":2,
    "normalized_schema_version":"amazon.products.collect-by-url.output.v1"
  }'::jsonb,
  'pending-rate-card-v1',
  'amazon-products-collect-v2',
  'restricted://backend-release/qualification-accepted',
  decode(repeat('99', 32), 'hex'),
  'backend.release.reviewer',
  NULL
);

SELECT pg_temp.assert_true(
  release.release_outcome = 'published'
    AND release.operation_code = 'amazon.products.collect_by_url'
    AND release.template_slug = 'amazon-products-collect-by-url'
    AND release.template_version = 3
    AND release.environment = 'test',
  'first release must publish one provider-safe operation projection'
)
FROM app.publish_qualified_amazon_operation_v1(
  'test',
  '7d000000-0000-4000-8000-000000000003',
  'restricted://backend-release/products-v3',
  decode(repeat('66', 32), 'hex'),
  'backend.release.reviewer',
  'products-v3-evidence-approved',
  NULL
) AS release;

SELECT pg_temp.assert_true(
  release.release_outcome = 'replayed',
  'exact replay must be idempotent'
)
FROM app.publish_qualified_amazon_operation_v1(
  'test',
  '7d000000-0000-4000-8000-000000000003',
  'restricted://backend-release/products-v3',
  decode(repeat('66', 32), 'hex'),
  'backend.release.reviewer',
  'products-v3-evidence-approved',
  NULL
) AS release;

RESET ROLE;

SELECT pg_temp.assert_true(
  (SELECT count(*) = 1
   FROM app.service_templates AS template
   JOIN app.service_template_versions AS version
     ON version.id = template.current_public_version_id
   WHERE template.product_family = 'scraper_library'
     AND template.slug LIKE 'amazon-%'
     AND template.state = 'published'
     AND version.version = 3
     AND version.availability_state = 'available'
     AND version.published_at IS NOT NULL
     AND version.effective_at IS NOT NULL),
  'exactly one Amazon Template must be customer-release ready'
);

SELECT pg_temp.assert_true(
  (SELECT count(*) = 12
   FROM app.service_templates AS template
   WHERE template.product_family = 'scraper_library'
     AND template.slug LIKE 'amazon-%'
     AND template.state = 'draft'
     AND template.current_public_version_id IS NULL),
  'the other 12 Amazon operations must remain unpublished'
);

SELECT pg_temp.assert_true(
  (SELECT count(*) = 1
   FROM app.provider_mappings AS mapping
   JOIN app.service_template_versions AS version
     ON version.id = mapping.service_template_version_id
   WHERE mapping.operation_code = 'amazon.products.collect_by_url'
     AND mapping.environment = 'test'
     AND mapping.state = 'enabled'
     AND version.version = 3
     AND mapping.provider_resource_aad_mapping_id =
       '7d000000-0000-4000-8000-000000000004'),
  'publication must create one enabled release mapping that preserves encryption lineage'
);

SELECT pg_temp.assert_true(
  (SELECT state = 'disabled'
      AND provider_resource_aad_mapping_id = id
   FROM app.provider_mappings
   WHERE id = '7d000000-0000-4000-8000-000000000004'),
  'accepted qualification mapping must remain disabled and self-authenticated'
);

SELECT pg_temp.assert_true(
  (SELECT count(*) = 1
   FROM app.adapter_versions
   WHERE semantic_version = '1.1.0-pattern8-release'
     AND state = 'enabled')
  AND
  (SELECT count(*) = 1
   FROM app.adapter_versions
   WHERE semantic_version = '1.1.0-pattern8-output-contracts'
     AND state = 'disabled'),
  'release and qualification adapters must remain separate immutable records'
);

SELECT pg_temp.assert_true(
  (SELECT state = 'active' AND activated_at IS NOT NULL
   FROM app.provider_credentials
   WHERE id = (
     SELECT provider_credential_id
     FROM app.provider_qualification_attempts
     WHERE id = '7d000000-0000-4000-8000-000000000003'
   )),
  'release must activate the already-qualified credential'
);

SELECT pg_temp.assert_true(
  (SELECT state = 'enabled'
   FROM app.feature_flags
   WHERE feature_code = 'scraper_library' AND environment = 'test'),
  'release must enable the scraper-library admission feature'
);

SELECT pg_temp.assert_true(
  (SELECT count(*) = 1
   FROM app.audit_events
   WHERE action = 'provider.operation.publish'
     AND target_type = 'provider_qualification'
     AND target_id = '7d000000-0000-4000-8000-000000000003'),
  'publication must write exactly one immutable safe audit event'
);

SET LOCAL ROLE dhumi_customer_api;
SELECT set_config('app.tenant_id', '7d000000-0000-4000-8000-000000000099', true);

SELECT pg_temp.assert_true(
  (SELECT count(*) = 1
   FROM app.service_templates
   WHERE product_family = 'scraper_library' AND slug LIKE 'amazon-%'),
  'customer catalogue RLS must expose only the one published Amazon operation'
);

RESET ROLE;
\if :{?keep_fixture}
COMMIT;
\else
ROLLBACK;
\endif
