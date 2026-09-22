-- Disposable-cluster, rollback-only proof. The manifest is synthetic and
-- cannot qualify or publish a real scraper.
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.assert_true(value boolean, message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'assertion failed: %', message; END IF; END; $$;
CREATE FUNCTION pg_temp.synthetic_scraper_manifest() RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'operationCode','synthetic.products.collect_by_url',
    'slug','synthetic-products-collect-by-url',
    'publicName','Synthetic products',
    'publicDescription','Synthetic offline draft; not a provider offer.',
    'availabilityCopy','Qualification pending',
    'contractHash',repeat('a',64),
    'packageSha256',repeat('b',64),
    'configurationSchema','{"type":"object","additionalProperties":false,"properties":{}}'::jsonb,
    'inputSchema','{"type":"object","additionalProperties":false,"required":["targets"],"properties":{"targets":{"type":"array","minItems":1,"maxItems":1,"items":{"type":"object","additionalProperties":false,"required":["url"],"properties":{"url":{"type":"string"}}}}}}'::jsonb,
    'outputSchema','{"type":"array","items":{"type":"object","additionalProperties":false,"required":["url"],"properties":{"url":{"type":"string"}}}}'::jsonb,
    'presentationMetadata','{"domain_slug":"synthetic-com","domain_name":"Synthetic","category":"e-commerce","icon_key":"synthetic","operation_group":"Products","operation_name":"Collect by URL","display_priority":100}'::jsonb,
    'processing','{"version":1,"revision":1}'::jsonb
  );
$$;

SELECT pg_temp.assert_true(
  has_function_privilege('dhumi_operator','app.stage_shared_scraper_operation_v1(jsonb,text,text,text)','EXECUTE')
  AND NOT has_function_privilege('dhumi_customer_api','app.stage_shared_scraper_operation_v1(jsonb,text,text,text)','EXECUTE')
  AND NOT has_table_privilege('dhumi_operator','app.service_templates','INSERT')
  AND NOT has_table_privilege('dhumi_operator','app.service_template_versions','INSERT'),
  'operator has only the guarded function; customer has none');

SET LOCAL ROLE dhumi_customer_api;
DO $$ BEGIN
  BEGIN
    PERFORM * FROM app.stage_shared_scraper_operation_v1(
      pg_temp.synthetic_scraper_manifest(),'checkpoint://synthetic/offline','offline.operator',current_database());
    RAISE EXCEPTION 'customer staged a scraper draft';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END; $$;
RESET ROLE;

SET LOCAL ROLE dhumi_operator;
SELECT pg_temp.assert_true((SELECT count(*)=1 AND bool_and(disposition='created')
  FROM app.stage_shared_scraper_operation_v1(
    pg_temp.synthetic_scraper_manifest(),'checkpoint://synthetic/offline','offline.operator',current_database())),
  'first stage creates one private draft');
SELECT pg_temp.assert_true((SELECT count(*)=1 AND bool_and(disposition='replayed')
  FROM app.stage_shared_scraper_operation_v1(
    pg_temp.synthetic_scraper_manifest(),'checkpoint://synthetic/offline','offline.operator',current_database())),
  'exact replay is idempotent');
DO $$ BEGIN
  BEGIN
    PERFORM * FROM app.stage_shared_scraper_operation_v1(
      jsonb_set(pg_temp.synthetic_scraper_manifest(),'{publicName}','"Changed name"'::jsonb),
      'checkpoint://synthetic/offline','offline.operator',current_database());
    RAISE EXCEPTION 'changed package replay was accepted';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN
    PERFORM * FROM app.stage_shared_scraper_operation_v1(
      pg_temp.synthetic_scraper_manifest(),'checkpoint://synthetic/offline','offline.operator','wrong_database');
    RAISE EXCEPTION 'wrong database was accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
END; $$;
RESET ROLE;

SELECT pg_temp.assert_true((SELECT count(*)=1 AND bool_and(state='draft' AND current_public_version_id IS NULL)
  FROM app.service_templates WHERE slug='synthetic-products-collect-by-url'), 'one non-public draft Template');
SELECT pg_temp.assert_true((SELECT count(*)=1 AND bool_and(version=1 AND availability_state='coming_soon'
    AND published_at IS NULL AND effective_at IS NULL)
  FROM app.service_template_versions AS version JOIN app.service_templates AS template
    ON template.id=version.service_template_id WHERE template.slug='synthetic-products-collect-by-url'),
  'one immutable unpublished Template version');
SELECT pg_temp.assert_true((SELECT count(*)=1 AND bool_and(state='pending' AND evidence_hash=decode(repeat('b',64),'hex'))
  FROM app.launch_evidence WHERE evidence_code='shared_scraper.template.synthetic.products.collect_by_url.v1'),
  'package checksum is stored as pending evidence');
SELECT pg_temp.assert_true((SELECT count(*)=0 FROM app.provider_mappings AS mapping
  JOIN app.service_template_versions AS version ON version.id=mapping.service_template_version_id
  JOIN app.service_templates AS template ON template.id=version.service_template_id
  WHERE template.slug='synthetic-products-collect-by-url'), 'no provider mapping or execution authority');
SELECT pg_temp.assert_true((SELECT count(*)=1 FROM app.audit_events WHERE action='scraper.operation.stage'
  AND safe_diff->>'operation_code'='synthetic.products.collect_by_url'), 'one stage audit, no duplicate replay audit');

SET LOCAL ROLE dhumi_customer_api;
SELECT set_config('app.tenant_id','76010000-0000-4000-8000-000000000001',true);
SELECT pg_temp.assert_true((SELECT count(*)=0 FROM app.service_templates
  WHERE slug='synthetic-products-collect-by-url'), 'draft invisible to customer capability');
RESET ROLE;
ROLLBACK;
\echo 'Generic scraper draft registration/RLS/replay proof passed. Provider calls: 0.'
