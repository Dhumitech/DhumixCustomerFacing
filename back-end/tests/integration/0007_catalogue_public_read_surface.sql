-- Privileged rollback-only regression tests for the 0013 catalogue read surface
-- and 0014 public slug integrity.
-- Run with the migration principal against dhumi_test; no fixture survives.

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(p_condition boolean, p_message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_condition IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'assertion failed: %', p_message;
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.assert_true(boolean, text) TO PUBLIC;

CREATE TEMP TABLE catalogue_fixture (
  tenant_id uuid,
  adapter_version_id uuid,
  current_evidence_id uuid,
  invalid_evidence_id uuid,
  expired_evidence_id uuid,
  marketplace_template_id uuid,
  marketplace_old_version_id uuid,
  marketplace_current_version_id uuid,
  disabled_template_id uuid,
  future_template_id uuid,
  invalid_evidence_template_id uuid
) ON COMMIT DROP;
GRANT ALL ON TABLE catalogue_fixture TO PUBLIC;
INSERT INTO catalogue_fixture DEFAULT VALUES;

WITH tenant AS (
  INSERT INTO app.tenants (display_name)
  VALUES ('Catalogue public read regression Tenant')
  RETURNING id
), adapter_definition AS (
  INSERT INTO app.adapter_definitions (code, product_family)
  VALUES ('catalogue-public-read-regression', 'marketplace_dataset')
  RETURNING id
), adapter_version AS (
  INSERT INTO app.adapter_versions (
    adapter_definition_id,
    semantic_version,
    code_artifact_digest,
    state
  )
  SELECT id, '1.0.0', decode(repeat('11', 32), 'hex'), 'enabled'
  FROM adapter_definition
  RETURNING id
), current_evidence AS (
  INSERT INTO app.launch_evidence (
    evidence_code,
    scope_type,
    scope_key,
    state,
    restricted_reference,
    effective_at,
    expires_at,
    approved_by,
    approved_at
  ) VALUES (
    'catalogue-public-read-current',
    'template',
    'catalogue-public-read-current',
    'approved',
    'restricted:test-only-current',
    statement_timestamp() - interval '1 day',
    statement_timestamp() + interval '1 day',
    'test-migration-principal',
    statement_timestamp() - interval '1 day'
  )
  RETURNING id
), invalid_evidence AS (
  INSERT INTO app.launch_evidence (
    evidence_code,
    scope_type,
    scope_key,
    state,
    restricted_reference,
    effective_at
  ) VALUES (
    'catalogue-public-read-invalid',
    'template',
    'catalogue-public-read-invalid',
    'revoked',
    'restricted:test-only-invalid',
    statement_timestamp() - interval '1 day'
  )
  RETURNING id
), expired_evidence AS (
  INSERT INTO app.launch_evidence (
    evidence_code,
    scope_type,
    scope_key,
    state,
    restricted_reference,
    effective_at,
    expires_at,
    approved_by,
    approved_at
  ) VALUES (
    'catalogue-public-read-expired',
    'template',
    'catalogue-public-read-expired',
    'approved',
    'restricted:test-only-expired',
    statement_timestamp() - interval '2 days',
    statement_timestamp() - interval '1 day',
    'test-migration-principal',
    statement_timestamp() - interval '2 days'
  )
  RETURNING id
)
UPDATE catalogue_fixture
SET
  tenant_id = tenant.id,
  adapter_version_id = adapter_version.id,
  current_evidence_id = current_evidence.id,
  invalid_evidence_id = invalid_evidence.id,
  expired_evidence_id = expired_evidence.id
FROM tenant, adapter_version, current_evidence, invalid_evidence, expired_evidence;

WITH inserted AS (
  INSERT INTO app.service_templates (slug, product_family)
  VALUES ('regression-marketplace-template', 'marketplace_dataset')
  RETURNING id
)
UPDATE catalogue_fixture
SET marketplace_template_id = inserted.id
FROM inserted;

WITH old_version AS (
  INSERT INTO app.service_template_versions (
    service_template_id,
    version,
    public_name,
    public_description,
    input_schema,
    output_schema,
    availability_copy,
    availability_state,
    adapter_version_id,
    launch_evidence_id,
    effective_at,
    published_at
  )
  SELECT
    marketplace_template_id,
    1,
    'Old Marketplace Template',
    'Superseded and never customer-visible',
    '{"type":"object"}'::jsonb,
    '{}'::jsonb,
    'Old copy',
    'available',
    adapter_version_id,
    current_evidence_id,
    statement_timestamp() - interval '2 days',
    statement_timestamp() - interval '2 days'
  FROM catalogue_fixture
  RETURNING id
), current_version AS (
  INSERT INTO app.service_template_versions (
    service_template_id,
    version,
    public_name,
    public_description,
    input_schema,
    output_schema,
    availability_copy,
    availability_state,
    adapter_version_id,
    launch_evidence_id,
    effective_at,
    published_at
  )
  SELECT
    marketplace_template_id,
    2,
    'Current Marketplace Template',
    'The selected public version',
    '{"type":"object","properties":{"query":{"type":"string"}}}'::jsonb,
    '{}'::jsonb,
    'Available now',
    'available',
    adapter_version_id,
    current_evidence_id,
    statement_timestamp() - interval '1 day',
    statement_timestamp() - interval '1 day'
  FROM catalogue_fixture
  RETURNING id
)
UPDATE catalogue_fixture
SET
  marketplace_old_version_id = old_version.id,
  marketplace_current_version_id = current_version.id
FROM old_version, current_version;

UPDATE app.service_templates
SET
  state = 'published',
  current_public_version_id = (SELECT marketplace_current_version_id FROM catalogue_fixture),
  updated_at = clock_timestamp()
WHERE id = (SELECT marketplace_template_id FROM catalogue_fixture);

WITH inserted AS (
  INSERT INTO app.service_templates (slug, product_family)
  VALUES ('regression-disabled-template', 'scraper_library')
  RETURNING id
)
UPDATE catalogue_fixture
SET disabled_template_id = inserted.id
FROM inserted;

WITH inserted AS (
  INSERT INTO app.service_template_versions (
    service_template_id,
    version,
    public_name,
    public_description,
    input_schema,
    output_schema,
    availability_copy,
    availability_state,
    adapter_version_id,
    launch_evidence_id,
    effective_at,
    published_at
  )
  SELECT
    fixture.disabled_template_id,
    1,
    'Disabled Scraper Template',
    'Visible but honestly unavailable',
    '{"type":"object"}'::jsonb,
    '{}'::jsonb,
    'Paused',
    'available',
    fixture.adapter_version_id,
    fixture.current_evidence_id,
    statement_timestamp() - interval '1 day',
    statement_timestamp() - interval '1 day'
  FROM catalogue_fixture AS fixture
  RETURNING id
)
UPDATE app.service_templates AS target
SET state = 'disabled', current_public_version_id = inserted.id
FROM inserted
WHERE target.id = (SELECT disabled_template_id FROM catalogue_fixture);

WITH inserted AS (
  INSERT INTO app.service_templates (slug, product_family)
  VALUES ('regression-future-template', 'marketplace_dataset')
  RETURNING id
)
UPDATE catalogue_fixture
SET future_template_id = inserted.id
FROM inserted;

WITH inserted AS (
  INSERT INTO app.service_template_versions (
    service_template_id,
    version,
    public_name,
    public_description,
    input_schema,
    output_schema,
    availability_copy,
    availability_state,
    adapter_version_id,
    launch_evidence_id,
    effective_at,
    published_at
  )
  SELECT
    fixture.future_template_id,
    1,
    'Future Template',
    'Must fail closed before effective time',
    '{"type":"object"}'::jsonb,
    '{}'::jsonb,
    'Coming later',
    'coming_soon',
    fixture.adapter_version_id,
    fixture.current_evidence_id,
    statement_timestamp() + interval '1 day',
    statement_timestamp()
  FROM catalogue_fixture AS fixture
  RETURNING id
)
UPDATE app.service_templates AS target
SET state = 'published', current_public_version_id = inserted.id
FROM inserted
WHERE target.id = (SELECT future_template_id FROM catalogue_fixture);

WITH inserted AS (
  INSERT INTO app.service_templates (slug, product_family)
  VALUES ('regression-invalid-evidence-template', 'marketplace_dataset')
  RETURNING id
)
UPDATE catalogue_fixture
SET invalid_evidence_template_id = inserted.id
FROM inserted;

WITH inserted AS (
  INSERT INTO app.service_template_versions (
    service_template_id,
    version,
    public_name,
    public_description,
    input_schema,
    output_schema,
    availability_copy,
    availability_state,
    adapter_version_id,
    launch_evidence_id,
    effective_at,
    published_at
  )
  SELECT
    fixture.invalid_evidence_template_id,
    1,
    'Invalid Evidence Template',
    'Must fail closed after evidence revocation',
    '{"type":"object"}'::jsonb,
    '{}'::jsonb,
    'Not available',
    'available',
    fixture.adapter_version_id,
    fixture.invalid_evidence_id,
    statement_timestamp() - interval '1 day',
    statement_timestamp() - interval '1 day'
  FROM catalogue_fixture AS fixture
  RETURNING id
)
UPDATE app.service_templates AS target
SET state = 'published', current_public_version_id = inserted.id
FROM inserted
WHERE target.id = (SELECT invalid_evidence_template_id FROM catalogue_fixture);

-- Expired evidence must make an otherwise current selected version invisible.
WITH template AS (
  INSERT INTO app.service_templates (slug, product_family)
  VALUES ('regression-expired-evidence-template', 'marketplace_dataset')
  RETURNING id
), version AS (
  INSERT INTO app.service_template_versions (
    service_template_id,
    version,
    public_name,
    public_description,
    input_schema,
    output_schema,
    availability_copy,
    availability_state,
    adapter_version_id,
    launch_evidence_id,
    effective_at,
    published_at
  )
  SELECT
    template.id,
    1,
    'Expired Evidence Template',
    'Must fail closed after evidence expiry',
    '{"type":"object"}'::jsonb,
    '{}'::jsonb,
    'Not available',
    'available',
    fixture.adapter_version_id,
    fixture.expired_evidence_id,
    statement_timestamp() - interval '1 day',
    statement_timestamp() - interval '1 day'
  FROM template, catalogue_fixture AS fixture
  RETURNING id, service_template_id
)
UPDATE app.service_templates AS target
SET state = 'published', current_public_version_id = version.id
FROM version
WHERE target.id = version.service_template_id;

-- A selected version with a non-object input schema fails the repository's
-- public projection even though the database policy can evaluate the row.
WITH template AS (
  INSERT INTO app.service_templates (slug, product_family)
  VALUES ('regression-malformed-schema-template', 'marketplace_dataset')
  RETURNING id
), version AS (
  INSERT INTO app.service_template_versions (
    service_template_id,
    version,
    public_name,
    public_description,
    input_schema,
    output_schema,
    availability_copy,
    availability_state,
    adapter_version_id,
    launch_evidence_id,
    effective_at,
    published_at
  )
  SELECT
    template.id,
    1,
    'Malformed Schema Template',
    'Must not cross the public repository projection',
    '[]'::jsonb,
    '{}'::jsonb,
    'Not available',
    'available',
    fixture.adapter_version_id,
    fixture.current_evidence_id,
    statement_timestamp() - interval '1 day',
    statement_timestamp() - interval '1 day'
  FROM template, catalogue_fixture AS fixture
  RETURNING id, service_template_id
)
UPDATE app.service_templates AS target
SET state = 'published', current_public_version_id = version.id
FROM version
WHERE target.id = version.service_template_id;

-- Draft and retired identities remain unaddressable even if an internal
-- version carries timestamps that would otherwise be current.
WITH template AS (
  INSERT INTO app.service_templates (slug, product_family, state)
  VALUES ('regression-draft-template', 'marketplace_dataset', 'draft')
  RETURNING id
)
INSERT INTO app.service_template_versions (
  service_template_id,
  version,
  public_name,
  public_description,
  input_schema,
  output_schema,
  availability_copy,
  availability_state,
  adapter_version_id,
  launch_evidence_id,
  effective_at,
  published_at
)
SELECT
  template.id,
  1,
  'Draft Template',
  'Must remain private',
  '{"type":"object"}'::jsonb,
  '{}'::jsonb,
  'Private',
  'available',
  fixture.adapter_version_id,
  fixture.current_evidence_id,
  statement_timestamp() - interval '1 day',
  statement_timestamp() - interval '1 day'
FROM template, catalogue_fixture AS fixture;

WITH template AS (
  INSERT INTO app.service_templates (slug, product_family, state)
  VALUES ('regression-retired-template', 'scraper_library', 'retired')
  RETURNING id
)
INSERT INTO app.service_template_versions (
  service_template_id,
  version,
  public_name,
  public_description,
  input_schema,
  output_schema,
  availability_copy,
  availability_state,
  adapter_version_id,
  launch_evidence_id,
  effective_at,
  published_at
)
SELECT
  template.id,
  1,
  'Retired Template',
  'Must remain private',
  '{"type":"object"}'::jsonb,
  '{}'::jsonb,
  'Retired',
  'temporarily_unavailable',
  fixture.adapter_version_id,
  fixture.current_evidence_id,
  statement_timestamp() - interval '1 day',
  statement_timestamp() - interval '1 day'
FROM template, catalogue_fixture AS fixture;

-- Migration 0014 closes the gap where the database accepted a slug that the
-- public TemplateSlug parameter could never address.
DO $$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    INSERT INTO app.service_templates (slug, product_family)
    VALUES ('regression--invalid-slug', 'marketplace_dataset');
  EXCEPTION WHEN check_violation THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'repeated-hyphen slugs must be rejected');
