\set ON_ERROR_STOP on

-- Privileged, rollback-only proof for migration 0016. This fixture creates no
-- lasting catalogue, provider, customer, Service or idempotency data.

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

CREATE TEMP TABLE create_service_context (
  user_id uuid,
  tenant_id uuid,
  template_evidence_id uuid NOT NULL,
  mapping_evidence_id uuid NOT NULL,
  adapter_definition_id uuid NOT NULL,
  adapter_version_id uuid NOT NULL,
  provider_credential_id uuid NOT NULL,
  template_id uuid NOT NULL,
  template_version_id uuid NOT NULL,
  mapping_id uuid NOT NULL,
  claim_id uuid NOT NULL,
  service_id uuid NOT NULL,
  service_version_id uuid NOT NULL,
  idempotency_key text NOT NULL
);

INSERT INTO create_service_context VALUES (
  NULL,
  NULL,
  gen_random_uuid(),
  gen_random_uuid(),
  gen_random_uuid(),
  gen_random_uuid(),
  gen_random_uuid(),
  gen_random_uuid(),
  gen_random_uuid(),
  gen_random_uuid(),
  gen_random_uuid(),
  gen_random_uuid(),
  gen_random_uuid(),
  'service-fixture-key-0001'
);

GRANT SELECT, UPDATE ON create_service_context TO dhumi_identity;
GRANT SELECT ON create_service_context TO dhumi_owner, dhumi_admission;

SET LOCAL ROLE dhumi_identity;

WITH created AS (
  SELECT user_id, tenant_id
  FROM app.create_signup(
    'service-creation-fixture@example.test',
    '$argon2id$service-creation-fixture-not-a-real-password',
    'Service creation fixture',
    jsonb_build_array(jsonb_build_object(
      'document_type', 'terms',
      'document_version', 'service-creation-v1',
      'document_hash_hex', repeat('ab', 32),
      'disclosure_version', 'service-creation-v1',
      'locale', 'en'
    )),
    'service-creation-signup-key',
    decode(repeat('cd', 32), 'hex'),
    decode(repeat('ef', 32), 'hex'),
    gen_random_uuid()
  )
)
UPDATE create_service_context AS context
SET user_id = created.user_id,
    tenant_id = created.tenant_id
FROM created;

RESET ROLE;

-- Catalogue and provider readiness are control-plane fixtures. Seed them with
-- the migration principal because the catalogue tables FORCE RLS and expose no
-- write policy to the non-login dhumi_owner role.

INSERT INTO app.launch_evidence (
  id, evidence_code, scope_type, scope_key, state, restricted_reference,
  effective_at, approved_by, approved_at
)
SELECT template_evidence_id, 'service-template-fixture', 'template', template_id::text,
  'approved', 'restricted-template-evidence', clock_timestamp() - interval '1 hour',
  'fixture-operator', clock_timestamp() - interval '1 hour'
FROM create_service_context
UNION ALL
SELECT mapping_evidence_id, 'service-mapping-fixture', 'mapping', mapping_id::text,
  'approved', 'restricted-mapping-evidence', clock_timestamp() - interval '1 hour',
  'fixture-operator', clock_timestamp() - interval '1 hour'
FROM create_service_context;

INSERT INTO app.adapter_definitions (id, code, product_family)
SELECT adapter_definition_id, 'service-fixture-adapter', 'marketplace_dataset'
FROM create_service_context;

INSERT INTO app.adapter_versions (
  id, adapter_definition_id, semantic_version, capability_metadata,
  request_schema, result_schema, error_schema, code_artifact_digest, state
)
SELECT adapter_version_id, adapter_definition_id, '1.0.0', '{}'::jsonb,
  '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
  decode(repeat('12', 32), 'hex'), 'enabled'
FROM create_service_context;

INSERT INTO app.service_templates (id, slug, product_family, state)
SELECT template_id, 'service-creation-fixture', 'marketplace_dataset', 'draft'
FROM create_service_context;

INSERT INTO app.service_template_versions (
  id, service_template_id, version, public_name, public_description,
  input_schema, output_schema, availability_copy, availability_state,
  adapter_version_id, launch_evidence_id, effective_at, published_at
)
SELECT template_version_id, template_id, 1, 'Service fixture',
  'Rollback-only Service creation fixture',
  '{"type":"object","additionalProperties":false,"required":["query"],"properties":{"query":{"type":"string","minLength":1}}}'::jsonb,
  '{"type":"object"}'::jsonb,
  'Available', 'available', adapter_version_id, template_evidence_id,
  clock_timestamp() - interval '1 hour', clock_timestamp() - interval '1 hour'
FROM create_service_context;

UPDATE app.service_templates AS template
SET state = 'published',
    current_public_version_id = context.template_version_id
FROM create_service_context AS context
WHERE template.id = context.template_id;

INSERT INTO app.provider_credentials (
  id, provider_code, environment, vault_secret_reference, permission_label,
  state, activated_at
)
SELECT provider_credential_id, 'bright_data', 'test',
  'vault://rollback-only/service-fixture', 'service-fixture-read',
  'active', clock_timestamp() - interval '1 hour'
FROM create_service_context;

INSERT INTO app.provider_mappings (
  id, service_template_version_id, adapter_version_id, provider_credential_id,
  environment, operation_code, provider_resource_ciphertext,
  provider_resource_fingerprint, output_policy, commercial_config_version,
  config_version, launch_evidence_id, state
)
SELECT mapping_id, template_version_id, adapter_version_id, provider_credential_id,
  'test', 'marketplace.snapshot', convert_to('private-provider-sentinel', 'UTF8'),
  decode(repeat('34', 32), 'hex'), '{}'::jsonb, 'fixture-v1',
  'fixture-v1', mapping_evidence_id, 'enabled'
