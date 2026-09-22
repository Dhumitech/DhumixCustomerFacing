-- Privileged, rollback-only proof for Pattern 4 migration 0030.
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

CREATE TEMP TABLE p4r_context (
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  mapping_id uuid NOT NULL,
  adapter_id uuid NOT NULL,
  original_event_id uuid NOT NULL
);
INSERT INTO p4r_context VALUES (
  '75000000-0000-4000-8000-000000000001',
  '75000000-0000-4000-8000-000000000002',
  '75000000-0000-4000-8000-000000000003',
  '75000000-0000-4000-8000-000000000004',
  '75000000-0000-4000-8000-000000000005'
);
GRANT SELECT ON p4r_context TO dhumi_operator;

CREATE TEMP TABLE p4r_recoveries (
  label text NOT NULL,
  recovery_event_id uuid,
  scheduled boolean NOT NULL,
  terminal boolean NOT NULL
);
GRANT SELECT, INSERT ON p4r_recoveries TO dhumi_operator;

INSERT INTO app.users (id, email_normalized, password_hash) VALUES (
  '75000000-0000-4000-8000-000000000006',
  'pattern4-reconciliation@example.test',
  '$argon2id$test'
);
INSERT INTO app.tenants (id, display_name) VALUES (
  (SELECT tenant_id FROM p4r_context),
  'Pattern 4 Reconciliation Tenant'
);
INSERT INTO app.tenant_user_access (tenant_id, user_id) VALUES (
  (SELECT tenant_id FROM p4r_context),
  '75000000-0000-4000-8000-000000000006'
);

INSERT INTO app.launch_evidence (
  id, evidence_code, scope_type, scope_key, state, restricted_reference,
  effective_at, approved_by, approved_at
) VALUES
  ('75000000-0000-4000-8000-000000000007', 'p4r-template', 'template', 'p4r',
   'approved', 'restricted:p4r-template', clock_timestamp() - interval '1 hour',
   'test', clock_timestamp() - interval '1 hour'),
  ('75000000-0000-4000-8000-000000000008', 'p4r-mapping', 'mapping', 'p4r',
   'approved', 'restricted:p4r-mapping', clock_timestamp() - interval '1 hour',
   'test', clock_timestamp() - interval '1 hour'),
  ('75000000-0000-4000-8000-000000000009', 'p4r-feature', 'feature', 'p4r',
   'approved', 'restricted:p4r-feature', clock_timestamp() - interval '1 hour',
   'test', clock_timestamp() - interval '1 hour');

INSERT INTO app.feature_flags (
  id, feature_code, environment, state, launch_evidence_id, changed_by, changed_reason
) VALUES (
  '75000000-0000-4000-8000-00000000000a', 'scraper_library', 'test', 'enabled',
  '75000000-0000-4000-8000-000000000009', 'test', 'rollback-only proof'
);

INSERT INTO app.adapter_definitions (id, code, product_family) VALUES (
  '75000000-0000-4000-8000-00000000000b',
  'pattern4-reconciliation', 'scraper_library'
);
INSERT INTO app.adapter_versions (
  id, adapter_definition_id, semantic_version, code_artifact_digest, state
) VALUES (
  (SELECT adapter_id FROM p4r_context),
  '75000000-0000-4000-8000-00000000000b', '1.0.0-test',
  decode(repeat('41', 32), 'hex'), 'enabled'
);

