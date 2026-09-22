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

SELECT pg_temp.assert_true(
  to_regprocedure('app.begin_amazon_scraper_catalog_import(uuid,text,text,text)') IS NOT NULL,
  'Pattern 7 import function must exist'
);
SELECT pg_temp.assert_true(
  to_regprocedure('app.resolve_amazon_qualification_acceptance_plan_v2(uuid)') IS NOT NULL,
  'Pattern 7 endpoint-bound acceptance plan must exist'
);
SELECT pg_temp.assert_true(
  NOT has_function_privilege(
    'dhumi_operator',
    'app.begin_amazon_provider_qualification(uuid,uuid,text,text,text,bytea,text)',
    'EXECUTE'
  ),
  'operator must not execute the endpoint-unbound qualification function'
);
SELECT pg_temp.assert_true(
  NOT has_table_privilege('dhumi_operator', 'app.provider_qualification_attempts', 'SELECT'),
  'operator must not receive direct qualification-table SELECT'
);
SELECT pg_temp.assert_true(
  NOT has_table_privilege('dhumi_operator', 'app.provider_mappings', 'INSERT'),
  'operator must not receive direct mapping INSERT'
);
SELECT pg_temp.assert_true(
  NOT has_table_privilege('dhumi_operator', 'app.audit_events', 'INSERT'),
  'operator must not receive direct audit INSERT'
);
SELECT pg_temp.assert_true(
  NOT has_table_privilege('dhumi_operator', 'app.service_template_versions', 'SELECT'),
  'operator must not receive direct draft Template-version SELECT'
);
SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'app'
      AND tablename = 'audit_events'
      AND policyname = 'audit_events_amazon_qualification_definer_insert'
      AND roles = ARRAY['dhumi_owner']::name[]
      AND cmd = 'INSERT'
      AND with_check LIKE '%provider.qualification.accept%'
      AND with_check LIKE '%tenant_id IS NULL%'
  ),
  'qualification audit policy must be owner-only and tenantless'
);
SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'app'
      AND tablename = 'service_template_versions'
      AND policyname = 'service_template_versions_amazon_qualification_definer_select'
      AND roles = ARRAY['dhumi_owner']::name[]
      AND cmd = 'SELECT'
      AND qual LIKE '%bright_data.amazon.scraper_library%'
      AND qual LIKE '%coming_soon%'
      AND qual LIKE '%pending%'
  ),
  'qualification Template policy must expose only staged Amazon definitions to the owner'
);

SET LOCAL ROLE dhumi_operator;

SELECT * FROM app.begin_amazon_scraper_catalog_import(
  '72000000-0000-4000-8000-000000000001',
  'test',
  'pattern7.database.test',
  'restricted://pattern7/database/discovery'
);

SELECT pg_temp.assert_true(
  app.complete_amazon_scraper_catalog_import(
    '72000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'id', '72000000-0000-4000-8000-000000000002',
      'ciphertext_hex', encode(decode(repeat('11', 40), 'hex'), 'hex'),
      'fingerprint_hex', encode(decode(repeat('22', 32), 'hex'), 'hex')
    )),
    'qualification/catalog-imports/72000000-0000-4000-8000-000000000001/scrapers.json',
    decode(repeat('33', 32), 'hex'),
    'pattern7.database.test'
  ) = 1,
  'one protected candidate must be recorded'
);

SELECT pg_temp.assert_true(
  app.review_amazon_scraper_catalog_candidate(
    '72000000-0000-4000-8000-000000000002',
    'approve',
    'pattern7.database.test'
  ),
  'candidate review must succeed'
);

SELECT pg_temp.assert_true(
  app.begin_amazon_provider_qualification_v2(
    '72000000-0000-4000-8000-000000000003',
    '72000000-0000-4000-8000-000000000002',
    'amazon.products.collect_by_url',
    'test',
    'scrape',
    'qualification/operations/72000000-0000-4000-8000-000000000003/request.json',
    decode(repeat('44', 32), 'hex'),
    'pattern7.database.test'
  ),
  'qualification attempt must begin only for an approved candidate'
);

SELECT pg_temp.assert_true(
  app.complete_amazon_provider_qualification(
    '72000000-0000-4000-8000-000000000003',
    'succeeded',
    'inline',
    'qualification/operations/72000000-0000-4000-8000-000000000003/response.json',
    decode(repeat('55', 32), 'hex'),
    'application/json',
    123,
    1,
    NULL::bytea,
    NULL::bytea,
    NULL::text,
    'pattern7.database.test'
  ),
  'qualification evidence must complete'
);

SELECT * FROM app.resolve_amazon_qualification_acceptance_plan_v2(
  '72000000-0000-4000-8000-000000000003'
);

