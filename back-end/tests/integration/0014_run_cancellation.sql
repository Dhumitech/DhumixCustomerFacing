-- Privileged, rollback-only proof for migration 0021 and Run cancellation.
-- The migration and every fixture row are rolled back; no Bright Data call or
-- durable cancellation command survives this script.
\set ON_ERROR_STOP on

BEGIN;
SET CONSTRAINTS ALL DEFERRED;

-- Prove the forward migration before the migration runner records it.
\ir ../../scripts/migrations/0021_run_cancellation.sql

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

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 3
    FROM pg_constraint
    WHERE connamespace = 'app'::regnamespace
      AND conname IN (
        'idempotency_records_run_cancel_semantics_check',
        'outbox_events_jobs_cancel_shape_check',
        'run_events_cancellation_requested_shape_check'
      )
  ),
  'migration 0021 must install all operation-specific CHECK constraints'
);

SELECT pg_temp.assert_true(
  to_regclass('app.outbox_events_one_jobs_cancel_per_run_idx') IS NOT NULL
  AND to_regclass('app.run_events_one_cancellation_requested_per_run_idx') IS NOT NULL,
  'migration 0021 must install both one-per-Run partial unique indexes'
);

SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE oid = 'app.lock_run_for_cancellation(uuid)'::regprocedure
      AND prosecdef
      AND proowner = 'dhumi_owner'::regrole
  ),
  'the cancellation lock must be a dhumi_owner SECURITY DEFINER function'
);

SELECT pg_temp.assert_true(
  has_function_privilege(
    'dhumi_admission',
    'app.lock_run_for_cancellation(uuid)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'dhumi_customer_api',
    'app.lock_run_for_cancellation(uuid)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'dhumi_job_manager',
    'app.lock_run_for_cancellation(uuid)',
    'EXECUTE'
  ),
  'only Admission may execute the cancellation lock capability'
);

SELECT pg_temp.assert_true(
  has_function_privilege(
    'dhumi_job_manager',
    'app.transition_run(uuid,bigint,text,text,text,uuid,text,boolean,jsonb)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'dhumi_admission',
    'app.transition_run(uuid,bigint,text,text,text,uuid,text,boolean,jsonb)',
    'EXECUTE'
  ),
  'Run transitions must remain Job-Manager-only'
);

-- Coherent release pins and two Tenants exercise the real forced-RLS graph.
INSERT INTO app.users (id, email_normalized, password_hash) VALUES (
  '75000000-0000-4000-8000-000000000002',
  'run-cancel-a@example.test',
  '$argon2id$test-only'
);

INSERT INTO app.tenants (id, display_name) VALUES
  ('75000000-0000-4000-8000-000000000001', 'Run cancel Tenant A'),
  ('75000000-0000-4000-8000-000000000006', 'Run cancel Tenant B');

INSERT INTO app.tenant_user_access (tenant_id, user_id) VALUES (
  '75000000-0000-4000-8000-000000000001',
  '75000000-0000-4000-8000-000000000002'
);

INSERT INTO app.launch_evidence (
  id, evidence_code, scope_type, scope_key, state, restricted_reference,
  effective_at, approved_by, approved_at
) VALUES
  (
    '75000000-0000-4000-8000-00000000000d', 'run-cancel-template', 'template',
    '75000000-0000-4000-8000-00000000000a', 'approved',
    'restricted:test-only-template', clock_timestamp() - interval '1 hour',
    'test-principal', clock_timestamp() - interval '1 hour'
  ),
  (
    '75000000-0000-4000-8000-00000000000e', 'run-cancel-mapping', 'mapping',
    '75000000-0000-4000-8000-00000000000c', 'approved',
    'restricted:test-only-mapping', clock_timestamp() - interval '1 hour',
    'test-principal', clock_timestamp() - interval '1 hour'
  ),
  (
    '75000000-0000-4000-8000-000000000010', 'run-cancel-feature', 'feature',
    '75000000-0000-4000-8000-00000000000f', 'approved',
    'restricted:test-only-feature', clock_timestamp() - interval '1 hour',
    'test-principal', clock_timestamp() - interval '1 hour'
  );

