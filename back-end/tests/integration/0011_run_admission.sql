-- Privileged, rollback-only proof for migration 0018 and one accepted Run.
\set ON_ERROR_STOP on

BEGIN;
SET CONSTRAINTS ALL DEFERRED;

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

CREATE TEMP TABLE run_admission_context (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  service_id uuid NOT NULL,
  service_version_id uuid NOT NULL,
  template_version_id uuid NOT NULL,
  adapter_version_id uuid NOT NULL,
  mapping_id uuid NOT NULL,
  template_evidence_id uuid NOT NULL,
  mapping_evidence_id uuid NOT NULL,
  feature_flag_id uuid NOT NULL,
  feature_evidence_id uuid NOT NULL,
  run_id uuid NOT NULL,
  claim_id uuid NOT NULL
);

INSERT INTO run_admission_context VALUES (
  '73000000-0000-4000-8000-000000000001',
  '73000000-0000-4000-8000-000000000002',
  '73000000-0000-4000-8000-000000000003',
  '73000000-0000-4000-8000-000000000004',
  '73000000-0000-4000-8000-000000000005',
  '73000000-0000-4000-8000-000000000006',
  '73000000-0000-4000-8000-000000000007',
  '73000000-0000-4000-8000-000000000008',
  '73000000-0000-4000-8000-000000000009',
  '73000000-0000-4000-8000-00000000000a',
  '73000000-0000-4000-8000-00000000000b',
  '73000000-0000-4000-8000-00000000000c',
  '73000000-0000-4000-8000-00000000000d'
);

-- The runtime role receives only the identifiers needed by this transaction-
-- local proof. The temporary table and its rows disappear on rollback.
GRANT SELECT ON run_admission_context TO dhumi_admission;

-- Superuser-only fixture setup avoids weakening forced RLS or granting the
-- runtime any catalogue/provider write capability.
INSERT INTO app.users (id, email_normalized, password_hash)
SELECT user_id, 'run-admission-sql@example.test', '$argon2id$test-only'
FROM run_admission_context;

INSERT INTO app.tenants (id, display_name)
SELECT tenant_id, 'Run admission SQL proof' FROM run_admission_context;

INSERT INTO app.tenant_user_access (tenant_id, user_id)
SELECT tenant_id, user_id FROM run_admission_context;

INSERT INTO app.launch_evidence (
  id, evidence_code, scope_type, scope_key, state, restricted_reference,
  effective_at, approved_by, approved_at
)
SELECT template_evidence_id, 'run-admission-template', 'template',
  template_version_id::text, 'approved', 'restricted:test-only-template',
  clock_timestamp() - interval '1 hour', 'test-principal',
  clock_timestamp() - interval '1 hour'
FROM run_admission_context
UNION ALL
SELECT mapping_evidence_id, 'run-admission-mapping', 'mapping',
  mapping_id::text, 'approved', 'restricted:test-only-mapping',
  clock_timestamp() - interval '1 hour', 'test-principal',
  clock_timestamp() - interval '1 hour'
FROM run_admission_context
UNION ALL
SELECT feature_evidence_id, 'run-admission-feature', 'feature',
  feature_flag_id::text, 'approved', 'restricted:test-only-feature',
  clock_timestamp() - interval '1 hour', 'test-principal',
  clock_timestamp() - interval '1 hour'
FROM run_admission_context;

INSERT INTO app.feature_flags (
  id, feature_code, environment, state, launch_evidence_id,
  changed_by, changed_reason
)
SELECT feature_flag_id, 'marketplace_dataset', 'test', 'enabled',
  feature_evidence_id, 'test-principal', 'rollback-only proof'
FROM run_admission_context;

INSERT INTO app.adapter_definitions (id, code, product_family)
VALUES (
  '73000000-0000-4000-8000-00000000000e',
  'run-admission-sql',
  'marketplace_dataset'
);

INSERT INTO app.adapter_versions (
  id, adapter_definition_id, semantic_version, code_artifact_digest, state
)
SELECT adapter_version_id, '73000000-0000-4000-8000-00000000000e',
  '1.0.0', decode(repeat('11', 32), 'hex'), 'enabled'
FROM run_admission_context;

INSERT INTO app.service_templates (id, slug, product_family, state)
VALUES (
  '73000000-0000-4000-8000-00000000000f',
  'run-admission-sql',
  'marketplace_dataset',
  'draft'
);