DO $$
BEGIN
  BEGIN
    PERFORM * FROM app.accept_amazon_provider_qualification_v2(
      '72000000-0000-4000-8000-000000000003',
      '72000000-0000-4000-8000-000000000005',
      decode(repeat('66', 40), 'hex'),
      decode(repeat('77', 32), 'hex'),
      '{
        "provider_submission":{"endpoint":"trigger"},
        "provider_request":{"mode":"collect","limit_per_input":null},
        "snapshot":{"enabled":true,"cancel_enabled":false,"multipart_enabled":false,"format":"json"},
        "normalizer_code":"amazon-product-observed-array",
        "normalizer_version":1,
        "normalized_schema_version":"amazon-product-observed-0.1"
      }'::jsonb,
      'pending-rate-card-v1',
      'amazon-products-collect-v1',
      'restricted://pattern7/database/qualification',
      decode(repeat('88', 32), 'hex'),
      'pattern7.database.reviewer',
      NULL
    );
    RAISE EXCEPTION 'execution-mode mismatch was accepted';
  EXCEPTION
    WHEN SQLSTATE '22023' THEN
      IF SQLERRM <> 'QUALIFICATION_EXECUTION_MODE_MISMATCH' THEN
        RAISE;
      END IF;
  END;
END;
$$;

SELECT * FROM app.accept_amazon_provider_qualification_v2(
  '72000000-0000-4000-8000-000000000003',
  '72000000-0000-4000-8000-000000000004',
  decode(repeat('66', 40), 'hex'),
  decode(repeat('77', 32), 'hex'),
  '{
    "provider_submission":{"endpoint":"scrape"},
    "provider_request":{"mode":"collect","limit_per_input":null},
    "snapshot":{"enabled":true,"cancel_enabled":false,"multipart_enabled":false,"format":"json"},
    "normalizer_code":"amazon-product-observed-array",
    "normalizer_version":1,
    "normalized_schema_version":"amazon-product-observed-0.1"
  }'::jsonb,
  'pending-rate-card-v1',
  'amazon-products-collect-v1',
  'restricted://pattern7/database/qualification',
  decode(repeat('88', 32), 'hex'),
  'pattern7.database.reviewer',
  NULL
);

RESET ROLE;

SELECT pg_temp.assert_true(
  (SELECT state = 'completed' AND candidate_count = 1
   FROM app.catalog_imports
   WHERE id = '72000000-0000-4000-8000-000000000001'),
  'catalog import must remain completed'
);
SELECT pg_temp.assert_true(
  (SELECT review_state = 'approved'
   FROM app.catalog_candidates
   WHERE id = '72000000-0000-4000-8000-000000000002'),
  'candidate must be explicitly approved'
);
SELECT pg_temp.assert_true(
  (SELECT state = 'succeeded' AND review_state = 'approved'
      AND provider_execution_mode = 'scrape'
      AND provider_mapping_id = '72000000-0000-4000-8000-000000000004'
   FROM app.provider_qualification_attempts
   WHERE id = '72000000-0000-4000-8000-000000000003'),
  'qualification must pin its accepted mapping'
);
SELECT pg_temp.assert_true(
  (SELECT state = 'disabled'
      AND operation_code = 'amazon.products.collect_by_url'
      AND output_policy #>> '{provider_submission,endpoint}' = 'scrape'
   FROM app.provider_mappings
   WHERE id = '72000000-0000-4000-8000-000000000004'),
  'accepted mapping must remain disabled'
);
SELECT pg_temp.assert_true(
  (SELECT evidence.state = 'approved'
   FROM app.provider_mappings AS mapping
   JOIN app.launch_evidence AS evidence ON evidence.id = mapping.launch_evidence_id
   WHERE mapping.id = '72000000-0000-4000-8000-000000000004'),
  'mapping launch evidence must be approved'
);
SELECT pg_temp.assert_true(
  (SELECT template.state = 'draft'
      AND template.current_public_version_id IS NULL
      AND version.availability_state = 'coming_soon'
   FROM app.provider_mappings AS mapping
   JOIN app.service_template_versions AS version
     ON version.id = mapping.service_template_version_id
   JOIN app.service_templates AS template
     ON template.id = version.service_template_id
   WHERE mapping.id = '72000000-0000-4000-8000-000000000004'),
  'Pattern 7 must not publish a Template'
);
SELECT pg_temp.assert_true(
  (SELECT version.state = 'disabled'
   FROM app.provider_mappings AS mapping
   JOIN app.adapter_versions AS version ON version.id = mapping.adapter_version_id
   WHERE mapping.id = '72000000-0000-4000-8000-000000000004'),
  'Pattern 7 must not enable the adapter'
);
SELECT pg_temp.assert_true(
  (SELECT credential.state = 'inactive'
   FROM app.provider_mappings AS mapping
   JOIN app.provider_credentials AS credential
     ON credential.id = mapping.provider_credential_id
   WHERE mapping.id = '72000000-0000-4000-8000-000000000004'),
  'Pattern 7 must not activate the credential'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 6
   FROM app.audit_events
   WHERE target_id IN (
     '72000000-0000-4000-8000-000000000001',
     '72000000-0000-4000-8000-000000000002',
     '72000000-0000-4000-8000-000000000003'
   )
     AND tenant_id IS NULL
     AND action IN (
       'provider.catalog_import.begin',
       'provider.catalog_import.complete',
       'provider.catalog_candidate.review',
       'provider.qualification.begin',
       'provider.qualification.complete',
       'provider.qualification.accept'
     )),
  'Pattern 7 must record its tenantless audit trail'
);

ROLLBACK;
