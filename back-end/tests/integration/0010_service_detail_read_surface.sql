\set ON_ERROR_STOP on

-- Privileged rollback-only proof for migration 0017. No customer, catalogue,
-- Service, configuration, audit, outbox or idempotency fixture survives.

BEGIN;
SET CONSTRAINTS ALL DEFERRED;

CREATE FUNCTION pg_temp.assert_true(condition boolean, message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF condition IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'assertion failed: %', message;
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.assert_true(boolean, text) TO PUBLIC;

CREATE TEMP TABLE service_detail_fixture (
  tenant_a_id uuid NOT NULL,
  tenant_b_id uuid NOT NULL,
  user_a_id uuid NOT NULL,
  user_b_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  adapter_definition_id uuid NOT NULL,
  adapter_version_id uuid NOT NULL,
  template_id uuid NOT NULL,
  template_version_id uuid NOT NULL,
  service_a_id uuid NOT NULL,
  service_b_id uuid NOT NULL
) ON COMMIT DROP;
GRANT SELECT ON service_detail_fixture TO PUBLIC;

INSERT INTO service_detail_fixture VALUES (
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid()
);

INSERT INTO app.users (id, email_normalized, password_hash)
SELECT user_a_id, 'service-detail-a@example.test',
  '$argon2id$service-detail-a-not-a-real-password'
FROM service_detail_fixture
UNION ALL
SELECT user_b_id, 'service-detail-b@example.test',
  '$argon2id$service-detail-b-not-a-real-password'
FROM service_detail_fixture;

INSERT INTO app.tenants (id, display_name)
SELECT tenant_a_id, 'Service detail regression Tenant A'
FROM service_detail_fixture
UNION ALL
SELECT tenant_b_id, 'Service detail regression Tenant B'
FROM service_detail_fixture;

INSERT INTO app.tenant_user_access (tenant_id, user_id)
SELECT tenant_a_id, user_a_id FROM service_detail_fixture
UNION ALL
SELECT tenant_b_id, user_b_id FROM service_detail_fixture;

INSERT INTO app.launch_evidence (
  id, evidence_code, scope_type, scope_key, state, restricted_reference,
  effective_at, expires_at, approved_by, approved_at
)
SELECT evidence_id, 'service-detail-regression', 'template', template_id::text,
  'approved', 'restricted:test-only-service-detail',
  statement_timestamp() - interval '1 day',
  statement_timestamp() + interval '1 day',
  'test-migration-principal', statement_timestamp() - interval '1 day'
FROM service_detail_fixture;

INSERT INTO app.adapter_definitions (id, code, product_family)
SELECT adapter_definition_id, 'service-detail-regression', 'marketplace_dataset'
FROM service_detail_fixture;

INSERT INTO app.adapter_versions (
  id, adapter_definition_id, semantic_version, code_artifact_digest, state
)
SELECT adapter_version_id, adapter_definition_id, '1.0.0',
  decode(repeat('21', 32), 'hex'), 'enabled'
FROM service_detail_fixture;

INSERT INTO app.service_templates (id, slug, product_family, state)
SELECT template_id, 'service-detail-regression', 'marketplace_dataset', 'draft'
FROM service_detail_fixture;

INSERT INTO app.service_template_versions (
  id, service_template_id, version, public_name, public_description,
  input_schema, output_schema, availability_copy, availability_state,
  adapter_version_id, launch_evidence_id, effective_at, published_at
)
SELECT template_version_id, template_id, 1, 'Service detail Template',
  'Rollback-only Service detail Template', '{"type":"object"}'::jsonb,
  '{}'::jsonb, 'Available', 'available', adapter_version_id, evidence_id,
  statement_timestamp() - interval '1 day', statement_timestamp() - interval '1 day'
FROM service_detail_fixture;

UPDATE app.service_templates AS template
SET state = 'published',
    current_public_version_id = fixture.template_version_id,
    updated_at = clock_timestamp()
FROM service_detail_fixture AS fixture
WHERE template.id = fixture.template_id;

INSERT INTO app.services (
  id, tenant_id, service_template_id, name, state, current_version, created_at
)
SELECT service_a_id, tenant_a_id, template_id, 'Tenant A saved Service',
  'active', 1, statement_timestamp() - interval '2 minutes'
FROM service_detail_fixture
UNION ALL
SELECT service_b_id, tenant_b_id, template_id, 'Tenant B saved Service',
  'disabled', 1, statement_timestamp() - interval '1 minute'
FROM service_detail_fixture;

INSERT INTO app.service_versions (
  tenant_id, service_id, version, service_template_version_id,
  validated_configuration, schema_hash, created_by_user_id,
  created_by_api_key_id
)
SELECT tenant_a_id, service_a_id, 1, template_version_id,
  '{"query":"tenant-a","nested":{"country":"US"}}'::jsonb,
  decode(repeat('31', 32), 'hex'), user_a_id, NULL::uuid
FROM service_detail_fixture
UNION ALL
SELECT tenant_b_id, service_b_id, 1, template_version_id,
  '{"query":"tenant-b","private_cross_tenant":"must-not-leak"}'::jsonb,
  decode(repeat('32', 32), 'hex'), user_b_id, NULL::uuid
FROM service_detail_fixture;

SET CONSTRAINTS ALL IMMEDIATE;

SET LOCAL ROLE dhumi_customer_api;
SELECT set_config(
  'app.tenant_id',
  (SELECT tenant_a_id::text FROM service_detail_fixture),
  true
);

SELECT pg_temp.assert_true(
  has_column_privilege(
    current_user,
    'app.service_versions',
    'validated_configuration',
    'SELECT'
  ),
  'customer API must read only the saved configuration needed by Service detail'
);

SELECT pg_temp.assert_true(
  NOT has_table_privilege(current_user, 'app.service_versions', 'SELECT')
  AND NOT has_column_privilege(current_user, 'app.service_versions', 'schema_hash', 'SELECT')
  AND NOT has_column_privilege(current_user, 'app.service_versions', 'created_by_user_id', 'SELECT')
  AND NOT has_column_privilege(current_user, 'app.service_versions', 'created_by_api_key_id', 'SELECT')
  AND NOT has_column_privilege(current_user, 'app.service_versions', 'created_at', 'SELECT'),
  'schema, creator and internal version fields must remain unreadable'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
      AND min(service.name) = 'Tenant A saved Service'
      AND min(template.slug) = 'service-detail-regression'
      AND min(template_version.version) = 1
      AND min(service_version.version) = 1
      AND min(template.product_family) = 'marketplace_dataset'
      AND min(service.state) = 'active'
      AND bool_and(
        service_version.validated_configuration =
          '{"query":"tenant-a","nested":{"country":"US"}}'::jsonb
      )
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
    WHERE service.tenant_id = (SELECT tenant_a_id FROM service_detail_fixture)
      AND service.id = (SELECT service_a_id FROM service_detail_fixture)
  ),
  'Tenant A must read its exact current Service detail and nested configuration'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM app.services AS service
    INNER JOIN app.service_versions AS service_version
      ON service_version.tenant_id = service.tenant_id
     AND service_version.service_id = service.id
     AND service_version.version = service.current_version
    WHERE service.id = (SELECT service_b_id FROM service_detail_fixture)
  ),
  'Tenant A must not see Tenant B Service or configuration'
);

DO $$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    PERFORM schema_hash, created_by_user_id, created_by_api_key_id, created_at
    FROM app.service_versions;
  EXCEPTION WHEN insufficient_privilege THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'private version reads must be denied');
END;
$$;

RESET ROLE;

SET LOCAL ROLE dhumi_customer_api;
SELECT set_config('app.tenant_id', '', true);
SELECT pg_temp.assert_true(
  (SELECT count(*) FROM app.services) = 0
  AND (SELECT count(*) FROM app.service_versions) = 0
  AND (SELECT count(*) FROM app.service_templates) = 0
  AND (SELECT count(*) FROM app.service_template_versions) = 0,
  'Service detail RLS must fail closed without trusted Tenant context'
);
RESET ROLE;

ROLLBACK;