INSERT INTO app.service_template_versions (
  id, service_template_id, version, public_name, public_description,
  input_schema, output_schema, availability_copy, availability_state,
  adapter_version_id, launch_evidence_id, effective_at, published_at
)
SELECT template_version_id, '73000000-0000-4000-8000-00000000000f', 1,
  'Run SQL proof', 'Rollback-only privileged proof',
  '{"type":"object","additionalProperties":false,"required":["query"],"properties":{"query":{"type":"string"}}}'::jsonb,
  '{"type":"object"}'::jsonb, 'Available', 'available',
  adapter_version_id, template_evidence_id,
  clock_timestamp() - interval '1 hour', clock_timestamp() - interval '1 hour'
FROM run_admission_context;

UPDATE app.service_templates
SET state = 'published',
    current_public_version_id = (
      SELECT template_version_id FROM run_admission_context
    )
WHERE id = '73000000-0000-4000-8000-00000000000f';

INSERT INTO app.provider_credentials (
  id, provider_code, environment, vault_secret_reference, permission_label,
  state, activated_at
) VALUES (
  '73000000-0000-4000-8000-000000000010', 'bright_data', 'test',
  'vault://test-only/run-admission-sql', 'test-only', 'active',
  clock_timestamp() - interval '1 hour'
);

INSERT INTO app.provider_mappings (
  id, service_template_version_id, adapter_version_id, provider_credential_id,
  environment, operation_code, provider_resource_ciphertext,
  provider_resource_fingerprint, output_policy, commercial_config_version,
  config_version, launch_evidence_id, state
)
SELECT mapping_id, template_version_id, adapter_version_id,
  '73000000-0000-4000-8000-000000000010', 'test', 'marketplace.snapshot',
  convert_to('private-test-only', 'UTF8'), decode(repeat('22', 32), 'hex'),
  '{}'::jsonb, 'test-v1', 'test-v1', mapping_evidence_id, 'enabled'
FROM run_admission_context;

INSERT INTO app.services (
  id, tenant_id, service_template_id, name, state, current_version
)
SELECT service_id, tenant_id, '73000000-0000-4000-8000-00000000000f',
  'Run admission Service', 'active', 1
FROM run_admission_context;

INSERT INTO app.service_versions (
  id, tenant_id, service_id, version, service_template_version_id,
  validated_configuration, schema_hash, created_by_user_id,
  created_by_api_key_id
)
SELECT service_version_id, tenant_id, service_id, 1, template_version_id,
  '{"saved":true}'::jsonb, decode(repeat('33', 32), 'hex'), user_id, NULL
FROM run_admission_context;

SET CONSTRAINTS ALL IMMEDIATE;

-- The runtime proves the exact permitted aggregate path.
SET LOCAL ROLE dhumi_admission;
SELECT set_config(
  'app.tenant_id',
  (SELECT tenant_id::text FROM run_admission_context),
  true
);

SELECT pg_temp.assert_true(
  NOT has_column_privilege(
    'dhumi_customer_api', 'app.runs', 'validated_input', 'SELECT'
  ),
  'customer API must not read validated Run input'
);

SELECT pg_temp.assert_true(
  has_column_privilege(current_user, 'app.feature_flags', 'state', 'SELECT')
  AND NOT has_column_privilege(
    current_user, 'app.feature_flags', 'changed_reason', 'SELECT'
  ),
  'admission must receive only release-gate feature metadata'
);

SELECT pg_temp.assert_true(
  app.lock_service_for_run(
    (SELECT service_id FROM run_admission_context)
  ),
  'admission must lock an owned Service without receiving UPDATE privilege'
);

SELECT pg_temp.assert_true(
  NOT has_any_column_privilege(
    current_user, 'app.services', 'UPDATE'
  ),
  'the Service lock must not widen Admission update capability'
);

SELECT pg_temp.assert_true(
  profile_code = 'phase5_mock_admission_v1'
  AND estimated_amount_micros = 0
  AND currency_code = 'USD'
  AND unit = 'mock_run'
  AND evidence_reference = 'phase5_mock_admission_v1',
  'the local/test capacity profile must return exact fixed hold metadata'
)
FROM app.require_phase5_mock_run_capacity('test');

INSERT INTO app.idempotency_records (
  id, tenant_id, scope_kind, actor_fingerprint, operation_code,
  idempotency_key, request_hash, state, expires_at
)
SELECT claim_id, tenant_id, 'tenant', decode(repeat('44', 32), 'hex'),
  'runs.create', 'run-admission-sql-0001', decode(repeat('55', 32), 'hex'),
  'in_progress', clock_timestamp() + interval '24 hours'