INSERT INTO app.feature_flags (
  id, feature_code, environment, state, launch_evidence_id,
  changed_by, changed_reason
) VALUES (
  '75000000-0000-4000-8000-00000000000f', 'marketplace_dataset', 'test',
  'enabled', '75000000-0000-4000-8000-000000000010',
  'test-principal', 'rollback-only Run-cancellation proof'
);

INSERT INTO app.adapter_definitions (id, code, product_family) VALUES (
  '75000000-0000-4000-8000-000000000011',
  'run-cancel-sql',
  'marketplace_dataset'
);

INSERT INTO app.adapter_versions (
  id, adapter_definition_id, semantic_version, code_artifact_digest, state
) VALUES (
  '75000000-0000-4000-8000-00000000000b',
  '75000000-0000-4000-8000-000000000011',
  '1.0.0', decode(repeat('11', 32), 'hex'), 'enabled'
);

INSERT INTO app.service_templates (id, slug, product_family, state) VALUES (
  '75000000-0000-4000-8000-000000000012',
  'run-cancel-sql',
  'marketplace_dataset',
  'draft'
);

INSERT INTO app.service_template_versions (
  id, service_template_id, version, public_name, public_description,
  input_schema, output_schema, availability_copy, availability_state,
  adapter_version_id, launch_evidence_id, effective_at, published_at
) VALUES (
  '75000000-0000-4000-8000-00000000000a',
  '75000000-0000-4000-8000-000000000012', 1,
  'Run cancellation SQL proof', 'Rollback-only privileged proof',
  '{"type":"object","additionalProperties":false}'::jsonb,
  '{"type":"object"}'::jsonb, 'Available', 'available',
  '75000000-0000-4000-8000-00000000000b',
  '75000000-0000-4000-8000-00000000000d',
  clock_timestamp() - interval '1 hour', clock_timestamp() - interval '1 hour'
);

UPDATE app.service_templates
SET state = 'published',
    current_public_version_id = '75000000-0000-4000-8000-00000000000a'
WHERE id = '75000000-0000-4000-8000-000000000012';

INSERT INTO app.provider_credentials (
  id, provider_code, environment, vault_secret_reference, permission_label,
  state, activated_at
) VALUES (
  '75000000-0000-4000-8000-000000000013', 'bright_data', 'test',
  'vault://test-only/run-cancel-sql', 'test-only', 'active',
  clock_timestamp() - interval '1 hour'
);

INSERT INTO app.provider_mappings (
  id, service_template_version_id, adapter_version_id, provider_credential_id,
  environment, operation_code, provider_resource_ciphertext,
  provider_resource_fingerprint, output_policy, commercial_config_version,
  config_version, launch_evidence_id, state
) VALUES (
  '75000000-0000-4000-8000-00000000000c',
  '75000000-0000-4000-8000-00000000000a',
  '75000000-0000-4000-8000-00000000000b',
  '75000000-0000-4000-8000-000000000013', 'test',
  'marketplace.snapshot', convert_to('private-test-only', 'UTF8'),
  decode(repeat('22', 32), 'hex'), '{}'::jsonb, 'test-v1', 'test-v1',
  '75000000-0000-4000-8000-00000000000e', 'enabled'
);

INSERT INTO app.services (
  id, tenant_id, service_template_id, name, state, current_version
) VALUES (
  '75000000-0000-4000-8000-000000000003',
  '75000000-0000-4000-8000-000000000001',
  '75000000-0000-4000-8000-000000000012',
  'Run cancel Service A', 'active', 1
);