INSERT INTO app.service_templates (id, slug, product_family, state) VALUES (
  '75000000-0000-4000-8000-00000000000c',
  'pattern4-reconciliation', 'scraper_library', 'draft'
);
INSERT INTO app.service_template_versions (
  id, service_template_id, version, public_name, public_description,
  input_schema, configuration_schema, output_schema, presentation_metadata,
  availability_copy, availability_state, adapter_version_id,
  launch_evidence_id, effective_at, published_at
) VALUES (
  '75000000-0000-4000-8000-00000000000d',
  '75000000-0000-4000-8000-00000000000c', 1,
  'Pattern 4 reconciliation', 'Rollback-only resilience proof',
  '{"type":"object","additionalProperties":false}'::jsonb,
  '{"type":"object","additionalProperties":false}'::jsonb,
  '{"type":"object"}'::jsonb,
  '{"domain_slug":"amazon","domain_name":"Amazon","category":"web-data","icon_key":"amazon","operation_group":"Products","operation_name":"Reconciliation","display_priority":101}'::jsonb,
  'Test only', 'available', (SELECT adapter_id FROM p4r_context),
  '75000000-0000-4000-8000-000000000007',
  clock_timestamp() - interval '1 hour', clock_timestamp() - interval '1 hour'
);
UPDATE app.service_templates
SET state = 'published',
    current_public_version_id = '75000000-0000-4000-8000-00000000000d'
WHERE id = '75000000-0000-4000-8000-00000000000c';

INSERT INTO app.provider_credentials (
  id, provider_code, environment, vault_secret_reference, permission_label,
  state, activated_at
) VALUES (
  '75000000-0000-4000-8000-00000000000e', 'bright_data', 'test',
  'vault://test-only/p4r', 'test-only', 'active', clock_timestamp()
);
INSERT INTO app.provider_mappings (
  id, service_template_version_id, adapter_version_id, provider_credential_id,
  environment, operation_code, provider_resource_ciphertext,
  provider_resource_fingerprint, output_policy, commercial_config_version,
  config_version, launch_evidence_id, state
) VALUES (
  (SELECT mapping_id FROM p4r_context),
  '75000000-0000-4000-8000-00000000000d',
  (SELECT adapter_id FROM p4r_context),
  '75000000-0000-4000-8000-00000000000e', 'test',
  'amazon.products.collect_by_url', convert_to('private-test-only', 'UTF8'),
  decode(repeat('42', 32), 'hex'), '{}'::jsonb, 'test-v1', 'test-v1',
  '75000000-0000-4000-8000-000000000008', 'enabled'
);

INSERT INTO app.services (
  id, tenant_id, service_template_id, name, state, current_version
) VALUES (
  '75000000-0000-4000-8000-00000000000f',
  (SELECT tenant_id FROM p4r_context),
  '75000000-0000-4000-8000-00000000000c',
  'Pattern 4 Reconciliation Service', 'active', 1
);
INSERT INTO app.service_versions (
  id, tenant_id, service_id, version, service_template_version_id,
  validated_configuration, schema_hash, created_by_user_id
) VALUES (
  '75000000-0000-4000-8000-000000000010',
  (SELECT tenant_id FROM p4r_context),
  '75000000-0000-4000-8000-00000000000f', 1,
  '75000000-0000-4000-8000-00000000000d', '{}'::jsonb,
  decode(repeat('43', 32), 'hex'),
  '75000000-0000-4000-8000-000000000006'
);

INSERT INTO app.runs (
  id, tenant_id, service_version_id, service_template_version_id,
  adapter_version_id, provider_mapping_id, commercial_config_version,
  validated_input, template_launch_evidence_id, mapping_launch_evidence_id,
  feature_flag_id, feature_launch_evidence_id, public_status,
  internal_status, state_version, retryable
) VALUES (
  (SELECT run_id FROM p4r_context), (SELECT tenant_id FROM p4r_context),
  '75000000-0000-4000-8000-000000000010',
  '75000000-0000-4000-8000-00000000000d',
  (SELECT adapter_id FROM p4r_context), (SELECT mapping_id FROM p4r_context),
  'test-v1', '{}'::jsonb,
  '75000000-0000-4000-8000-000000000007',
  '75000000-0000-4000-8000-000000000008',
  '75000000-0000-4000-8000-00000000000a',
  '75000000-0000-4000-8000-000000000009',
  'queued', 'QUEUED', 1, false
);
INSERT INTO app.run_events (
  id, tenant_id, run_id, sequence, event_type, source,
  event_idempotency_key, safe_payload
) VALUES (
  '75000000-0000-4000-8000-000000000011',
  (SELECT tenant_id FROM p4r_context), (SELECT run_id FROM p4r_context),
  1, 'accepted', 'admission', 'admission.accepted.v1', '{"status":"queued"}'::jsonb
);
INSERT INTO app.outbox_events (
  id, aggregate_type, aggregate_id, tenant_id, topic, ordering_key,
  payload, schema_version, published_at
) VALUES (
  (SELECT original_event_id FROM p4r_context), 'run',
  (SELECT run_id FROM p4r_context), (SELECT tenant_id FROM p4r_context),
  'jobs.execute', (SELECT run_id::text FROM p4r_context),
  jsonb_build_object('run_id', (SELECT run_id FROM p4r_context)),
  1, clock_timestamp()
);

