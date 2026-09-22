-- Privileged, rollback-only proof for migration 0043. The caller provides the
-- synthetic v3 release fixture from 0029 in a disposable database. No provider
-- endpoint is contacted by either proof.
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

CREATE TEMP TABLE source_version_snapshot AS
SELECT to_jsonb(version) AS document
FROM app.service_template_versions AS version
JOIN app.service_templates AS template ON template.id = version.service_template_id
WHERE template.slug = 'amazon-products-collect-by-url'
  AND version.version = 3;

INSERT INTO app.users (
  id, email_normalized, password_hash, state, email_verified_at
) VALUES (
  '7e000000-0000-4000-8000-000000000001',
  'input-v4-proof@example.test', 'not-a-runtime-password', 'active',
  clock_timestamp()
);

INSERT INTO app.tenants (id, display_name, state) VALUES (
  '7e000000-0000-4000-8000-000000000002', 'Input v4 proof', 'active'
);

INSERT INTO app.tenant_user_access (tenant_id, user_id, access_role, state)
VALUES (
  '7e000000-0000-4000-8000-000000000002',
  '7e000000-0000-4000-8000-000000000001', 'owner', 'active'
);

INSERT INTO app.services (
  id, tenant_id, service_template_id, name, state, current_version
)
SELECT
  '7e000000-0000-4000-8000-000000000003',
  '7e000000-0000-4000-8000-000000000002', template.id,
  'Existing v3 Service', 'active', 1
FROM app.service_templates AS template
WHERE template.slug = 'amazon-products-collect-by-url';

INSERT INTO app.service_versions (
  id, tenant_id, service_id, version, service_template_version_id,
  validated_configuration, schema_hash, created_by_user_id
)
SELECT
  '7e000000-0000-4000-8000-000000000004',
  '7e000000-0000-4000-8000-000000000002',
  '7e000000-0000-4000-8000-000000000003', 1, version.id,
  '{}'::jsonb, decode(repeat('ab', 32), 'hex'),
  '7e000000-0000-4000-8000-000000000001'
FROM app.service_template_versions AS version
JOIN app.service_templates AS template ON template.id = version.service_template_id
WHERE template.slug = 'amazon-products-collect-by-url'
  AND version.version = 3;

SET LOCAL ROLE dhumi_operator;

SELECT pg_temp.assert_true(
  release.operation_code = 'amazon.products.collect_by_url'
    AND release.template_slug = 'amazon-products-collect-by-url'
    AND release.template_version = 4
    AND release.environment = 'test'
    AND release.release_outcome = 'published',
  'first invocation must publish immutable v4'
)
FROM app.publish_amazon_products_input_contract_v4(
  'test',
  'restricted://backend-release/amazon-products-input-v4/0043',
  decode(repeat('ac', 32), 'hex'),
  'backend.release.reviewer',
  'amazon_products_input_v4_approved',
  NULL
) AS release;

SELECT pg_temp.assert_true(
  release.release_outcome = 'replayed',
  'an exact v4 release replay must be idempotent'
)
FROM app.publish_amazon_products_input_contract_v4(
  'test',
  'restricted://backend-release/amazon-products-input-v4/0043',
  decode(repeat('ac', 32), 'hex'),
  'backend.release.reviewer',
  'amazon_products_input_v4_approved',
  NULL
) AS release;

RESET ROLE;

SELECT pg_temp.assert_true(
  (SELECT to_jsonb(version) = snapshot.document
   FROM app.service_template_versions AS version
   JOIN app.service_templates AS template ON template.id = version.service_template_id
   CROSS JOIN source_version_snapshot AS snapshot
   WHERE template.slug = 'amazon-products-collect-by-url'
     AND version.version = 3),
  'immutable v3 must remain byte-for-byte unchanged'
);