INSERT INTO app.service_versions (
  id, tenant_id, service_id, version, service_template_version_id,
  validated_configuration, schema_hash, created_by_user_id,
  created_by_api_key_id
) VALUES (
  '75000000-0000-4000-8000-000000000004',
  '75000000-0000-4000-8000-000000000001',
  '75000000-0000-4000-8000-000000000003', 1,
  '75000000-0000-4000-8000-00000000000a', '{"revision":1}'::jsonb,
  decode(repeat('31', 32), 'hex'),
  '75000000-0000-4000-8000-000000000002', NULL
);

SET CONSTRAINTS ALL IMMEDIATE;

INSERT INTO app.runs (
  id, tenant_id, service_version_id, service_template_version_id,
  adapter_version_id, provider_mapping_id, commercial_config_version,
  validated_input, template_launch_evidence_id, mapping_launch_evidence_id,
  feature_flag_id, feature_launch_evidence_id, public_status, internal_status,
  state_version, retryable, customer_error_code, accepted_at, created_at,
  updated_at, completed_at
) VALUES (
  '75000000-0000-4000-8000-000000000021',
  '75000000-0000-4000-8000-000000000001',
  '75000000-0000-4000-8000-000000000004',
  '75000000-0000-4000-8000-00000000000a',
  '75000000-0000-4000-8000-00000000000b',
  '75000000-0000-4000-8000-00000000000c', 'test-v1', '{"query":"a"}',
  '75000000-0000-4000-8000-00000000000d',
  '75000000-0000-4000-8000-00000000000e',
  '75000000-0000-4000-8000-00000000000f',
  '75000000-0000-4000-8000-000000000010', 'queued', 'QUEUED', 1, false,
  NULL, '2026-01-01T12:00:00Z', '2026-01-01T12:00:00Z',
  '2026-01-01T12:00:00Z', NULL
);

INSERT INTO app.run_events (
  id, tenant_id, run_id, sequence, event_type, source,
  event_idempotency_key, safe_payload
) VALUES (
  '75000000-0000-4000-8000-000000000022',
  '75000000-0000-4000-8000-000000000001',
  '75000000-0000-4000-8000-000000000021', 1,
  'accepted', 'admission', 'admission.accepted.v1', '{"status":"queued"}'
);

INSERT INTO app.provider_cost_holds (
  id, tenant_id, run_id, provider_code, product_family,
  commercial_config_version, evidence_reference, estimated_amount_micros,
  currency_code, unit, state
) VALUES (
  '75000000-0000-4000-8000-000000000023',
  '75000000-0000-4000-8000-000000000001',
  '75000000-0000-4000-8000-000000000021', 'bright_data',
  'marketplace_dataset', 'test-v1', 'phase5_mock_admission_v1',
  0, 'USD', 'mock_run', 'held'
);

