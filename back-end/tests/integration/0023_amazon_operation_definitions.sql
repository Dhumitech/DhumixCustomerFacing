-- Privileged, rollback-only proof for Pattern 6 migration 0032.
-- The migration itself stages permanent draft definitions; this proof changes
-- no data and makes no provider call.
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
    SELECT count(*) = 13
      AND count(DISTINCT template.slug) = 13
      AND count(DISTINCT version.presentation_metadata ->> 'display_priority') = 13
      AND bool_and(template.state = 'draft')
      AND bool_and(template.current_public_version_id IS NULL)
      AND bool_and(version.version = 1)
      AND bool_and(version.effective_at IS NULL)
      AND bool_and(version.published_at IS NULL)
      AND bool_and(version.availability_state = 'coming_soon')
      AND bool_and(evidence.state = 'pending')
      AND bool_and(adapter.state = 'disabled')
    FROM app.service_templates AS template
    JOIN app.service_template_versions AS version
      ON version.service_template_id = template.id
    JOIN app.launch_evidence AS evidence
      ON evidence.id = version.launch_evidence_id
    JOIN app.adapter_versions AS adapter
      ON adapter.id = version.adapter_version_id
    WHERE template.slug LIKE 'amazon-%'
  ),
  'all 13 Amazon definitions must be immutable draft/invisible/pending/disabled rows'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
      AND bool_and(version.state = 'disabled')
      AND bool_and(octet_length(version.code_artifact_digest) = 32)
      AND bool_and(jsonb_array_length(version.capability_metadata -> 'operation_codes') = 13)
    FROM app.adapter_definitions AS definition
    JOIN app.adapter_versions AS version
      ON version.adapter_definition_id = definition.id
    WHERE definition.code = 'bright_data.amazon.scraper_library'
  ),
  'one disabled shared adapter version must cover the 13 operation codes'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM app.provider_mappings AS mapping
    JOIN app.service_template_versions AS version
      ON version.id = mapping.service_template_version_id
    JOIN app.service_templates AS template
      ON template.id = version.service_template_id
    WHERE template.slug LIKE 'amazon-%'
  ),
  'Pattern 6 must not fabricate protected provider mappings'
);

SET LOCAL ROLE dhumi_customer_api;
SELECT set_config('app.tenant_id', '76000000-0000-4000-8000-000000000099', true);
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM app.service_templates
    WHERE slug LIKE 'amazon-%'
  ),
  'draft Amazon definitions must be invisible to the customer API role'
);
RESET ROLE;

SELECT pg_temp.assert_true(
  has_function_privilege(
    'dhumi_job_manager',
    'app.resolve_provider_normalization_plan(uuid,uuid,uuid,uuid)',
    'EXECUTE'
  )
  AND NOT has_table_privilege(
    'dhumi_job_manager', 'app.provider_credentials', 'SELECT'
  ),
  'Pattern 6 must reuse narrow Job Manager function access without credential SELECT'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname LIKE 'dhumi%amazon%'
       OR rolname LIKE 'dhumi%pattern6%'
  ),
  'Pattern 6 must create no database identity'
);

ROLLBACK;
