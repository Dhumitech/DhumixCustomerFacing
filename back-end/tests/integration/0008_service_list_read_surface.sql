-- Privileged rollback-only regression tests for the 0015 Service read surface.
-- Run with the migration principal against dhumi_test; no fixture survives.

BEGIN;
SET CONSTRAINTS ALL DEFERRED;

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

CREATE TEMP TABLE service_list_fixture (
  tenant_a_id uuid,
  tenant_b_id uuid,
  adapter_version_id uuid,
  evidence_id uuid,
  template_a_id uuid,
  template_a_v1_id uuid,
  template_a_v2_id uuid,
  template_b_id uuid,
  template_b_v1_id uuid,
  tenant_a_service_1_id uuid,
  tenant_a_service_2_id uuid,
  tenant_a_service_3_id uuid,
  tenant_b_service_id uuid
) ON COMMIT DROP;
GRANT ALL ON TABLE service_list_fixture TO PUBLIC;
INSERT INTO service_list_fixture DEFAULT VALUES;

WITH tenant_a AS (
  INSERT INTO app.tenants (display_name)
  VALUES ('Service list regression Tenant A')
  RETURNING id
), tenant_b AS (
  INSERT INTO app.tenants (display_name)
  VALUES ('Service list regression Tenant B')
  RETURNING id
), adapter_definition AS (
  INSERT INTO app.adapter_definitions (code, product_family)
  VALUES ('service-list-regression', 'marketplace_dataset')
  RETURNING id
), adapter_version AS (
  INSERT INTO app.adapter_versions (
    adapter_definition_id,
    semantic_version,
    code_artifact_digest,
    state
  )
  SELECT id, '1.0.0', decode(repeat('21', 32), 'hex'), 'enabled'
  FROM adapter_definition
  RETURNING id
), evidence AS (
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
    'service-list-regression',
    'template',
    'service-list-regression',
    'approved',
    'restricted:test-only-service-list',
    statement_timestamp() - interval '2 days',
    statement_timestamp() + interval '2 days',
    'test-migration-principal',
    statement_timestamp() - interval '2 days'
  )
  RETURNING id
)
UPDATE service_list_fixture
SET
  tenant_a_id = tenant_a.id,
  tenant_b_id = tenant_b.id,
  adapter_version_id = adapter_version.id,
  evidence_id = evidence.id
FROM tenant_a, tenant_b, adapter_version, evidence;

WITH template_a AS (
  INSERT INTO app.service_templates (slug, product_family)
  VALUES ('service-list-template-a', 'marketplace_dataset')
  RETURNING id
), template_b AS (
  INSERT INTO app.service_templates (slug, product_family)
  VALUES ('service-list-template-b', 'marketplace_dataset')
  RETURNING id
)
UPDATE service_list_fixture
SET template_a_id = template_a.id, template_b_id = template_b.id
FROM template_a, template_b;

WITH template_a_v1 AS (
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
    template_a_id,
    1,
    'Service list Template A version 1',
    'The version pinned by Tenant A',
    '{"type":"object"}'::jsonb,
    '{}'::jsonb,
    'Available',
    'available',
    adapter_version_id,
    evidence_id,
    statement_timestamp() - interval '2 days',
    statement_timestamp() - interval '2 days'
  FROM service_list_fixture
  RETURNING id
), template_a_v2 AS (
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
    template_a_id,
    2,
    'Service list Template A version 2',
    'The later catalogue version pinned by Tenant B',
    '{"type":"object"}'::jsonb,
    '{}'::jsonb,
    'Available',
    'available',
    adapter_version_id,
    evidence_id,
    statement_timestamp() - interval '1 day',
    statement_timestamp() - interval '1 day'
  FROM service_list_fixture
  RETURNING id
), template_b_v1 AS (
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
    template_b_id,
    1,
    'Service list Template B version 1',
    'Must not be pinnable by a Template A Service',
    '{"type":"object"}'::jsonb,
    '{}'::jsonb,
    'Available',
    'available',
    adapter_version_id,
    evidence_id,
    statement_timestamp() - interval '1 day',
    statement_timestamp() - interval '1 day'
  FROM service_list_fixture
  RETURNING id
)
UPDATE service_list_fixture
SET
  template_a_v1_id = template_a_v1.id,
  template_a_v2_id = template_a_v2.id,
  template_b_v1_id = template_b_v1.id
FROM template_a_v1, template_a_v2, template_b_v1;

UPDATE app.service_templates
SET
  state = 'published',
  current_public_version_id = fixture.template_a_v1_id,
  updated_at = clock_timestamp()
FROM service_list_fixture AS fixture
WHERE id = fixture.template_a_id;