FROM create_service_context;

RESET ROLE;
SET LOCAL ROLE dhumi_admission;
SELECT set_config(
  'app.tenant_id',
  (SELECT tenant_id::text FROM create_service_context),
  true
);

SELECT pg_temp.assert_true(
  has_column_privilege(current_user, 'app.provider_mappings', 'id', 'SELECT'),
  'admission must read mapping linkage metadata'
);
SELECT pg_temp.assert_true(
  NOT has_column_privilege(current_user, 'app.provider_mappings', 'provider_resource_ciphertext', 'SELECT')
  AND NOT has_column_privilege(current_user, 'app.provider_mappings', 'provider_resource_fingerprint', 'SELECT')
  AND NOT has_column_privilege(current_user, 'app.provider_mappings', 'provider_credential_id', 'SELECT'),
  'admission must not read provider resource or credential identity'
);

INSERT INTO app.idempotency_records (
  id, tenant_id, scope_kind, actor_fingerprint, operation_code,
  idempotency_key, request_hash, state, expires_at
)
SELECT claim_id, tenant_id, 'tenant',
  decode(repeat('56', 32), 'hex'),
  'services.create', idempotency_key,
  decode(repeat('78', 32), 'hex'), 'in_progress',
  clock_timestamp() + interval '24 hours'
FROM create_service_context;

INSERT INTO app.services (
  id, tenant_id, service_template_id, name, state, current_version
)
SELECT service_id, tenant_id, template_id, 'Exact Service name', 'active', 1
FROM create_service_context;

INSERT INTO app.service_versions (
  id, tenant_id, service_id, version, service_template_version_id,
  validated_configuration, schema_hash, created_by_user_id,
  created_by_api_key_id
)
SELECT service_version_id, tenant_id, service_id, 1, template_version_id,
  '{"query":"laptop"}'::jsonb,
  decode(repeat('9a', 32), 'hex'),
  user_id, NULL
FROM create_service_context;

INSERT INTO app.audit_events (
  tenant_id, actor_user_id, actor_api_key_id, action, target_type, target_id,
  outcome, request_id, ip_fingerprint, safe_diff
)
SELECT tenant_id, user_id, NULL, 'services.create', 'service', service_id,
  'created', gen_random_uuid(), decode(repeat('bc', 32), 'hex'),
  jsonb_build_object(
    'name', 'Exact Service name',
    'template_slug', 'service-creation-fixture',
    'template_version', 1,
    'family', 'marketplace_dataset',
    'service_version', 1
  )
FROM create_service_context;

UPDATE app.idempotency_records AS claim
SET state = 'completed',
    response_status = 201,
    resource_type = 'service',
    resource_id = context.service_id,
    response_body_reference = 'inline_json_v1',
    response_body = jsonb_build_object(
      'id', context.service_id,
      'name', 'Exact Service name',
      'template_slug', 'service-creation-fixture',
      'template_version', 1,
      'version', 1,
      'family', 'marketplace_dataset',
      'state', 'active',
      'configuration', jsonb_build_object('query', 'laptop'),
      'created_at', service.created_at
    ),
    completed_at = clock_timestamp(),
    updated_at = clock_timestamp()
FROM create_service_context AS context
INNER JOIN app.services AS service
  ON service.tenant_id = context.tenant_id
 AND service.id = context.service_id
WHERE claim.id = context.claim_id;

-- The admission login intentionally carries a pg_catalog-only search path, so
-- force every deferred invariant without relying on unqualified name lookup.
SET CONSTRAINTS ALL IMMEDIATE;

SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM app.services),
  'one Service must be visible to its Tenant'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM app.service_versions),
  'one immutable Service version must be visible to its Tenant'
);
SELECT pg_temp.assert_true(
  NOT has_table_privilege(current_user, 'app.audit_events', 'SELECT'),
  'admission must write safe audit evidence without gaining audit read access'
);
SELECT pg_temp.assert_true(
  (
    SELECT response_body -> 'configuration' = '{"query":"laptop"}'::jsonb
      AND expires_at > completed_at
    FROM app.idempotency_records
    WHERE operation_code = 'services.create'
  ),
  'completed replay must retain the exact safe configuration body'
);
DO $$
BEGIN
  BEGIN
    INSERT INTO app.service_versions (
      tenant_id, service_id, version, service_template_version_id,
      validated_configuration, schema_hash, created_by_user_id
    )
    SELECT tenant_id, service_id, 2, template_version_id,
      '[]'::jsonb, decode(repeat('de', 32), 'hex'), user_id
    FROM create_service_context;
    RAISE EXCEPTION 'expected non-object configuration rejection';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END;
$$;

RESET ROLE;

-- Inspect the write through the rollback-only migration principal because the
-- admission role is intentionally denied audit read access.
SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
    FROM app.audit_events AS audit
    INNER JOIN create_service_context AS context
      ON audit.tenant_id = context.tenant_id
     AND audit.target_id = context.service_id
    WHERE audit.action = 'services.create'
  ),
  'one Service audit event must commit with the resource'
);
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM app.audit_events AS audit
    INNER JOIN create_service_context AS context
      ON audit.tenant_id = context.tenant_id
     AND audit.target_id = context.service_id
    WHERE audit.safe_diff::text LIKE '%private-provider-sentinel%'
  ),
  'provider-private values must never enter audit evidence'
);

SET LOCAL ROLE dhumi_admission;
SELECT set_config('app.tenant_id', '', true);

SELECT pg_temp.assert_true(
  (SELECT count(*) = 0 FROM app.services),
  'Service RLS must fail closed without Tenant context'
);

RESET ROLE;
ROLLBACK;