-- Operation-specific constraints reject extra/private data and false success.
DO $$
BEGIN
  BEGIN
    INSERT INTO app.idempotency_records (
      id, tenant_id, scope_kind, actor_fingerprint, operation_code,
      idempotency_key, request_hash, state, response_status, resource_type,
      resource_id, response_body_reference, response_body, expires_at,
      completed_at
    ) VALUES (
      '75000000-0000-4000-8000-000000000031',
      '75000000-0000-4000-8000-000000000001', 'tenant',
      decode(repeat('41', 32), 'hex'), 'runs.cancel',
      'cancel-invalid-body-0001', decode(repeat('42', 32), 'hex'),
      'completed', 202, 'run', '75000000-0000-4000-8000-000000000021',
      'inline_json_v1',
      '{"id":"75000000-0000-4000-8000-000000000021","service_id":"75000000-0000-4000-8000-000000000003","status":"queued","error_code":null,"retryable":false,"created_at":"2026-01-01T12:00:00.000Z","updated_at":"2026-01-01T12:00:00.000Z","completed_at":null,"provider_id":"forbidden"}'::jsonb,
      clock_timestamp() + interval '24 hours', clock_timestamp()
    );
    RAISE EXCEPTION 'invalid cancellation replay unexpectedly passed';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO app.outbox_events (
      id, aggregate_type, aggregate_id, tenant_id, topic, ordering_key,
      payload, schema_version
    ) VALUES (
      '75000000-0000-4000-8000-000000000032', 'run',
      '75000000-0000-4000-8000-000000000021',
      '75000000-0000-4000-8000-000000000001', 'jobs.cancel',
      '75000000-0000-4000-8000-000000000021',
      '{"run_id":"75000000-0000-4000-8000-000000000021","tenant_id":"forbidden"}',
      1
    );
    RAISE EXCEPTION 'invalid jobs.cancel payload unexpectedly passed';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO app.run_events (
      id, tenant_id, run_id, sequence, event_type, source,
      event_idempotency_key, safe_payload
    ) VALUES (
      '75000000-0000-4000-8000-000000000033',
      '75000000-0000-4000-8000-000000000001',
      '75000000-0000-4000-8000-000000000021', 2,
      'cancellation_requested', 'job_manager',
      'cancel.requested.v1:75000000-0000-4000-8000-000000000031',
      '{"status":"queued"}'
    );
    RAISE EXCEPTION 'invalid cancellation event source unexpectedly passed';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;

SET LOCAL ROLE dhumi_admission;
SELECT set_config('app.tenant_id', '75000000-0000-4000-8000-000000000001', true);

SELECT pg_temp.assert_true(
  (
    SELECT
      run_id = '75000000-0000-4000-8000-000000000021'::uuid
      AND service_version_id = '75000000-0000-4000-8000-000000000004'::uuid
      AND public_status = 'queued'
      AND internal_status = 'QUEUED'
      AND next_event_sequence = 2
      AND NOT cancellation_requested
    FROM app.lock_run_for_cancellation(
      '75000000-0000-4000-8000-000000000021'
    )
  ),
  'Admission must lock and receive only the owned queued Run snapshot'
);

INSERT INTO app.run_events (
  id, tenant_id, run_id, sequence, event_type, source,
  event_idempotency_key, safe_payload
) VALUES (
  '75000000-0000-4000-8000-000000000034',
  '75000000-0000-4000-8000-000000000001',
  '75000000-0000-4000-8000-000000000021', 2,
  'cancellation_requested', 'admission',
  'cancel.requested.v1:75000000-0000-4000-8000-000000000031',
  '{"status":"queued"}'
);

INSERT INTO app.outbox_events (
  id, aggregate_type, aggregate_id, tenant_id, topic, ordering_key,
  payload, schema_version
) VALUES (
  '75000000-0000-4000-8000-000000000035', 'run',
  '75000000-0000-4000-8000-000000000021',
  '75000000-0000-4000-8000-000000000001', 'jobs.cancel',
  '75000000-0000-4000-8000-000000000021',
  '{"run_id":"75000000-0000-4000-8000-000000000021"}', 1
);

SELECT pg_temp.assert_true(
  (
    SELECT next_event_sequence = 3 AND cancellation_requested
    FROM app.lock_run_for_cancellation(
      '75000000-0000-4000-8000-000000000021'
    )
  ),
  'the lock must report existing intent and the next immutable event sequence'
);