FROM run_admission_context;

INSERT INTO app.runs (
  id, tenant_id, service_version_id, service_template_version_id,
  adapter_version_id, provider_mapping_id, commercial_config_version,
  validated_input, template_launch_evidence_id,
  mapping_launch_evidence_id, feature_flag_id, feature_launch_evidence_id,
  public_status, internal_status, state_version, retryable
)
SELECT run_id, tenant_id, service_version_id, template_version_id,
  adapter_version_id, mapping_id, 'test-v1', '{"query":"laptop"}'::jsonb,
  template_evidence_id, mapping_evidence_id, feature_flag_id,
  feature_evidence_id, 'queued', 'QUEUED', 1, false
FROM run_admission_context;

INSERT INTO app.provider_cost_holds (
  id, tenant_id, run_id, provider_code, product_family,
  commercial_config_version, evidence_reference, estimated_amount_micros,
  currency_code, unit, state
)
SELECT '73000000-0000-4000-8000-000000000011', tenant_id, run_id,
  'bright_data', 'marketplace_dataset', 'test-v1',
  'phase5_mock_admission_v1', 0, 'USD', 'mock_run', 'held'
FROM run_admission_context;

INSERT INTO app.run_events (
  id, tenant_id, run_id, sequence, event_type, source,
  event_idempotency_key, safe_payload
)
SELECT '73000000-0000-4000-8000-000000000012', tenant_id, run_id, 1,
  'accepted', 'admission', 'admission.accepted.v1', '{"status":"queued"}'::jsonb
FROM run_admission_context;

INSERT INTO app.audit_events (
  tenant_id, actor_user_id, actor_api_key_id, action, target_type,
  target_id, outcome, request_id, ip_fingerprint, safe_diff
)
SELECT tenant_id, user_id, NULL, 'run.create', 'run', run_id, 'accepted',
  '73000000-0000-4000-8000-000000000013', decode(repeat('66', 32), 'hex'),
  '{"operation":"runs.create","status":"queued","product_family":"marketplace_dataset"}'::jsonb
FROM run_admission_context;

INSERT INTO app.outbox_events (
  id, aggregate_type, aggregate_id, tenant_id, topic, ordering_key,
  payload, schema_version
)
SELECT '73000000-0000-4000-8000-000000000014', 'run', run_id, tenant_id,
  'jobs.execute', run_id::text, jsonb_build_object('run_id', run_id::text), 1
FROM run_admission_context;

UPDATE app.idempotency_records AS claim
SET state = 'completed', response_status = 202, resource_type = 'run',
    resource_id = context.run_id, response_body_reference = 'inline_json_v1',
    response_body = jsonb_build_object(
      'run_id', context.run_id::text,
      'status', 'queued',
      'accepted_at', run.accepted_at::text
    ),
    completed_at = clock_timestamp(), updated_at = clock_timestamp()
FROM run_admission_context AS context
JOIN app.runs AS run ON run.id = context.run_id
WHERE claim.id = context.claim_id;

-- An extra command field must fail at the database boundary.
DO $$
DECLARE
  rejected boolean := false;
  context run_admission_context%ROWTYPE;
BEGIN
  SELECT * INTO context FROM run_admission_context;
  BEGIN
    INSERT INTO app.outbox_events (
      id, aggregate_type, aggregate_id, tenant_id, topic, ordering_key,
      payload, schema_version
    ) VALUES (
      '73000000-0000-4000-8000-000000000015', 'run',
      '73000000-0000-4000-8000-000000000016', context.tenant_id,
      'jobs.execute', '73000000-0000-4000-8000-000000000016',
      '{"run_id":"73000000-0000-4000-8000-000000000016","tenant_id":"forged"}'::jsonb,
      1
    );
  EXCEPTION WHEN check_violation THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'jobs.execute must be Run-ID-only');
END;
$$;

RESET ROLE;

SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM app.runs
   WHERE id = (SELECT run_id FROM run_admission_context)),
  'one accepted Run must exist'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM app.provider_cost_holds
   WHERE run_id = (SELECT run_id FROM run_admission_context)),
  'one cost hold must exist'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM app.run_events
   WHERE run_id = (SELECT run_id FROM run_admission_context)
     AND sequence = 1),
  'one accepted sequence-one event must exist'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM app.outbox_events
   WHERE aggregate_id = (SELECT run_id FROM run_admission_context)
     AND topic = 'jobs.execute'),
  'one safe jobs.execute command must exist'
);

ROLLBACK;
