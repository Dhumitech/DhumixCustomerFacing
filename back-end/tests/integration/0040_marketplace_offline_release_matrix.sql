-- M8: privileged, rollback-only Marketplace execution database matrix.
--
-- This proof creates only customer-disabled fixture state. It exercises no
-- network client, sends no queue command and makes zero provider calls.
\set ON_ERROR_STOP on
\pset pager off

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

CREATE TEMP TABLE m8_context (
  tenant_id uuid NOT NULL,
  other_tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  other_user_id uuid NOT NULL,
  template_id uuid NOT NULL,
  template_version_id uuid NOT NULL,
  template_evidence_id uuid NOT NULL,
  mapping_id uuid NOT NULL,
  mapping_evidence_id uuid NOT NULL,
  feature_flag_id uuid,
  feature_evidence_id uuid,
  adapter_version_id uuid NOT NULL,
  credential_id uuid NOT NULL,
  service_id uuid NOT NULL,
  service_version_id uuid NOT NULL,
  run_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  fence_token uuid NOT NULL,
  raw_artifact_id uuid NOT NULL,
  normalized_artifact_id uuid NOT NULL,
  cost_hold_id uuid NOT NULL,
  outbox_event_id uuid NOT NULL
);

INSERT INTO m8_context (
  tenant_id, other_tenant_id, user_id, other_user_id,
  template_id, template_version_id, template_evidence_id,
  mapping_id, mapping_evidence_id, adapter_version_id, credential_id,
  service_id, service_version_id, run_id, attempt_id, fence_token,
  raw_artifact_id, normalized_artifact_id, cost_hold_id, outbox_event_id
)
SELECT
  '7e000000-0000-4000-8000-000000000001',
  '7e000000-0000-4000-8000-000000000002',
  '7e000000-0000-4000-8000-000000000003',
  '7e000000-0000-4000-8000-000000000004',
  '7e000000-0000-4000-8000-000000000005',
  '7e000000-0000-4000-8000-000000000006',
  '7e000000-0000-4000-8000-000000000007',
  '7e000000-0000-4000-8000-000000000008',
  '7e000000-0000-4000-8000-000000000009',
  adapter.id,
  '7e000000-0000-4000-8000-00000000000a',
  '7e000000-0000-4000-8000-00000000000b',
  '7e000000-0000-4000-8000-00000000000c',
  '7e000000-0000-4000-8000-00000000000d',
  '7e000000-0000-4000-8000-00000000000e',
  '7e000000-0000-4000-8000-00000000000f',
  '7e000000-0000-4000-8000-000000000010',
  '7e000000-0000-4000-8000-000000000011',
  '7e000000-0000-4000-8000-000000000012',
  '7e000000-0000-4000-8000-000000000013'
FROM app.adapter_versions AS adapter
JOIN app.adapter_definitions AS definition
  ON definition.id = adapter.adapter_definition_id
WHERE definition.code = 'bright_data.marketplace.filter'
  AND definition.product_family = 'marketplace_dataset'
  AND adapter.semantic_version = '1.0.0-m7-fixture'
  AND adapter.state = 'disabled';

SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM m8_context),
  'the exact disabled M7 adapter must exist before M8'
);

INSERT INTO app.users (id, email_normalized, password_hash)
SELECT user_id, 'm8-owner@example.test', '$argon2id$test-only'
FROM m8_context
UNION ALL
SELECT other_user_id, 'm8-other@example.test', '$argon2id$test-only'
FROM m8_context;

INSERT INTO app.tenants (id, display_name)
SELECT tenant_id, 'M8 fixture Tenant' FROM m8_context
UNION ALL
SELECT other_tenant_id, 'M8 other Tenant' FROM m8_context;

INSERT INTO app.tenant_user_access (tenant_id, user_id)
SELECT tenant_id, user_id FROM m8_context
UNION ALL
SELECT other_tenant_id, other_user_id FROM m8_context;