UPDATE app.service_templates
SET
  state = 'published',
  current_public_version_id = fixture.template_b_v1_id,
  updated_at = clock_timestamp()
FROM service_list_fixture AS fixture
WHERE id = fixture.template_b_id;

WITH service_a1 AS (
  INSERT INTO app.services (
    tenant_id,
    service_template_id,
    name,
    state,
    current_version,
    created_at
  )
  SELECT
    tenant_a_id,
    template_a_id,
    'Tenant A Service 1',
    'active',
    1,
    statement_timestamp() - interval '1 minute'
  FROM service_list_fixture
  RETURNING id
), service_a2 AS (
  INSERT INTO app.services (
    tenant_id,
    service_template_id,
    name,
    state,
    current_version,
    created_at
  )
  SELECT
    tenant_a_id,
    template_a_id,
    'Tenant A Service 2',
    'disabled',
    1,
    statement_timestamp() - interval '2 minutes'
  FROM service_list_fixture
  RETURNING id
), service_a3 AS (
  INSERT INTO app.services (
    tenant_id,
    service_template_id,
    name,
    state,
    current_version,
    created_at
  )
  SELECT
    tenant_a_id,
    template_a_id,
    'Tenant A Service 3',
    'active',
    1,
    statement_timestamp() - interval '3 minutes'
  FROM service_list_fixture
  RETURNING id
), service_b AS (
  INSERT INTO app.services (
    tenant_id,
    service_template_id,
    name,
    state,
    current_version,
    created_at
  )
  SELECT
    tenant_b_id,
    template_a_id,
    'Tenant B Service',
    'active',
    1,
    statement_timestamp() - interval '30 seconds'
  FROM service_list_fixture
  RETURNING id
)
UPDATE service_list_fixture
SET
  tenant_a_service_1_id = service_a1.id,
  tenant_a_service_2_id = service_a2.id,
  tenant_a_service_3_id = service_a3.id,
  tenant_b_service_id = service_b.id
FROM service_a1, service_a2, service_a3, service_b;

INSERT INTO app.service_versions (
  tenant_id,
  service_id,
  version,
  service_template_version_id,
  validated_configuration,
  schema_hash
)
SELECT tenant_a_id, tenant_a_service_1_id, 1, template_a_v1_id, '{}'::jsonb,
  decode(repeat('31', 32), 'hex')
FROM service_list_fixture
UNION ALL
SELECT tenant_a_id, tenant_a_service_2_id, 1, template_a_v1_id, '{}'::jsonb,
  decode(repeat('32', 32), 'hex')
FROM service_list_fixture
UNION ALL
SELECT tenant_a_id, tenant_a_service_3_id, 1, template_a_v1_id, '{}'::jsonb,
  decode(repeat('33', 32), 'hex')
FROM service_list_fixture
UNION ALL
SELECT tenant_b_id, tenant_b_service_id, 1, template_a_v2_id, '{}'::jsonb,
  decode(repeat('34', 32), 'hex')
FROM service_list_fixture;

-- Move publication forward and then retire it. Saved Services must continue to
-- resolve only their own immutable pins, not whichever version is public now.
UPDATE app.service_templates
SET
  current_public_version_id = fixture.template_a_v2_id,
  state = 'retired',
  updated_at = clock_timestamp()
FROM service_list_fixture AS fixture
WHERE id = fixture.template_a_id;

-- Invalid lifecycle state is rejected immediately.
DO $$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    INSERT INTO app.services (
      tenant_id,
      service_template_id,
      name,
      state,
      current_version
    )
    SELECT tenant_a_id, template_a_id, 'Invalid archived Service', 'archived', 1
    FROM service_list_fixture;
  EXCEPTION WHEN check_violation THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'archived Services must be rejected');
END;
$$;

-- A deferred current pointer still has to name a real version of the same
-- Tenant and Service before the transaction can complete.
DO $$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    INSERT INTO app.services (
      tenant_id,
      service_template_id,
      name,
      state,
      current_version
    )
    SELECT tenant_a_id, template_a_id, 'Invalid current pointer Service', 'active', 99
    FROM service_list_fixture;
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN foreign_key_violation THEN
    rejected := true;
  END;
  SET CONSTRAINTS ALL DEFERRED;
  PERFORM pg_temp.assert_true(rejected, 'invalid current Service pointers must be rejected');
END;
$$;

-- A Service cannot pin a version that belongs to another Template identity.
DO $$
DECLARE
  rejected boolean := false;
  invalid_service_id uuid;
