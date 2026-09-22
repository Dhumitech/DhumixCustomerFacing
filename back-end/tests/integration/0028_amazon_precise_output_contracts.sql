-- Privileged, rollback-only proof for Pattern 8 Priority 4 migration 0040.
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
  (SELECT count(*) = 13
   FROM app.service_template_versions AS version
   JOIN app.adapter_versions AS adapter ON adapter.id = version.adapter_version_id
   WHERE version.version = 2
     AND adapter.semantic_version = '1.1.0-pattern8-output-contracts'),
  'all 13 Amazon operations must have immutable v2 draft rows'
);

SELECT pg_temp.assert_true(
  (SELECT count(*) = 13
   FROM app.service_templates AS template
   JOIN app.service_template_versions AS version
     ON version.service_template_id = template.id
   JOIN app.adapter_versions AS adapter
     ON adapter.id = version.adapter_version_id
   WHERE adapter.semantic_version = '1.1.0-pattern8-output-contracts'
     AND template.product_family = 'scraper_library'
     AND template.state = 'draft'
     AND template.current_public_version_id IS NULL),
  'Priority 4 must not publish or select a public Amazon version'
);

SELECT pg_temp.assert_true(
  (SELECT count(*) = 4
   FROM app.adapter_versions AS adapter
   CROSS JOIN LATERAL jsonb_each(adapter.capability_metadata -> 'output_contracts') AS contract
   WHERE adapter.semantic_version = '1.1.0-pattern8-output-contracts'
     AND contract.value ->> 'state' = 'precise'),
  'exactly four evidence-backed contracts must be precise'
);

SELECT pg_temp.assert_true(
  (SELECT count(*) = 9
   FROM app.adapter_versions AS adapter
   CROSS JOIN LATERAL jsonb_each(adapter.capability_metadata -> 'output_contracts') AS contract
   WHERE adapter.semantic_version = '1.1.0-pattern8-output-contracts'
     AND contract.value ->> 'state' = 'unavailable'),
  'the nine unproved operation contracts must remain unavailable'
);

SELECT pg_temp.assert_true(
  NOT has_function_privilege(
    'dhumi_operator',
    'app.begin_amazon_scraper_catalog_import(uuid,text,text,text)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'dhumi_operator',
    'app.begin_amazon_provider_qualification_v2(uuid,uuid,text,text,text,text,bytea,text)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'dhumi_operator',
    'app.accept_amazon_provider_qualification_v2(uuid,uuid,bytea,bytea,jsonb,text,text,text,bytea,text,timestamptz)',
    'EXECUTE'
  ),
  'operator must not execute the historical generic-contract path'
);

SELECT pg_temp.assert_true(
  has_function_privilege(
    'dhumi_operator',
    'app.begin_amazon_scraper_catalog_import_v2(uuid,text,text,text)',
    'EXECUTE'
  )
  AND has_function_privilege(
    'dhumi_operator',
    'app.begin_amazon_provider_qualification_v3(uuid,uuid,text,text,text,text,bytea,text)',
    'EXECUTE'
  )
  AND has_function_privilege(
    'dhumi_operator',
    'app.accept_amazon_provider_qualification_v3(uuid,uuid,bytea,bytea,jsonb,text,text,text,bytea,text,timestamptz)',
    'EXECUTE'
  ),
  'operator must execute only the output-contract-versioned path'
);

SET LOCAL ROLE dhumi_operator;

SELECT * FROM app.begin_amazon_scraper_catalog_import_v2(
  '7c000000-0000-4000-8000-000000000001',
  'test',
  'pattern8.output.contract.proof',
  'restricted://pattern8/output-contracts/import'
);

SELECT pg_temp.assert_true(
  app.complete_amazon_scraper_catalog_import(
    '7c000000-0000-4000-8000-000000000001',
    jsonb_build_array(
      jsonb_build_object(
        'id', '7c000000-0000-4000-8000-000000000002',
        'ciphertext_hex', encode(decode(repeat('11', 40), 'hex'), 'hex'),
        'fingerprint_hex', encode(decode(repeat('22', 32), 'hex'), 'hex')
      ),
      jsonb_build_object(
        'id', '7c000000-0000-4000-8000-000000000003',
        'ciphertext_hex', encode(decode(repeat('33', 40), 'hex'), 'hex'),
        'fingerprint_hex', encode(decode(repeat('44', 32), 'hex'), 'hex')
      )
    ),
    'qualification/catalog-imports/7c000000-0000-4000-8000-000000000001/scrapers.json',
    decode(repeat('55', 32), 'hex'),
    'pattern8.output.contract.proof'
  ) = 2,
  'two protected candidates must be recorded'
);

SELECT pg_temp.assert_true(
  app.review_amazon_scraper_catalog_candidate(
    '7c000000-0000-4000-8000-000000000002', 'approve',
    'pattern8.output.contract.proof'
  ),
  'supported candidate approval must succeed'
);
SELECT pg_temp.assert_true(
  app.review_amazon_scraper_catalog_candidate(
    '7c000000-0000-4000-8000-000000000003', 'approve',
    'pattern8.output.contract.proof'
  ),
  'unsupported candidate approval must succeed for evidence collection'
);

SELECT pg_temp.assert_true(
  app.begin_amazon_provider_qualification_v3(
    '7c000000-0000-4000-8000-000000000004',
    '7c000000-0000-4000-8000-000000000002',
    'amazon.products.collect_by_url',
    'test', 'scrape',
    'qualification/operations/7c000000-0000-4000-8000-000000000004/request.json',
    decode(repeat('66', 32), 'hex'),
    'pattern8.output.contract.proof'
  ),
  'supported qualification must pin the v2 contract row'
);