END;
$$;

SET LOCAL ROLE dhumi_customer_api;
SELECT set_config(
  'app.tenant_id',
  (SELECT tenant_id::text FROM catalogue_fixture),
  true
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*)
    FROM app.service_template_versions
    WHERE service_template_id = (
      SELECT marketplace_template_id FROM catalogue_fixture
    )
  ) = 1,
  'only the selected immutable version must be visible'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM app.service_template_versions
    WHERE id = (SELECT marketplace_old_version_id FROM catalogue_fixture)
  ),
  'the superseded version must be hidden'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM app.service_template_versions
    WHERE service_template_id IN (
      (SELECT future_template_id FROM catalogue_fixture),
      (SELECT invalid_evidence_template_id FROM catalogue_fixture)
    )
  ),
  'future and invalid-evidence selected versions must fail closed'
);

SELECT pg_temp.assert_true(
  (
    SELECT CASE
      WHEN template.state = 'disabled' THEN 'temporarily_unavailable'
      ELSE version.availability_state
    END
    FROM app.service_templates AS template
    JOIN app.service_template_versions AS version
      ON version.id = template.current_public_version_id
     AND version.service_template_id = template.id
    WHERE template.id = (SELECT disabled_template_id FROM catalogue_fixture)
  ) = 'temporarily_unavailable',
  'disabled Templates must project an honest unavailable state'
);