BEGIN
  BEGIN
    INSERT INTO app.services (
      tenant_id,
      service_template_id,
      name,
      state,
      current_version
    )
    SELECT tenant_a_id, template_a_id, 'Cross-Template Service', 'active', 1
    FROM service_list_fixture
    RETURNING id INTO invalid_service_id;

    INSERT INTO app.service_versions (
      tenant_id,
      service_id,
      version,
      service_template_version_id,
      validated_configuration,
      schema_hash
    )
    SELECT
      tenant_a_id,
      invalid_service_id,
      1,
      template_b_v1_id,
      '{}'::jsonb,
      decode(repeat('41', 32), 'hex')
    FROM service_list_fixture;
  EXCEPTION WHEN check_violation THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'cross-Template version pins must be rejected');
END;
$$;

SET LOCAL ROLE dhumi_customer_api;
SELECT set_config(
  'app.tenant_id',
  (SELECT tenant_a_id::text FROM service_list_fixture),
  true
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*)
    FROM app.services AS service
    INNER JOIN app.service_versions AS service_version
      ON service_version.tenant_id = service.tenant_id
     AND service_version.service_id = service.id
     AND service_version.version = service.current_version
    INNER JOIN app.service_template_versions AS template_version
      ON template_version.id = service_version.service_template_version_id
    INNER JOIN app.service_templates AS template
      ON template.id = template_version.service_template_id
     AND template.id = service.service_template_id
    WHERE service.tenant_id = (SELECT tenant_a_id FROM service_list_fixture)
      AND template_version.id = (SELECT template_a_v1_id FROM service_list_fixture)
  ) = 3,
  'Tenant A must retain its three Services pinned to the superseded version'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM app.services
    WHERE id = (SELECT tenant_b_service_id FROM service_list_fixture)
  ),
  'Tenant A must not see Tenant B Services'
);

SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1
    FROM app.service_template_versions
    WHERE id = (SELECT template_a_v1_id FROM service_list_fixture)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM app.service_template_versions
    WHERE id = (SELECT template_a_v2_id FROM service_list_fixture)
  ),
  'Tenant A must see only its owned historical Template pin'
);

SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1
    FROM app.service_template_versions
    WHERE id = (SELECT template_b_v1_id FROM service_list_fixture)
  ),
  'owned historical visibility must preserve the existing public catalogue path'
);

WITH page_one AS (
  SELECT id, created_at
  FROM app.services
  WHERE tenant_id = (SELECT tenant_a_id FROM service_list_fixture)
  ORDER BY created_at DESC, id DESC
  LIMIT 2
), cursor_position AS (
  SELECT id, created_at
  FROM page_one
  ORDER BY created_at ASC, id ASC
  LIMIT 1
), page_two AS (
  SELECT service.id, service.created_at
  FROM app.services AS service, cursor_position AS cursor
  WHERE service.tenant_id = (SELECT tenant_a_id FROM service_list_fixture)
    AND (service.created_at, service.id) < (cursor.created_at, cursor.id)
  ORDER BY service.created_at DESC, service.id DESC
  LIMIT 2
), combined AS (
  SELECT id FROM page_one
  UNION ALL
  SELECT id FROM page_two
)
SELECT pg_temp.assert_true(
  (SELECT count(*) FROM combined) = 3
  AND (SELECT count(DISTINCT id) FROM combined) = 3,
  'descending keyset pages must contain every owned Service without duplicates'
);

DO $$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    PERFORM updated_at FROM app.services;
  EXCEPTION WHEN insufficient_privilege THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'internal Service timestamps must be unreadable');

  rejected := false;
  BEGIN
    PERFORM validated_configuration, schema_hash, created_by_user_id
    FROM app.service_versions;
  EXCEPTION WHEN insufficient_privilege THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'private Service-version fields must be unreadable');
END;
$$;

RESET ROLE;

SET LOCAL ROLE dhumi_customer_api;
SELECT set_config(
  'app.tenant_id',
  (SELECT tenant_b_id::text FROM service_list_fixture),
  true
);
SELECT pg_temp.assert_true(
  (SELECT count(*) FROM app.services) = 1
  AND EXISTS (
    SELECT 1
    FROM app.service_template_versions
    WHERE id = (SELECT template_a_v2_id FROM service_list_fixture)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM app.service_template_versions
    WHERE id = (SELECT template_a_v1_id FROM service_list_fixture)
  ),
  'Tenant B must see only its Service and its own retired Template pin'
);
RESET ROLE;

SET LOCAL ROLE dhumi_customer_api;
SELECT set_config('app.tenant_id', '', true);
SELECT pg_temp.assert_true(
  (SELECT count(*) FROM app.services) = 0
  AND (SELECT count(*) FROM app.service_versions) = 0
  AND (SELECT count(*) FROM app.service_templates) = 0
  AND (SELECT count(*) FROM app.service_template_versions) = 0,
  'Service and Template RLS must fail closed without trusted Tenant context'
);
RESET ROLE;

ROLLBACK;
