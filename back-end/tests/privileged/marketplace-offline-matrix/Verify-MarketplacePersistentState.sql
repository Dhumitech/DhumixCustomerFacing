-- M8 persistent-state verification.
--
-- This proof is intentionally non-mutating for app data. It validates the
-- installed migration and the customer-disabled Marketplace execution boundary
-- without replaying the M2-M8 lifecycle fixtures against a populated database.
\set ON_ERROR_STOP on

\if :{?expected_database}
\else
  \echo 'expected_database is required'
  \quit 3
\endif

BEGIN;
SET LOCAL row_security = off;

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
  current_database() = :'expected_database',
  'persistent proof connected to an unexpected database'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
    FROM app.schema_migrations
    WHERE version = '0053_marketplace_filter_execution_rls'
  ),
  'migration 0053 must be ledgered exactly once'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
      AND bool_and(adapter.state = 'disabled')
      AND bool_and(adapter.capability_metadata ->> 'provider_http_enabled' = 'false')
      AND bool_and(adapter.capability_metadata ->> 'can_execute' = 'false')
    FROM app.adapter_versions AS adapter
    JOIN app.adapter_definitions AS definition
      ON definition.id = adapter.adapter_definition_id
    WHERE definition.code = 'bright_data.marketplace.filter'
      AND adapter.semantic_version = '1.0.0-m7-fixture'
  ),
  'the M7 fixture adapter must remain uniquely disabled and provider-HTTP-off'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM app.provider_mappings AS mapping
    JOIN app.adapter_versions AS adapter ON adapter.id = mapping.adapter_version_id
    JOIN app.adapter_definitions AS definition
      ON definition.id = adapter.adapter_definition_id
    WHERE definition.code = 'bright_data.marketplace.filter'
      AND adapter.semantic_version = '1.0.0-m7-fixture'
  ),
  'the M7 fixture adapter must not have a provider mapping'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM app.service_template_versions AS version
    JOIN app.adapter_versions AS adapter ON adapter.id = version.adapter_version_id
    JOIN app.adapter_definitions AS definition
      ON definition.id = adapter.adapter_definition_id
    WHERE definition.code = 'bright_data.marketplace.filter'
      AND adapter.semantic_version = '1.0.0-m7-fixture'
  ),
  'the M7 fixture adapter must not be attached to a Template version'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM app.service_templates AS template
    JOIN app.service_template_versions AS version
      ON version.id = template.current_public_version_id
    JOIN app.adapter_versions AS adapter ON adapter.id = version.adapter_version_id
    JOIN app.adapter_definitions AS definition
      ON definition.id = adapter.adapter_definition_id
    WHERE definition.code = 'bright_data.marketplace.filter'
      AND adapter.semantic_version = '1.0.0-m7-fixture'
  ),
  'the M7 fixture adapter must not be reachable through a public Template pointer'
);

-- M2 may not have been imported into every persistent database. When the
-- LinkedIn Posts draft exists, its stored state must remain compatible with the
-- review-first, pre-purchase boundary. The clean proof validates its creation.
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM app.service_templates AS template
    WHERE template.slug = 'linkedin-posts'
      AND (
        template.product_family <> 'marketplace_dataset'
        OR template.state <> 'draft'
        OR template.current_public_version_id IS NOT NULL
      )
  ),
  'an existing LinkedIn Posts Template must remain an unpublished Marketplace draft'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM app.service_template_versions AS version
    JOIN app.service_templates AS template
      ON template.id = version.service_template_id
    WHERE template.slug = 'linkedin-posts'
      AND (
        version.availability_state <> 'coming_soon'
        OR version.effective_at IS NOT NULL
        OR version.published_at IS NOT NULL
      )
  ),
  'existing LinkedIn Posts versions must remain unpublished and coming-soon'
);

SELECT
  current_database() AS database,
  EXISTS (
    SELECT 1 FROM app.schema_migrations
    WHERE version = '0053_marketplace_filter_execution_rls'
  ) AS migration_0053_ledgered,
  adapter.state AS fixture_adapter_state,
  adapter.capability_metadata ->> 'provider_http_enabled' AS provider_http_enabled,
  (
    SELECT count(*) FROM app.provider_mappings AS mapping
    WHERE mapping.adapter_version_id = adapter.id
  ) AS provider_mapping_count,
  (
    SELECT count(*) FROM app.service_template_versions AS version
    WHERE version.adapter_version_id = adapter.id
  ) AS template_version_count,
  (
    SELECT count(*)
    FROM app.service_templates AS template
    JOIN app.service_template_versions AS version
      ON version.id = template.current_public_version_id
    WHERE version.adapter_version_id = adapter.id
  ) AS public_pointer_count
FROM app.adapter_versions AS adapter
JOIN app.adapter_definitions AS definition
  ON definition.id = adapter.adapter_definition_id
WHERE definition.code = 'bright_data.marketplace.filter'
  AND adapter.semantic_version = '1.0.0-m7-fixture';

ROLLBACK;