SELECT pg_temp.assert_true(
  (
    SELECT array_agg(template.product_family ORDER BY template.product_family, template.slug, template.id)
    FROM app.service_templates AS template
    JOIN app.service_template_versions AS version
      ON version.id = template.current_public_version_id
     AND version.service_template_id = template.id
    WHERE template.slug LIKE 'regression-%'
      AND jsonb_typeof(version.input_schema) = 'object'
  ) = ARRAY['marketplace_dataset', 'scraper_library']::text[],
  'the public traversal must be Marketplace-first and omit unsafe rows'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*)
    FROM app.service_templates AS template
    JOIN app.service_template_versions AS version
      ON version.service_template_id = template.id
     AND version.id = template.current_public_version_id
    JOIN app.launch_evidence AS evidence
      ON evidence.id = version.launch_evidence_id
    WHERE template.slug = 'regression-marketplace-template'
      AND template.state IN ('published', 'disabled')
      AND version.published_at IS NOT NULL
      AND version.published_at <= statement_timestamp()
      AND version.effective_at IS NOT NULL
      AND version.effective_at <= statement_timestamp()
      AND jsonb_typeof(version.input_schema) = 'object'
      AND evidence.state = 'approved'
      AND evidence.effective_at IS NOT NULL
      AND evidence.effective_at <= statement_timestamp()
      AND (evidence.expires_at IS NULL OR evidence.expires_at > statement_timestamp())
      AND version.version = 2
      AND version.public_name = 'Current Marketplace Template'
  ) = 1,
  'detail lookup must return exactly the selected current safe version'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*)
    FROM app.service_templates AS template
    JOIN app.service_template_versions AS version
      ON version.service_template_id = template.id
     AND version.id = template.current_public_version_id
    JOIN app.launch_evidence AS evidence
      ON evidence.id = version.launch_evidence_id
    WHERE template.slug IN (
      'regression-future-template',
      'regression-invalid-evidence-template',
      'regression-expired-evidence-template',
      'regression-malformed-schema-template',
      'regression-draft-template',
      'regression-retired-template'
    )
      AND template.state IN ('published', 'disabled')
      AND version.published_at IS NOT NULL
      AND version.published_at <= statement_timestamp()
      AND version.effective_at IS NOT NULL
      AND version.effective_at <= statement_timestamp()
      AND jsonb_typeof(version.input_schema) = 'object'
      AND evidence.state = 'approved'
      AND evidence.effective_at IS NOT NULL
      AND evidence.effective_at <= statement_timestamp()
      AND (evidence.expires_at IS NULL OR evidence.expires_at > statement_timestamp())
  ) = 0,
  'detail lookup must fail closed for every non-public state'
);

DO $$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    PERFORM adapter_version_id, output_schema
    FROM app.service_template_versions;
  EXCEPTION WHEN insufficient_privilege THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'provider-adjacent version fields must be unreadable');
END;
$$;

RESET ROLE;

SET LOCAL ROLE dhumi_customer_api;
SELECT set_config('app.tenant_id', '', true);
SELECT pg_temp.assert_true(
  (SELECT count(*) FROM app.service_templates) = 0
  AND (SELECT count(*) FROM app.service_template_versions) = 0,
  'catalogue RLS must fail closed without a trusted Tenant context'
);
RESET ROLE;

ROLLBACK;