INSERT INTO app.launch_evidence (
  id, evidence_code, scope_type, scope_key, state, restricted_reference,
  effective_at, approved_by, approved_at
)
SELECT template_evidence_id, 'm8-template-fixture', 'template',
  template_version_id::text, 'approved', 'restricted:m8-template-fixture',
  clock_timestamp() - interval '1 hour', 'm8-fixture',
  clock_timestamp() - interval '1 hour'
FROM m8_context
UNION ALL
SELECT mapping_evidence_id, 'm8-mapping-fixture', 'mapping',
  mapping_id::text, 'approved', 'restricted:m8-mapping-fixture',
  clock_timestamp() - interval '1 hour', 'm8-fixture',
  clock_timestamp() - interval '1 hour'
FROM m8_context;

-- The Run version-pin constraint requires a family/environment feature flag.
-- Reuse an existing test flag if present; otherwise create a rollback-only one.
INSERT INTO app.launch_evidence (
  id, evidence_code, scope_type, scope_key, state, restricted_reference,
  effective_at, approved_by, approved_at
) VALUES (
  '7e000000-0000-4000-8000-000000000014',
  'm8-feature-fixture', 'feature', 'marketplace_dataset:test', 'approved',
  'restricted:m8-feature-fixture', clock_timestamp() - interval '1 hour',
  'm8-fixture', clock_timestamp() - interval '1 hour'
);

INSERT INTO app.feature_flags (
  id, feature_code, environment, state, launch_evidence_id,
  changed_by, changed_reason
) VALUES (
  '7e000000-0000-4000-8000-000000000015',
  'marketplace_dataset', 'test', 'disabled',
  '7e000000-0000-4000-8000-000000000014',
  'm8-fixture', 'rollback-only customer-disabled proof'
)
ON CONFLICT (feature_code, environment) DO NOTHING;

UPDATE m8_context AS context
SET feature_flag_id = flag.id,
    feature_evidence_id = flag.launch_evidence_id
FROM app.feature_flags AS flag
WHERE flag.feature_code = 'marketplace_dataset'
  AND flag.environment = 'test';

SELECT pg_temp.assert_true(
  (SELECT feature_flag_id IS NOT NULL AND feature_evidence_id IS NOT NULL FROM m8_context),
  'a launch-evidence-bound Marketplace test flag is required'
);

INSERT INTO app.service_templates (id, slug, product_family, state)
SELECT template_id, 'linkedin-posts', 'marketplace_dataset', 'draft'
FROM m8_context;

INSERT INTO app.service_template_versions (
  id, service_template_id, version, public_name, public_description,
  input_schema, configuration_schema, output_schema, presentation_metadata,
  availability_copy, availability_state, adapter_version_id,
  launch_evidence_id, effective_at
)
SELECT
  template_version_id, template_id, 1,
  'M8 LinkedIn Posts fixture', 'Rollback-only Marketplace execution proof',
  '{"type":"object","additionalProperties":false,"required":["records_limit"],"properties":{"records_limit":{"type":"integer","minimum":1,"maximum":100}}}'::jsonb,
  '{"type":"object","additionalProperties":false,"required":["selected_fields","filter"],"properties":{"selected_fields":{"type":"array"},"filter":{"type":"object"}}}'::jsonb,
  '{"type":"array","items":{"type":"object","additionalProperties":false,"properties":{"url":{"type":"string","format":"uri"},"text":{"type":["string","null"]}}}}'::jsonb,
  '{"domain_slug":"linkedin-com","domain_name":"linkedin.com","category":"social","icon_key":"linkedin","operation_group":"LinkedIn","operation_name":"Posts","display_priority":100}'::jsonb,
  'Fixture only', 'coming_soon', adapter_version_id,
  template_evidence_id, clock_timestamp() - interval '1 hour'
FROM m8_context;

INSERT INTO app.provider_credentials (
  id, provider_code, environment, vault_secret_reference,
  permission_label, state
)
SELECT credential_id, 'bright_data', 'test',
  'vault://test-only/m8-never-read', 'fixture-only', 'inactive'
FROM m8_context;

