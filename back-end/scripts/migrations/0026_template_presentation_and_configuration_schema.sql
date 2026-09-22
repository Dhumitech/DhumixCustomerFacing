-- Public card metadata and distinct saved-Service/per-Run schemas.
--
-- This migration does not publish an Amazon Template, expose provider fields,
-- call Bright Data, or modify migrations 0001-0025. Existing immutable rows
-- are backfilled only while their immutability trigger is disabled inside the
-- migration runner's single transaction.

SET ROLE dhumi_owner;

ALTER TABLE app.service_template_versions
  ADD COLUMN configuration_schema jsonb,
  ADD COLUMN presentation_metadata jsonb;

ALTER TABLE app.service_template_versions
  DISABLE TRIGGER service_template_versions_immutable;

UPDATE app.service_template_versions AS version
SET
  configuration_schema = version.input_schema,
  presentation_metadata = jsonb_build_object(
    'domain_slug',
      CASE template.product_family
        WHEN 'scraper_library' THEN 'scraper-library'
        ELSE 'marketplace-datasets'
      END,
    'domain_name',
      CASE template.product_family
        WHEN 'scraper_library' THEN 'Scraper Library'
        ELSE 'Marketplace Datasets'
      END,
    'category',
      CASE template.product_family
        WHEN 'scraper_library' THEN 'web-data'
        ELSE 'datasets'
      END,
    'icon_key',
      CASE template.product_family
        WHEN 'scraper_library' THEN 'scraper-library'
        ELSE 'marketplace-datasets'
      END,
    'operation_group',
      left(
        CASE
          WHEN btrim(version.public_name) = '' THEN 'Service'
          ELSE version.public_name
        END,
        120
      ),
    'operation_name', 'Run',
    'display_priority',
      CASE template.product_family
        WHEN 'scraper_library' THEN 100
        ELSE 200
      END
  )
FROM app.service_templates AS template
WHERE template.id = version.service_template_id;

ALTER TABLE app.service_template_versions
  ENABLE TRIGGER service_template_versions_immutable;

ALTER TABLE app.service_template_versions
  ALTER COLUMN configuration_schema SET NOT NULL,
  ALTER COLUMN presentation_metadata SET NOT NULL,
  ADD CONSTRAINT service_template_versions_configuration_schema_object_check
    CHECK (jsonb_typeof(configuration_schema) = 'object'),
  ADD CONSTRAINT service_template_versions_presentation_object_check
    CHECK (
      jsonb_typeof(presentation_metadata) = 'object'
      AND presentation_metadata - ARRAY[
        'domain_slug',
        'domain_name',
        'category',
        'icon_key',
        'operation_group',
        'operation_name',
        'display_priority'
      ] = '{}'::jsonb
      AND presentation_metadata ?& ARRAY[
        'domain_slug',
        'domain_name',
        'category',
        'icon_key',
        'operation_group',
        'operation_name',
        'display_priority'
      ]
      AND jsonb_typeof(presentation_metadata -> 'domain_slug') = 'string'
      AND (presentation_metadata ->> 'domain_slug')
        ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
      AND jsonb_typeof(presentation_metadata -> 'domain_name') = 'string'
      AND char_length(presentation_metadata ->> 'domain_name') BETWEEN 1 AND 120
      AND jsonb_typeof(presentation_metadata -> 'category') = 'string'
      AND char_length(presentation_metadata ->> 'category') BETWEEN 1 AND 80
      AND jsonb_typeof(presentation_metadata -> 'icon_key') = 'string'
      AND (presentation_metadata ->> 'icon_key')
        ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
      AND jsonb_typeof(presentation_metadata -> 'operation_group') = 'string'
      AND char_length(presentation_metadata ->> 'operation_group') BETWEEN 1 AND 120
      AND jsonb_typeof(presentation_metadata -> 'operation_name') = 'string'
      AND char_length(presentation_metadata ->> 'operation_name') BETWEEN 1 AND 120
      AND jsonb_typeof(presentation_metadata -> 'display_priority') = 'number'
      AND (presentation_metadata ->> 'display_priority') ~ '^[0-9]+$'
      AND (presentation_metadata ->> 'display_priority')::numeric <= 1000000
    );

-- Catalogue reads may see only the safe versioned presentation and schemas.
GRANT SELECT (configuration_schema, presentation_metadata)
  ON app.service_template_versions TO dhumi_customer_api;

-- Service creation validates saved settings against configuration_schema;
-- Run admission continues to validate per-Run input against input_schema.
GRANT SELECT (configuration_schema)
  ON app.service_template_versions TO dhumi_admission;

RESET ROLE;