SELECT pg_temp.assert_true(
  app.complete_amazon_provider_qualification(
    '7c000000-0000-4000-8000-000000000004',
    'succeeded', 'inline',
    'qualification/operations/7c000000-0000-4000-8000-000000000004/response.json',
    decode(repeat('77', 32), 'hex'), 'application/json', 123, 1,
    NULL::bytea, NULL::bytea, NULL::text,
    'pattern8.output.contract.proof'
  ),
  'supported qualification evidence must complete'
);

SELECT * FROM app.resolve_amazon_qualification_acceptance_plan_v3(
  '7c000000-0000-4000-8000-000000000004'
);

DO $$
BEGIN
  BEGIN
    PERFORM * FROM app.accept_amazon_provider_qualification_v3(
      '7c000000-0000-4000-8000-000000000004',
      '7c000000-0000-4000-8000-000000000005',
      decode(repeat('88', 40), 'hex'), decode(repeat('99', 32), 'hex'),
      '{
        "provider_submission":{"endpoint":"scrape"},
        "provider_request":{"mode":"collect","limit_per_input":null},
        "snapshot":{"enabled":true,"cancel_enabled":false,"multipart_enabled":false,"format":"json"},
        "normalizer_code":"generic-array",
        "normalizer_version":1,
        "normalized_schema_version":"generic-array.v1"
      }'::jsonb,
      'pending-rate-card-v1', 'amazon-products-collect-v2',
      'restricted://pattern8/output-contracts/mismatch',
      decode(repeat('aa', 32), 'hex'), 'pattern8.output.reviewer', NULL
    );
    RAISE EXCEPTION 'mismatched output contract was accepted';
  EXCEPTION
    WHEN SQLSTATE '22023' THEN
      IF SQLERRM <> 'QUALIFICATION_OUTPUT_CONTRACT_MISMATCH' THEN
        RAISE;
      END IF;
  END;
END;
$$;

SELECT * FROM app.accept_amazon_provider_qualification_v3(
  '7c000000-0000-4000-8000-000000000004',
  '7c000000-0000-4000-8000-000000000006',
  decode(repeat('bb', 40), 'hex'), decode(repeat('cc', 32), 'hex'),
  '{
    "provider_submission":{"endpoint":"scrape"},
    "provider_request":{"mode":"collect","limit_per_input":null},
    "snapshot":{"enabled":true,"cancel_enabled":false,"multipart_enabled":false,"format":"json"},
    "normalizer_code":"amazon.products.collect-by-url.projected-array",
    "normalizer_version":2,
    "normalized_schema_version":"amazon.products.collect-by-url.output.v1"
  }'::jsonb,
  'pending-rate-card-v1', 'amazon-products-collect-v2',
  'restricted://pattern8/output-contracts/accepted',
  decode(repeat('dd', 32), 'hex'), 'pattern8.output.reviewer', NULL
);

SELECT pg_temp.assert_true(
  app.begin_amazon_provider_qualification_v3(
    '7c000000-0000-4000-8000-000000000007',
    '7c000000-0000-4000-8000-000000000003',
    'amazon.sellers.collect_by_url',
    'test', 'scrape',
    'qualification/operations/7c000000-0000-4000-8000-000000000007/request.json',
    decode(repeat('ee', 32), 'hex'),
    'pattern8.output.contract.proof'
  ),
  'unavailable operation must remain qualifiable for evidence collection'
);

SELECT pg_temp.assert_true(
  app.complete_amazon_provider_qualification(
    '7c000000-0000-4000-8000-000000000007',
    'succeeded', 'inline',
    'qualification/operations/7c000000-0000-4000-8000-000000000007/response.json',
    decode(repeat('ff', 32), 'hex'), 'application/json', 2, 0,
    NULL::bytea, NULL::bytea, NULL::text,
    'pattern8.output.contract.proof'
  ),
  'unavailable operation evidence may be retained'
);

DO $$
BEGIN
  BEGIN
    PERFORM * FROM app.resolve_amazon_qualification_acceptance_plan_v3(
      '7c000000-0000-4000-8000-000000000007'
    );
    RAISE EXCEPTION 'unavailable output contract exposed an acceptance plan';
  EXCEPTION
    WHEN SQLSTATE 'P0002' THEN
      IF SQLERRM <> 'QUALIFICATION_ACCEPTANCE_PLAN_NOT_AVAILABLE' THEN
        RAISE;
      END IF;
  END;
END;
$$;

RESET ROLE;

SELECT pg_temp.assert_true(
  (SELECT state = 'disabled'
      AND service_template_version_id = (
        SELECT id FROM app.service_template_versions
        WHERE service_template_id = (
          SELECT id FROM app.service_templates
          WHERE slug = 'amazon-products-collect-by-url'
        ) AND version = 2
      )
      AND output_policy ->> 'normalizer_code' =
        'amazon.products.collect-by-url.projected-array'
      AND output_policy ->> 'normalized_schema_version' =
        'amazon.products.collect-by-url.output.v1'
   FROM app.provider_mappings
   WHERE id = '7c000000-0000-4000-8000-000000000006'),
  'accepted exact mapping must remain disabled and pinned to Template v2'
);

ROLLBACK;