INSERT INTO app.provider_mappings (
  id, service_template_version_id, adapter_version_id,
  provider_credential_id, environment, operation_code,
  provider_resource_ciphertext, provider_resource_fingerprint,
  output_policy, commercial_config_version, config_version,
  launch_evidence_id, state
)
SELECT
  mapping_id, template_version_id, adapter_version_id, credential_id,
  'test', 'marketplace.dataset.filter',
  decode(repeat('a1', 48), 'hex'), decode(repeat('a2', 32), 'hex'),
  '{
    "provider_operation":"filter",
    "transport":"fixture",
    "records_limit_max":100,
    "snapshot":{"format":"json","compress":false},
    "normalizer_code":"marketplace.linkedin-posts.selected-fields",
    "normalizer_version":1,
    "normalized_schema_version":"marketplace.linkedin-posts.output.v1",
    "usage":{"meter_code":"marketplace.result_records.observed","unit":"records"},
    "provider_cost":{"currency_code":"USD"}
  }'::jsonb,
  'm8-fixture-v1', 'm8-fixture-v1', mapping_evidence_id, 'disabled'
FROM m8_context;

INSERT INTO app.services (
  id, tenant_id, service_template_id, name, state, current_version
)
SELECT service_id, tenant_id, template_id, 'M8 fixture Service', 'active', 1
FROM m8_context;

INSERT INTO app.service_versions (
  id, tenant_id, service_id, version, service_template_version_id,
  validated_configuration, schema_hash, created_by_user_id
)
SELECT service_version_id, tenant_id, service_id, 1, template_version_id,
  '{"selected_fields":["url","text"],"filter":{"name":"url","operator":"is_not_null"}}'::jsonb,
  decode(repeat('a3', 32), 'hex'), user_id
FROM m8_context;

INSERT INTO app.runs (
  id, tenant_id, service_version_id, service_template_version_id,
  adapter_version_id, provider_mapping_id, commercial_config_version,
  validated_input, template_launch_evidence_id, mapping_launch_evidence_id,
  feature_flag_id, feature_launch_evidence_id, public_status,
  internal_status, state_version, retryable, started_at
)
SELECT
  run_id, tenant_id, service_version_id, template_version_id,
  adapter_version_id, mapping_id, 'm8-fixture-v1',
  '{"records_limit":2}'::jsonb, template_evidence_id, mapping_evidence_id,
  feature_flag_id, feature_evidence_id, 'running', 'PROCESSING', 3, false,
  clock_timestamp() - interval '5 seconds'
FROM m8_context;

INSERT INTO app.run_attempts (
  id, tenant_id, run_id, attempt_number, kind, state,
  fence_token, worker_lease_expires_at, adapter_version_id,
  provider_mapping_id, provider_credential_id,
  provider_reference_ciphertext, provider_reference_fingerprint
)
SELECT
  attempt_id, tenant_id, run_id, 1, 'submission', 'claimed',
  fence_token, clock_timestamp() + interval '5 minutes', adapter_version_id,
  mapping_id, credential_id, decode(repeat('b1', 48), 'hex'),
  decode(repeat('b2', 32), 'hex')
FROM m8_context;

INSERT INTO app.run_events (
  tenant_id, run_id, sequence, event_type, source, attempt_id,
  event_idempotency_key, safe_payload
)
SELECT tenant_id, run_id, sequence, event_type,
  CASE WHEN sequence = 1 THEN 'admission' ELSE 'job_manager' END,
  attempt_id, 'm8.fixture.' || sequence::text, '{"status":"running"}'::jsonb
FROM m8_context
CROSS JOIN (VALUES
  (1, 'accepted'),
  (2, 'submitted'),
  (3, 'result_received'),
  (4, 'processing')
) AS lifecycle(sequence, event_type);

INSERT INTO app.artifacts (
  id, tenant_id, run_id, attempt_id, kind, artifact_version, object_key,
  content_type, content_encoding, byte_count, checksum, schema_version,
  record_count, state
)
SELECT raw_artifact_id, tenant_id, run_id, attempt_id, 'raw', 1,
  'm8/fixture/raw.json', 'application/json', NULL, 123,
  decode(repeat('c1', 32), 'hex'), NULL, NULL, 'durable'
