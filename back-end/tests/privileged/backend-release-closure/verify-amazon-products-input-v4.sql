\set ON_ERROR_STOP on
\pset pager off

BEGIN TRANSACTION READ ONLY;

SELECT set_config(
  'dhumi.verify.amazon_products_v4_expected_published',
  :'expected_published',
  true
);

DO $verify$
DECLARE
  expected_published boolean := current_setting(
    'dhumi.verify.amazon_products_v4_expected_published'
  )::boolean;
  migration_count bigint;
  template_count bigint;
  current_version integer;
  strict_schema boolean;
  protected_mapping_count bigint;
  publication_audit_count bigint;
BEGIN
  SELECT count(*)
  INTO migration_count
  FROM app.schema_migrations
  WHERE version = '0043_amazon_products_input_contract_v4';

  IF migration_count <> 1 THEN
    RAISE EXCEPTION 'V4_MIGRATION_NOT_LEDGERED';
  END IF;

  SELECT count(*), max(version.version)
  INTO template_count, current_version
  FROM app.service_templates AS template
  LEFT JOIN app.service_template_versions AS version
    ON version.id = template.current_public_version_id
  WHERE template.slug = 'amazon-products-collect-by-url'
    AND template.product_family = 'scraper_library'
    AND template.state = 'published';

  IF expected_published AND (template_count <> 1 OR current_version <> 4) THEN
    RAISE EXCEPTION 'V4_PUBLIC_POINTER_NOT_ACTIVE';
  END IF;

  IF NOT expected_published AND current_version = 4 THEN
    RAISE EXCEPTION 'V4_UNEXPECTEDLY_PUBLISHED';
  END IF;

  IF expected_published THEN
    SELECT
      version.input_schema #>> '{properties,targets,minItems}' = '1'
      AND version.input_schema #>> '{properties,targets,maxItems}' = '20'
      AND version.input_schema #>>
        '{properties,targets,items,properties,zipcode,pattern}' = '^[0-9]{5}$'
      AND version.input_schema #>
        '{properties,targets,items,properties,language,enum}' = '["EN"]'::jsonb
      AND version.input_schema #>>
        '{properties,targets,items,additionalProperties}' = 'false'
      AND version.input_schema #>> '{additionalProperties}' = 'false'
    INTO strict_schema
    FROM app.service_templates AS template
    JOIN app.service_template_versions AS version
      ON version.id = template.current_public_version_id
    WHERE template.slug = 'amazon-products-collect-by-url';

    IF strict_schema IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'V4_SCHEMA_MISMATCH';
    END IF;

    SELECT count(*)
    INTO protected_mapping_count
    FROM app.provider_mappings AS v4_mapping
    JOIN app.service_template_versions AS v4_version
      ON v4_version.id = v4_mapping.service_template_version_id
    JOIN app.service_templates AS template
      ON template.id = v4_version.service_template_id
    JOIN app.provider_mappings AS v3_mapping
      ON v3_mapping.operation_code = v4_mapping.operation_code
     AND v3_mapping.environment = v4_mapping.environment
     AND v3_mapping.state = 'enabled'
    JOIN app.service_template_versions AS v3_version
      ON v3_version.id = v3_mapping.service_template_version_id
     AND v3_version.service_template_id = v4_version.service_template_id
    WHERE template.slug = 'amazon-products-collect-by-url'
      AND v4_version.version = 4
      AND v3_version.version = 3
      AND v4_mapping.state = 'enabled'
      AND v4_mapping.provider_resource_ciphertext =
        v3_mapping.provider_resource_ciphertext
      AND v4_mapping.provider_resource_fingerprint =
        v3_mapping.provider_resource_fingerprint
      AND v4_mapping.provider_resource_aad_mapping_id =
        v3_mapping.provider_resource_aad_mapping_id;

    IF protected_mapping_count <> 1 THEN
      RAISE EXCEPTION 'V4_PROTECTED_MAPPING_LINEAGE_MISMATCH';
    END IF;

    SELECT count(*)
    INTO publication_audit_count
    FROM app.audit_events AS audit
    JOIN app.service_template_versions AS version ON version.id = audit.target_id
    JOIN app.service_templates AS template ON template.id = version.service_template_id
    WHERE audit.action = 'provider.operation.input_contract.publish'
      AND audit.target_type = 'service_template_version'
      AND audit.outcome = 'published'
      AND template.slug = 'amazon-products-collect-by-url'
      AND version.version = 4;

    IF publication_audit_count <> 1 THEN
      RAISE EXCEPTION 'V4_PUBLICATION_AUDIT_MISMATCH';
    END IF;
  END IF;
END
$verify$;

SELECT
  current_database() AS database,
  EXISTS (
    SELECT 1
    FROM app.schema_migrations
    WHERE version = '0043_amazon_products_input_contract_v4'
  ) AS migration_0043_ledgered,
  COALESCE((
    SELECT version.version
    FROM app.service_templates AS template
    JOIN app.service_template_versions AS version
      ON version.id = template.current_public_version_id
    WHERE template.slug = 'amazon-products-collect-by-url'
  ), 0) AS current_public_version,
  (
    SELECT count(*)
    FROM app.services AS service
    JOIN app.service_versions AS service_version
      ON service_version.service_id = service.id
     AND service_version.version = service.current_version
    JOIN app.service_template_versions AS template_version
      ON template_version.id = service_version.service_template_version_id
    JOIN app.service_templates AS template
      ON template.id = template_version.service_template_id
    WHERE template.slug = 'amazon-products-collect-by-url'
      AND template_version.version = 3
  ) AS services_pinned_v3,
  (
    SELECT count(*)
    FROM app.services AS service
    JOIN app.service_versions AS service_version
      ON service_version.service_id = service.id
     AND service_version.version = service.current_version
    JOIN app.service_template_versions AS template_version
      ON template_version.id = service_version.service_template_version_id
    JOIN app.service_templates AS template
      ON template.id = template_version.service_template_id
    WHERE template.slug = 'amazon-products-collect-by-url'
      AND template_version.version = 4
  ) AS services_pinned_v4,
  :'expected_published'::boolean AS expected_published;

ROLLBACK;