SELECT pg_temp.assert_true(
  (SELECT version.version = 4
      AND version.input_schema #>> '{properties,targets,minItems}' = '1'
      AND version.input_schema #>> '{properties,targets,maxItems}' = '20'
      AND version.input_schema #>>
        '{properties,targets,items,properties,zipcode,pattern}' =
          '^[0-9]{5}$'
      AND version.input_schema #>
        '{properties,targets,items,properties,language,enum}' = '["EN"]'::jsonb
      AND version.input_schema #>>
        '{properties,targets,items,additionalProperties}' = 'false'
   FROM app.service_templates AS template
   JOIN app.service_template_versions AS version
     ON version.id = template.current_public_version_id
   WHERE template.slug = 'amazon-products-collect-by-url'),
  'the public pointer must select the exact strict v4 schema'
);

SELECT pg_temp.assert_true(
  (SELECT version.version = 3
   FROM app.service_versions AS service_version
   JOIN app.service_template_versions AS version
     ON version.id = service_version.service_template_version_id
   WHERE service_version.id = '7e000000-0000-4000-8000-000000000004'),
  'an existing Service must remain pinned to v3'
);

INSERT INTO app.services (
  id, tenant_id, service_template_id, name, state, current_version
)
SELECT
  '7e000000-0000-4000-8000-000000000005',
  '7e000000-0000-4000-8000-000000000002', template.id,
  'New v4 Service', 'active', 1
FROM app.service_templates AS template
WHERE template.slug = 'amazon-products-collect-by-url';

INSERT INTO app.service_versions (
  id, tenant_id, service_id, version, service_template_version_id,
  validated_configuration, schema_hash, created_by_user_id
)
SELECT
  '7e000000-0000-4000-8000-000000000006',
  '7e000000-0000-4000-8000-000000000002',
  '7e000000-0000-4000-8000-000000000005', 1,
  template.current_public_version_id, '{}'::jsonb,
  decode(repeat('ad', 32), 'hex'),
  '7e000000-0000-4000-8000-000000000001'
FROM app.service_templates AS template
WHERE template.slug = 'amazon-products-collect-by-url';

SELECT pg_temp.assert_true(
  (SELECT version.version = 4
   FROM app.service_versions AS service_version
   JOIN app.service_template_versions AS version
     ON version.id = service_version.service_template_version_id
   WHERE service_version.id = '7e000000-0000-4000-8000-000000000006'),
  'a Service created from the new public pointer must pin v4'
);

SELECT pg_temp.assert_true(
  (SELECT count(*) = 1
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
     AND v4_mapping.environment = 'test'
     AND v4_mapping.state = 'enabled'
     AND v4_mapping.provider_resource_ciphertext =
       v3_mapping.provider_resource_ciphertext
     AND v4_mapping.provider_resource_fingerprint =
       v3_mapping.provider_resource_fingerprint
     AND v4_mapping.provider_resource_aad_mapping_id =
       v3_mapping.provider_resource_aad_mapping_id),
  'v4 must have one enabled protected mapping with preserved AAD lineage'
);

SELECT pg_temp.assert_true(
  (SELECT count(*) = 1
   FROM app.audit_events
   WHERE action = 'provider.operation.input_contract.publish'
     AND target_type = 'service_template_version'),
  'v4 publication must write one immutable safe audit event'
);

SET LOCAL ROLE dhumi_customer_api;
SELECT set_config(
  'app.tenant_id',
  '7e000000-0000-4000-8000-000000000002',
  true
);

SELECT pg_temp.assert_true(
  (SELECT version.version = 4
   FROM app.service_templates AS template
   JOIN app.service_template_versions AS version
     ON version.id = template.current_public_version_id
   WHERE template.slug = 'amazon-products-collect-by-url'),
  'the customer catalogue projection must now select v4'
);

SELECT pg_temp.assert_true(
  (SELECT version.version = 3
   FROM app.service_versions AS service_version
   JOIN app.service_template_versions AS version
     ON version.id = service_version.service_template_version_id
   WHERE service_version.id = '7e000000-0000-4000-8000-000000000004'),
  'the same customer must still read the existing Service as v3'
);

RESET ROLE;
\if :{?keep_fixture}
COMMIT;
\else
ROLLBACK;
\endif