FROM m8_context
UNION ALL
SELECT normalized_artifact_id, tenant_id, run_id, attempt_id, 'normalized', 1,
  'm8/fixture/normalized.json', 'application/json', NULL, 97,
  decode(repeat('c2', 32), 'hex'),
  'marketplace.linkedin-posts.output.v1', 2, 'validated'
FROM m8_context;

INSERT INTO app.provider_cost_holds (
  id, tenant_id, run_id, provider_code, product_family,
  commercial_config_version, evidence_reference, estimated_amount_micros,
  currency_code, unit, state
)
SELECT cost_hold_id, tenant_id, run_id, 'bright_data', 'marketplace_dataset',
  'm8-fixture-v1', 'fixture:m8-cost-ceiling', 5000,
  'USD', 'records', 'held'
FROM m8_context;

INSERT INTO app.outbox_events (
  id, aggregate_type, aggregate_id, tenant_id, topic, ordering_key,
  payload, schema_version, published_at, delivery_attempts
)
SELECT outbox_event_id, 'run', run_id, tenant_id, 'jobs.execute', run_id::text,
  jsonb_build_object('run_id', run_id::text), 1,
  clock_timestamp() - interval '4 seconds', 1
FROM m8_context;

SET CONSTRAINTS ALL IMMEDIATE;
GRANT SELECT ON m8_context TO dhumi_job_manager;

SET LOCAL ROLE dhumi_job_manager;
SELECT set_config('app.tenant_id', (SELECT tenant_id::text FROM m8_context), true);

SELECT pg_temp.assert_true(
  (SELECT adapter_code = 'bright_data.marketplace.filter'
   FROM app.resolve_provider_executor_kind(
     (SELECT run_id FROM m8_context),
     (SELECT attempt_id FROM m8_context),
     (SELECT fence_token FROM m8_context)
   )),
  'the immutable adapter identity must select the Marketplace executor'
);

-- Emit predicate-level evidence so a future contract drift identifies the
-- exact failed release invariant without exposing any protected value.
RESET ROLE;
CREATE TEMP TABLE m8_plan_diagnostics AS
SELECT jsonb_build_object(
  'run_state_allowed', run.internal_status IN ('SUBMITTED', 'PROCESSING'),
  'attempt_claimed', owner_attempt.state = 'claimed',
  'lease_current', owner_attempt.worker_lease_expires_at > clock_timestamp(),
  'adapter_pinned', owner_attempt.adapter_version_id = run.adapter_version_id,
  'mapping_pinned', owner_attempt.provider_mapping_id = run.provider_mapping_id,
  'adapter_code_exact', definition.code = 'bright_data.marketplace.filter',
  'family_exact', definition.product_family = 'marketplace_dataset',
  'adapter_version_exact', adapter.semantic_version = '1.0.0-m7-fixture',
  'adapter_disabled', adapter.state = 'disabled',
  'transport_offline', adapter.capability_metadata @> '{"transport":"fixture","provider_http_enabled":false}'::jsonb,
  'mapping_disabled', mapping.state = 'disabled',
  'mapping_test_only', mapping.environment = 'test',
  'mapping_adapter_pinned', mapping.adapter_version_id = run.adapter_version_id,
  'mapping_template_pinned', mapping.service_template_version_id = run.service_template_version_id,
  'mapping_credential_pinned', mapping.provider_credential_id = credential.id,
  'credential_inactive', credential.state = 'inactive',
  'credential_provider_exact', credential.provider_code = 'bright_data',
  'credential_environment_exact', credential.environment = 'test',
  'source_is_submission', owner_attempt.kind = 'submission',
  'source_is_owner', owner_attempt.run_id = run.id,
  'tenant_context_exact', run.tenant_id = current_setting('app.tenant_id', true)::uuid,
  'service_version_join', EXISTS (
    SELECT 1 FROM app.service_versions AS service_version
    WHERE service_version.tenant_id = run.tenant_id
      AND service_version.id = run.service_version_id
      AND service_version.service_template_version_id = run.service_template_version_id
  ),
  'template_version_join', EXISTS (
    SELECT 1 FROM app.service_template_versions AS template_version
    JOIN app.service_templates AS template
      ON template.id = template_version.service_template_id
    WHERE template_version.id = run.service_template_version_id
  ),
  'policy_offline', mapping.output_policy @> '{"provider_operation":"filter","transport":"fixture"}'::jsonb
) AS evidence
FROM m8_context AS context
JOIN app.runs AS run ON run.id = context.run_id
JOIN app.run_attempts AS owner_attempt ON owner_attempt.id = context.attempt_id
JOIN app.adapter_versions AS adapter ON adapter.id = run.adapter_version_id
JOIN app.adapter_definitions AS definition ON definition.id = adapter.adapter_definition_id
JOIN app.provider_mappings AS mapping ON mapping.id = run.provider_mapping_id
JOIN app.provider_credentials AS credential ON credential.id = owner_attempt.provider_credential_id;
GRANT SELECT ON m8_context, m8_plan_diagnostics TO dhumi_owner;
GRANT SELECT ON m8_plan_diagnostics TO dhumi_job_manager;