SELECT pg_temp.assert_true(
  has_function_privilege(
    'dhumi_operator',
    'app.recover_dead_lettered_run_command(uuid,text)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'dhumi_customer_api',
    'app.recover_dead_lettered_run_command(uuid,text)',
    'EXECUTE'
  ),
  'only the operator capability may request DLQ recovery'
);

SET LOCAL ROLE dhumi_operator;
INSERT INTO p4r_recoveries
SELECT 'first', result.*
FROM app.recover_dead_lettered_run_command(
  (SELECT original_event_id FROM p4r_context),
  'transient_infrastructure_recovered'
) AS result;
INSERT INTO p4r_recoveries
SELECT 'same-original', result.*
FROM app.recover_dead_lettered_run_command(
  (SELECT original_event_id FROM p4r_context),
  'transient_infrastructure_recovered'
) AS result;
RESET ROLE;

SELECT pg_temp.assert_true(
  (SELECT scheduled FROM p4r_recoveries WHERE label = 'first')
  AND NOT (SELECT scheduled FROM p4r_recoveries WHERE label = 'same-original')
  AND (SELECT recovery_event_id FROM p4r_recoveries WHERE label = 'first') =
      (SELECT recovery_event_id FROM p4r_recoveries WHERE label = 'same-original'),
  'the exact dead-letter request must be idempotent'
);

UPDATE app.outbox_events
SET published_at = clock_timestamp(), updated_at = clock_timestamp()
WHERE id = (SELECT recovery_event_id FROM p4r_recoveries WHERE label = 'first');

SET LOCAL ROLE dhumi_operator;
INSERT INTO p4r_recoveries
SELECT 'recovery-of-recovery', result.*
FROM app.recover_dead_lettered_run_command(
  (SELECT recovery_event_id FROM p4r_recoveries WHERE label = 'first'),
  'configuration_repaired'
) AS result;
INSERT INTO p4r_recoveries
SELECT 'same-recovery', result.*
FROM app.recover_dead_lettered_run_command(
  (SELECT recovery_event_id FROM p4r_recoveries WHERE label = 'first'),
  'configuration_repaired'
) AS result;
RESET ROLE;

SELECT pg_temp.assert_true(
  (SELECT scheduled FROM p4r_recoveries WHERE label = 'recovery-of-recovery')
  AND NOT (SELECT scheduled FROM p4r_recoveries WHERE label = 'same-recovery')
  AND (SELECT recovery_event_id FROM p4r_recoveries WHERE label = 'recovery-of-recovery') <>
      (SELECT recovery_event_id FROM p4r_recoveries WHERE label = 'first')
  AND (SELECT recovery_event_id FROM p4r_recoveries WHERE label = 'recovery-of-recovery') =
      (SELECT recovery_event_id FROM p4r_recoveries WHERE label = 'same-recovery')
  AND (SELECT count(*) FROM app.outbox_events
       WHERE aggregate_id = (SELECT run_id FROM p4r_context)
         AND topic = 'jobs.recover') = 2
  AND (SELECT count(*) FROM app.outbox_events
       WHERE aggregate_id = (SELECT run_id FROM p4r_context)
         AND topic = 'jobs.recover'
         AND published_at IS NULL) = 1,
  'a dead-lettered recovery command must create one new pending recovery command'
);

ROLLBACK;