DO $$
BEGIN
  BEGIN
    UPDATE app.runs
    SET internal_status = 'CANCELLED', public_status = 'cancelled'
    WHERE id = '75000000-0000-4000-8000-000000000021';
    RAISE EXCEPTION 'Admission unexpectedly updated a Run';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM app.transition_run(
      '75000000-0000-4000-8000-000000000021', 1, 'CANCELLED', 'cancelled',
      'job.cancelled.v1', NULL, NULL, false, '{"status":"cancelled"}'
    );
    RAISE EXCEPTION 'Admission unexpectedly executed transition_run';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE app.provider_cost_holds
    SET state = 'released'
    WHERE run_id = '75000000-0000-4000-8000-000000000021';
    RAISE EXCEPTION 'Admission unexpectedly updated the provider-cost hold';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE app.outbox_events
    SET published_at = clock_timestamp()
    WHERE id = '75000000-0000-4000-8000-000000000035';
    RAISE EXCEPTION 'Admission unexpectedly updated outbox delivery metadata';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    INSERT INTO app.run_events (
      id, tenant_id, run_id, sequence, event_type, source,
      event_idempotency_key, safe_payload
    ) VALUES (
      '75000000-0000-4000-8000-000000000036',
      '75000000-0000-4000-8000-000000000001',
      '75000000-0000-4000-8000-000000000021', 3,
      'cancellation_requested', 'admission',
      'cancel.requested.v1:75000000-0000-4000-8000-000000000036',
      '{"status":"queued"}'
    );
    RAISE EXCEPTION 'second cancellation event unexpectedly passed';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO app.outbox_events (
      id, aggregate_type, aggregate_id, tenant_id, topic, ordering_key,
      payload, schema_version
    ) VALUES (
      '75000000-0000-4000-8000-000000000037', 'run',
      '75000000-0000-4000-8000-000000000021',
      '75000000-0000-4000-8000-000000000001', 'jobs.cancel',
      '75000000-0000-4000-8000-000000000021',
      '{"run_id":"75000000-0000-4000-8000-000000000021"}', 1
    );
    RAISE EXCEPTION 'second jobs.cancel command unexpectedly passed';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;
END;
$$;

RESET ROLE;
SET LOCAL ROLE dhumi_admission;
SELECT set_config('app.tenant_id', '75000000-0000-4000-8000-000000000006', true);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM app.lock_run_for_cancellation(
      '75000000-0000-4000-8000-000000000021'
    )
  ),
  'Admission must not lock another Tenant Run'
);

RESET ROLE;
SET LOCAL ROLE dhumi_admission;
SELECT set_config('app.tenant_id', '', true);

DO $$
BEGIN
  BEGIN
    PERFORM *
    FROM app.lock_run_for_cancellation(
      '75000000-0000-4000-8000-000000000021'
    );
    RAISE EXCEPTION 'cancellation lock unexpectedly accepted no Tenant context';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;

RESET ROLE;
SET LOCAL ROLE dhumi_job_manager;
SELECT set_config('app.tenant_id', '75000000-0000-4000-8000-000000000001', true);

SELECT app.transition_run(
  '75000000-0000-4000-8000-000000000021', 1, 'CANCELLED', 'cancelled',
  'job.cancelled.v1', NULL, NULL, false, '{"status":"cancelled"}'
);

RESET ROLE;
SET LOCAL ROLE dhumi_owner;
SELECT set_config('app.tenant_id', '75000000-0000-4000-8000-000000000001', true);

SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1
    FROM app.runs
    WHERE id = '75000000-0000-4000-8000-000000000021'
      AND internal_status = 'CANCELLED'
      AND public_status = 'cancelled'
      AND state_version = 2
  ),
  'Job Manager must retain the guarded queued-to-cancelled transition'
);

SELECT pg_temp.assert_true(
  (
    SELECT array_agg(sequence ORDER BY sequence)
    FROM app.run_events
    WHERE run_id = '75000000-0000-4000-8000-000000000021'
  ) = ARRAY[1::bigint, 2::bigint, 3::bigint],
  'a transition after cancellation intent must allocate sequence 3 without collision'
);

SELECT pg_temp.assert_true(
  (
    SELECT bool_and(
      payload = jsonb_build_object('run_id', aggregate_id::text)
      AND tenant_id = '75000000-0000-4000-8000-000000000001'::uuid
    )
    FROM app.outbox_events
    WHERE topic = 'jobs.cancel'
  ),
  'the durable cancellation command must remain Run-ID-only and Tenant-owned'
);

RESET ROLE;
ROLLBACK;