SET LOCAL ROLE dhumi_owner;
SELECT set_config('app.tenant_id', (SELECT tenant_id::text FROM m8_context), true);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM app.runs WHERE id = (SELECT run_id FROM m8_context)),
  'the definer must see the Tenant-owned Run through forced RLS'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM app.run_attempts WHERE id = (SELECT attempt_id FROM m8_context)),
  'the definer must see the Tenant-owned Attempt through forced RLS'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM app.service_versions WHERE id = (SELECT service_version_id FROM m8_context)),
  'the definer must see the Tenant-owned Service version through forced RLS'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM app.service_templates WHERE id = (SELECT template_id FROM m8_context)),
  'the definer must see the exact draft LinkedIn Posts Template through forced RLS'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM app.service_template_versions WHERE id = (SELECT template_version_id FROM m8_context)),
  'the definer must see the exact disabled fixture Template version through forced RLS'
);

SET LOCAL ROLE dhumi_job_manager;
SELECT set_config('app.tenant_id', (SELECT tenant_id::text FROM m8_context), true);

SELECT pg_temp.assert_true(
  (SELECT count(*) = 1
   FROM app.resolve_marketplace_execution_plan_fixture(
     (SELECT run_id FROM m8_context),
     (SELECT attempt_id FROM m8_context),
     (SELECT fence_token FROM m8_context),
     false,
     NULL
   )),
  'the owned fenced fixture plan must resolve exactly once; predicates=' ||
    COALESCE((SELECT evidence::text FROM m8_plan_diagnostics), 'core join missing')
);

SELECT set_config('app.tenant_id', (SELECT other_tenant_id::text FROM m8_context), true);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 0
   FROM app.resolve_marketplace_execution_plan_fixture(
     (SELECT run_id FROM m8_context),
     (SELECT attempt_id FROM m8_context),
     (SELECT fence_token FROM m8_context),
     false,
     NULL
   )),
  'a different Tenant must not discover the fixture execution plan'
);

SELECT set_config('app.tenant_id', (SELECT tenant_id::text FROM m8_context), true);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 0
   FROM app.resolve_marketplace_execution_plan_fixture(
     (SELECT run_id FROM m8_context),
     (SELECT attempt_id FROM m8_context),
     gen_random_uuid(),
     false,
     NULL
   )),
  'a stale fence must not resolve the fixture execution plan'
);

SELECT * FROM app.checkpoint_provider_poll_fenced(
  (SELECT run_id FROM m8_context),
  (SELECT attempt_id FROM m8_context),
  (SELECT fence_token FROM m8_context),
  (SELECT attempt_id FROM m8_context),
  60000, 'scheduled', false, 1000
);

RESET ROLE;

SELECT pg_temp.assert_true(
  (SELECT provider_poll_deadline IS NOT NULL
     AND provider_next_poll_at IS NOT NULL
     AND provider_last_status = 'scheduled'
     AND provider_consecutive_failures = 0
   FROM app.run_attempts
   WHERE id = (SELECT attempt_id FROM m8_context)),
  'the first poll checkpoint must be durable in PostgreSQL'
);

CREATE TEMP TABLE m8_first_deadline AS
SELECT provider_poll_deadline
FROM app.run_attempts
WHERE id = (SELECT attempt_id FROM m8_context);
GRANT SELECT ON m8_first_deadline TO dhumi_job_manager;

-- Re-entering the restricted role simulates a fresh worker transaction. The
-- deadline must be reused rather than restarted.
SET LOCAL ROLE dhumi_job_manager;
SELECT set_config('app.tenant_id', (SELECT tenant_id::text FROM m8_context), true);
SELECT * FROM app.checkpoint_provider_poll_fenced(
  (SELECT run_id FROM m8_context),
  (SELECT attempt_id FROM m8_context),
  (SELECT fence_token FROM m8_context),
  (SELECT attempt_id FROM m8_context),
  60000, 'rate_limited', true, 45000
);
RESET ROLE;

SELECT pg_temp.assert_true(
  (SELECT attempt.provider_poll_deadline = original.provider_poll_deadline
     AND attempt.provider_last_status = 'rate_limited'
     AND attempt.provider_consecutive_failures = 1
   FROM app.run_attempts AS attempt
   CROSS JOIN m8_first_deadline AS original
   WHERE attempt.id = (SELECT attempt_id FROM m8_context)),
  'restart-safe polling must preserve its deadline and failure count'
);

SET LOCAL ROLE dhumi_job_manager;
SELECT set_config('app.tenant_id', (SELECT tenant_id::text FROM m8_context), true);

SELECT pg_temp.assert_true(
  app.record_marketplace_snapshot_observation_fenced(
    (SELECT run_id FROM m8_context),
    (SELECT attempt_id FROM m8_context),
    (SELECT fence_token FROM m8_context),
    (SELECT attempt_id FROM m8_context),
    'ready', 2, 123, 2500, 'USD'
  ),
  'the first terminal Snapshot observation must succeed'
);

SELECT pg_temp.assert_true(
  app.record_marketplace_snapshot_observation_fenced(
    (SELECT run_id FROM m8_context),
    (SELECT attempt_id FROM m8_context),
    (SELECT fence_token FROM m8_context),
    (SELECT attempt_id FROM m8_context),
    'ready', 2, 123, 2500, 'USD'
  ),
  'an exact terminal Snapshot replay must be idempotent'
);

DO $$
DECLARE rejected boolean := false;
BEGIN
  BEGIN
    PERFORM app.record_marketplace_snapshot_observation_fenced(
      (SELECT run_id FROM m8_context),
      (SELECT attempt_id FROM m8_context),
      (SELECT fence_token FROM m8_context),
      (SELECT attempt_id FROM m8_context),
      'ready', 2, 123, 2501, 'USD'
    );
  EXCEPTION WHEN unique_violation THEN
    rejected := SQLERRM = 'MARKETPLACE_SNAPSHOT_OBSERVATION_REPLAY_CONFLICT';
  END;
  PERFORM pg_temp.assert_true(rejected, 'a conflicting cost replay must fail closed');
END;
$$;

SELECT app.complete_run_execution_with_usage(
  (SELECT run_id FROM m8_context),
  3,
  'm8.fixture.completed',
  (SELECT attempt_id FROM m8_context),
  (SELECT fence_token FROM m8_context),
  'provider_execution_completed',
  (SELECT normalized_artifact_id FROM m8_context),
  'marketplace.result_records.observed',
  'records',
  '{"status":"ready"}'::jsonb
);

RESET ROLE;
SELECT set_config('app.tenant_id', (SELECT tenant_id::text FROM m8_context), true);

SELECT pg_temp.assert_true(
  app.record_success_usage_observation(
    (SELECT run_id FROM m8_context),
    (SELECT attempt_id FROM m8_context),
    (SELECT normalized_artifact_id FROM m8_context),
    'marketplace.result_records.observed',
    'records'
  ) = (
    SELECT id FROM app.usage_events
    WHERE run_id = (SELECT run_id FROM m8_context)
      AND attempt_id = (SELECT attempt_id FROM m8_context)
      AND meter_code = 'marketplace.result_records.observed'
  ),
  'an exact usage replay must reuse the immutable event'
);

SELECT pg_temp.assert_true(
  (SELECT public_status = 'ready'
     AND internal_status = 'COMPLETED'
     AND state_version = 4
     AND retryable IS false
   FROM app.runs WHERE id = (SELECT run_id FROM m8_context))
  AND
  (SELECT state = 'completed'
     AND outcome_class = 'provider_execution_completed'
     AND provider_last_status = 'ready'
     AND provider_dataset_size = 2
     AND provider_file_size = 123
     AND provider_cost_micros = 2500
     AND provider_cost_currency = 'USD'
   FROM app.run_attempts WHERE id = (SELECT attempt_id FROM m8_context)),
  'the fixture Run and Attempt must terminate exactly once'
);

SELECT pg_temp.assert_true(
  (SELECT state = 'finalized'
     AND estimated_amount_micros = 5000
     AND finalized_amount_micros = 2500
     AND currency_code = 'USD'
   FROM app.provider_cost_holds WHERE id = (SELECT cost_hold_id FROM m8_context))
  AND
  (SELECT count(*) = 1
   FROM app.audit_events
   WHERE target_id = (SELECT attempt_id FROM m8_context)
     AND action = 'provider.marketplace_snapshot.observe'),
  'provider cost and its safe observation audit must finalize exactly once'
);

SELECT pg_temp.assert_true(
  (SELECT count(*) = 1
     AND min(quantity) = 2
     AND min(unit) = 'records'
     AND min(outcome) = 'succeeded'
     AND min(source) = 'artifact'
   FROM app.usage_events
   WHERE run_id = (SELECT run_id FROM m8_context)
     AND meter_code = 'marketplace.result_records.observed'),
  'normalized record usage must finalize exactly once'
);

SELECT pg_temp.assert_true(
  (SELECT array_agg(event_type ORDER BY sequence) =
     ARRAY['accepted','submitted','result_received','processing','completed']::text[]
   FROM app.run_events WHERE run_id = (SELECT run_id FROM m8_context))
  AND
  (SELECT count(*) = 1
     AND bool_and(published_at IS NOT NULL)
     AND min(delivery_attempts) = 1
   FROM app.outbox_events
   WHERE id = (SELECT outbox_event_id FROM m8_context)
     AND topic = 'jobs.execute'),
  'the lifecycle and outbox publication evidence must be exact'
);

SELECT pg_temp.assert_true(
  (SELECT count(*) = 2
     AND bool_and(
       (kind = 'raw' AND state = 'durable' AND byte_count = 123
         AND checksum = decode(repeat('c1', 32), 'hex'))
       OR
       (kind = 'normalized' AND state = 'validated' AND byte_count = 97
         AND record_count = 2 AND checksum = decode(repeat('c2', 32), 'hex'))
     )
   FROM app.artifacts WHERE run_id = (SELECT run_id FROM m8_context)),
  'raw and normalized Artifact integrity metadata must remain exact'
);

SELECT pg_temp.assert_true(
  NOT has_column_privilege(
    'dhumi_customer_api', 'app.run_attempts', 'provider_reference_ciphertext', 'SELECT'
  )
  AND NOT has_column_privilege(
    'dhumi_customer_api', 'app.run_attempts', 'provider_reference_fingerprint', 'SELECT'
  )
  AND NOT has_column_privilege(
    'dhumi_customer_api', 'app.provider_mappings', 'provider_resource_ciphertext', 'SELECT'
  ),
  'the Customer API must not read protected provider references'
);

SELECT
  (SELECT public_status FROM app.runs WHERE id = (SELECT run_id FROM m8_context)) AS run_status,
  (SELECT internal_status FROM app.runs WHERE id = (SELECT run_id FROM m8_context)) AS internal_status,
  (SELECT state FROM app.run_attempts WHERE id = (SELECT attempt_id FROM m8_context)) AS attempt_state,
  (SELECT state FROM app.provider_cost_holds WHERE id = (SELECT cost_hold_id FROM m8_context)) AS cost_state,
  (SELECT count(*) FROM app.usage_events WHERE run_id = (SELECT run_id FROM m8_context)) AS usage_events;

ROLLBACK;
