-- Privileged, rollback-only proof for migration 0020 and Run listing semantics.
-- This fixture does not contact Bright Data or persist catalogue, Service, or Run data.
\set ON_ERROR_STOP on

BEGIN;
SET CONSTRAINTS ALL DEFERRED;

\if :{?run_event_list_proof}
-- Prove the forward grant change transactionally before it is applied.
\ir ../../scripts/migrations/0025_run_event_list_read_surface.sql
\endif

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

-- Privileged setup supplies coherent release pins without widening any runtime
-- role. Every row is transaction-local because the proof ends in ROLLBACK.
INSERT INTO app.users (id, email_normalized, password_hash) VALUES
  ('74000000-0000-4000-8000-000000000002', 'run-list-a@example.test', '$argon2id$test-only'),
  ('74000000-0000-4000-8000-000000000007', 'run-list-b@example.test', '$argon2id$test-only');

INSERT INTO app.tenants (id, display_name) VALUES
  ('74000000-0000-4000-8000-000000000001', 'Run list Tenant A'),
  ('74000000-0000-4000-8000-000000000006', 'Run list Tenant B');

INSERT INTO app.tenant_user_access (tenant_id, user_id) VALUES
  ('74000000-0000-4000-8000-000000000001', '74000000-0000-4000-8000-000000000002'),
  ('74000000-0000-4000-8000-000000000006', '74000000-0000-4000-8000-000000000007');

INSERT INTO app.launch_evidence (
  id, evidence_code, scope_type, scope_key, state, restricted_reference,
  effective_at, approved_by, approved_at
) VALUES
  (
    '74000000-0000-4000-8000-00000000000d', 'run-list-template', 'template',
    '74000000-0000-4000-8000-00000000000a', 'approved',
    'restricted:test-only-template', clock_timestamp() - interval '1 hour',
    'test-principal', clock_timestamp() - interval '1 hour'
  ),
  (
    '74000000-0000-4000-8000-00000000000e', 'run-list-mapping', 'mapping',
    '74000000-0000-4000-8000-00000000000c', 'approved',
    'restricted:test-only-mapping', clock_timestamp() - interval '1 hour',
    'test-principal', clock_timestamp() - interval '1 hour'
  ),
  (
    '74000000-0000-4000-8000-000000000010', 'run-list-feature', 'feature',
    '74000000-0000-4000-8000-00000000000f', 'approved',
    'restricted:test-only-feature', clock_timestamp() - interval '1 hour',
    'test-principal', clock_timestamp() - interval '1 hour'
  );

INSERT INTO app.feature_flags (
  id, feature_code, environment, state, launch_evidence_id,
  changed_by, changed_reason
) VALUES (
  '74000000-0000-4000-8000-00000000000f', 'marketplace_dataset', 'test',
  'enabled', '74000000-0000-4000-8000-000000000010',
  'test-principal', 'rollback-only Run-list proof'
);

INSERT INTO app.adapter_definitions (id, code, product_family) VALUES (
  '74000000-0000-4000-8000-000000000011',
  'run-list-sql',
  'marketplace_dataset'
);

INSERT INTO app.adapter_versions (
  id, adapter_definition_id, semantic_version, code_artifact_digest, state
) VALUES (
  '74000000-0000-4000-8000-00000000000b',
  '74000000-0000-4000-8000-000000000011',
  '1.0.0', decode(repeat('11', 32), 'hex'), 'enabled'
);

INSERT INTO app.service_templates (id, slug, product_family, state) VALUES (
  '74000000-0000-4000-8000-000000000012',
  'run-list-sql',
  'marketplace_dataset',
  'draft'
);

INSERT INTO app.service_template_versions (
  id, service_template_id, version, public_name, public_description,
  input_schema, output_schema, availability_copy, availability_state,
  adapter_version_id, launch_evidence_id, effective_at, published_at
) VALUES (
  '74000000-0000-4000-8000-00000000000a',
  '74000000-0000-4000-8000-000000000012', 1,
  'Run list SQL proof', 'Rollback-only privileged proof',
  '{"type":"object","additionalProperties":false}'::jsonb,
  '{"type":"object"}'::jsonb, 'Available', 'available',
  '74000000-0000-4000-8000-00000000000b',
  '74000000-0000-4000-8000-00000000000d',
  clock_timestamp() - interval '1 hour', clock_timestamp() - interval '1 hour'
);

UPDATE app.service_templates
SET state = 'published',
    current_public_version_id = '74000000-0000-4000-8000-00000000000a'
WHERE id = '74000000-0000-4000-8000-000000000012';

INSERT INTO app.provider_credentials (
  id, provider_code, environment, vault_secret_reference, permission_label,
  state, activated_at
) VALUES (
  '74000000-0000-4000-8000-000000000013', 'bright_data', 'test',
  'vault://test-only/run-list-sql', 'test-only', 'active',
  clock_timestamp() - interval '1 hour'
);

INSERT INTO app.provider_mappings (
  id, service_template_version_id, adapter_version_id, provider_credential_id,
  environment, operation_code, provider_resource_ciphertext,
  provider_resource_fingerprint, output_policy, commercial_config_version,
  config_version, launch_evidence_id, state
) VALUES (
  '74000000-0000-4000-8000-00000000000c',
  '74000000-0000-4000-8000-00000000000a',
  '74000000-0000-4000-8000-00000000000b',
  '74000000-0000-4000-8000-000000000013', 'test',
  'marketplace.snapshot', convert_to('private-test-only', 'UTF8'),
  decode(repeat('22', 32), 'hex'), '{}'::jsonb, 'test-v1', 'test-v1',
  '74000000-0000-4000-8000-00000000000e', 'enabled'
);

-- Tenant A deliberately points at version 2 while all its Runs pin version 1.
-- Listing must still resolve the public Service identity from that immutable pin.
INSERT INTO app.services (
  id, tenant_id, service_template_id, name, state, current_version
) VALUES
  (
    '74000000-0000-4000-8000-000000000003',
    '74000000-0000-4000-8000-000000000001',
    '74000000-0000-4000-8000-000000000012', 'Run list Service A', 'active', 2
  ),
  (
    '74000000-0000-4000-8000-000000000008',
    '74000000-0000-4000-8000-000000000006',
    '74000000-0000-4000-8000-000000000012', 'Run list Service B', 'active', 1
  );

INSERT INTO app.service_versions (
  id, tenant_id, service_id, version, service_template_version_id,
  validated_configuration, schema_hash, created_by_user_id,
  created_by_api_key_id
) VALUES
  (
    '74000000-0000-4000-8000-000000000004',
    '74000000-0000-4000-8000-000000000001',
    '74000000-0000-4000-8000-000000000003', 1,
    '74000000-0000-4000-8000-00000000000a', '{"revision":1}'::jsonb,
    decode(repeat('31', 32), 'hex'),
    '74000000-0000-4000-8000-000000000002', NULL
  ),
  (
    '74000000-0000-4000-8000-000000000005',
    '74000000-0000-4000-8000-000000000001',
    '74000000-0000-4000-8000-000000000003', 2,
    '74000000-0000-4000-8000-00000000000a', '{"revision":2}'::jsonb,
    decode(repeat('32', 32), 'hex'),
    '74000000-0000-4000-8000-000000000002', NULL
  ),
  (
    '74000000-0000-4000-8000-000000000009',
    '74000000-0000-4000-8000-000000000006',
    '74000000-0000-4000-8000-000000000008', 1,
    '74000000-0000-4000-8000-00000000000a', '{"revision":1}'::jsonb,
    decode(repeat('33', 32), 'hex'),
    '74000000-0000-4000-8000-000000000007', NULL
  );

SET CONSTRAINTS ALL IMMEDIATE;

INSERT INTO app.runs (
  id, tenant_id, service_version_id, service_template_version_id,
  adapter_version_id, provider_mapping_id, commercial_config_version,
  validated_input, template_launch_evidence_id, mapping_launch_evidence_id,
  feature_flag_id, feature_launch_evidence_id, public_status, internal_status,
  state_version, retryable, customer_error_code, accepted_at, created_at,
  updated_at, completed_at
) VALUES
  (
    '74000000-0000-4000-8000-000000000021',
    '74000000-0000-4000-8000-000000000001',
    '74000000-0000-4000-8000-000000000004',
    '74000000-0000-4000-8000-00000000000a',
    '74000000-0000-4000-8000-00000000000b',
    '74000000-0000-4000-8000-00000000000c', 'test-v1', '{"query":"a"}',
    '74000000-0000-4000-8000-00000000000d',
    '74000000-0000-4000-8000-00000000000e',
    '74000000-0000-4000-8000-00000000000f',
    '74000000-0000-4000-8000-000000000010', 'queued', 'QUEUED', 1, false,
    NULL, '2026-01-01T12:00:00Z', '2026-01-01T12:00:00Z',
    '2026-01-01T12:00:00Z', NULL
  ),
  (
    '74000000-0000-4000-8000-000000000022',
    '74000000-0000-4000-8000-000000000001',
    '74000000-0000-4000-8000-000000000004',
    '74000000-0000-4000-8000-00000000000a',
    '74000000-0000-4000-8000-00000000000b',
    '74000000-0000-4000-8000-00000000000c', 'test-v1', '{"query":"b"}',
    '74000000-0000-4000-8000-00000000000d',
    '74000000-0000-4000-8000-00000000000e',
    '74000000-0000-4000-8000-00000000000f',
    '74000000-0000-4000-8000-000000000010', 'queued', 'QUEUED', 1, false,
    NULL, '2026-01-01T12:00:00Z', '2026-01-01T12:00:00Z',
    '2026-01-01T12:00:00Z', NULL
  ),
  (
    '74000000-0000-4000-8000-000000000023',
    '74000000-0000-4000-8000-000000000001',
    '74000000-0000-4000-8000-000000000004',
    '74000000-0000-4000-8000-00000000000a',
    '74000000-0000-4000-8000-00000000000b',
    '74000000-0000-4000-8000-00000000000c', 'test-v1', '{"query":"c"}',
    '74000000-0000-4000-8000-00000000000d',
    '74000000-0000-4000-8000-00000000000e',
    '74000000-0000-4000-8000-00000000000f',
    '74000000-0000-4000-8000-000000000010', 'ready', 'COMPLETED', 3, false,
    NULL, '2026-01-01T11:00:00Z', '2026-01-01T11:00:00Z',
    '2026-01-01T11:05:00Z', '2026-01-01T11:05:00Z'
  ),
  (
    '74000000-0000-4000-8000-000000000024',
    '74000000-0000-4000-8000-000000000001',
    '74000000-0000-4000-8000-000000000004',
    '74000000-0000-4000-8000-00000000000a',
    '74000000-0000-4000-8000-00000000000b',
    '74000000-0000-4000-8000-00000000000c', 'test-v1', '{"query":"d"}',
    '74000000-0000-4000-8000-00000000000d',
    '74000000-0000-4000-8000-00000000000e',
    '74000000-0000-4000-8000-00000000000f',
    '74000000-0000-4000-8000-000000000010', 'failed', 'UPSTREAM_FAILED', 2, true,
    'UPSTREAM_UNAVAILABLE', '2026-01-01T10:00:00Z',
    '2026-01-01T10:00:00Z', '2026-01-01T10:05:00Z',
    '2026-01-01T10:05:00Z'
  ),
  (
    '74000000-0000-4000-8000-000000000025',
    '74000000-0000-4000-8000-000000000006',
    '74000000-0000-4000-8000-000000000009',
    '74000000-0000-4000-8000-00000000000a',
    '74000000-0000-4000-8000-00000000000b',
    '74000000-0000-4000-8000-00000000000c', 'test-v1', '{"query":"private"}',
    '74000000-0000-4000-8000-00000000000d',
    '74000000-0000-4000-8000-00000000000e',
    '74000000-0000-4000-8000-00000000000f',
    '74000000-0000-4000-8000-000000000010', 'queued', 'QUEUED', 1, false,
    NULL, '2026-01-01T13:00:00Z', '2026-01-01T13:00:00Z',
    '2026-01-01T13:00:00Z', NULL
  );

\if :{?run_event_list_proof}
INSERT INTO app.run_events (
  id, tenant_id, run_id, sequence, event_type, source,
  event_idempotency_key, safe_payload, evidence_reference, occurred_at
) VALUES
  (
    '76000000-0000-4000-8000-000000000001',
    '74000000-0000-4000-8000-000000000001',
    '74000000-0000-4000-8000-000000000021', 1, 'accepted', 'admission',
    'run-events.accepted.v1', '{"private":"must-not-be-readable"}'::jsonb,
    'restricted:test-only-accepted', '2026-01-01T12:00:00Z'
  ),
  (
    '76000000-0000-4000-8000-000000000002',
    '74000000-0000-4000-8000-000000000001',
    '74000000-0000-4000-8000-000000000021', 2,
    'provider.accepted', 'job_manager', 'run-events.started.v1',
    '{"provider_status":"private"}'::jsonb,
    'restricted:test-only-provider', '2026-01-01T12:01:00Z'
  ),
  (
    '76000000-0000-4000-8000-000000000003',
    '74000000-0000-4000-8000-000000000001',
    '74000000-0000-4000-8000-000000000021', 3,
    'provider.failed', 'job_manager', 'run-events.failed.v1',
    '{"provider_error":"private"}'::jsonb,
    'restricted:test-only-failure', '2026-01-01T12:02:00Z'
  ),
  (
    '76000000-0000-4000-8000-000000000004',
    '74000000-0000-4000-8000-000000000006',
    '74000000-0000-4000-8000-000000000025', 1, 'accepted', 'admission',
    'run-events.tenant-b.v1', '{}'::jsonb, NULL, '2026-01-01T13:00:00Z'
  );
\endif

SET LOCAL ROLE dhumi_customer_api;
SELECT set_config('app.tenant_id', '74000000-0000-4000-8000-000000000001', true);

SELECT pg_temp.assert_true(
  (
    SELECT array_agg(run.id ORDER BY run.created_at DESC, run.id DESC)
    FROM app.runs AS run
  ) = ARRAY[
    '74000000-0000-4000-8000-000000000022'::uuid,
    '74000000-0000-4000-8000-000000000021'::uuid,
    '74000000-0000-4000-8000-000000000023'::uuid,
    '74000000-0000-4000-8000-000000000024'::uuid
  ],
  'Tenant A must see only its Runs in exact keyset order'
);

\if :{?run_event_list_proof}
SELECT pg_temp.assert_true(
  (
    SELECT array_agg(event.event_type ORDER BY event.sequence)
    FROM app.run_events AS event
    WHERE event.run_id = '74000000-0000-4000-8000-000000000021'::uuid
  ) = ARRAY['accepted', 'provider.accepted', 'provider.failed'],
  'Tenant A must see only its Run events in immutable sequence order'
);

SELECT pg_temp.assert_true(
  (
    SELECT array_agg(page.event_type ORDER BY page.sequence)
    FROM (
      SELECT event.event_type, event.sequence
      FROM app.run_events AS event
      WHERE event.run_id = '74000000-0000-4000-8000-000000000021'::uuid
        AND event.sequence > 2
      ORDER BY event.sequence ASC
      LIMIT 2
    ) AS page
  ) = ARRAY['provider.failed'],
  'Run-event cursor continuation must start strictly after its bigint sequence'
);

DO $$
BEGIN
  BEGIN
    PERFORM source FROM app.run_events LIMIT 1;
    RAISE EXCEPTION 'customer role unexpectedly read Run-event source';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM safe_payload FROM app.run_events LIMIT 1;
    RAISE EXCEPTION 'customer role unexpectedly read Run-event payload';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM evidence_reference FROM app.run_events LIMIT 1;
    RAISE EXCEPTION 'customer role unexpectedly read Run-event evidence';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
\endif

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 4 AND bool_and(service_version.service_id =
      '74000000-0000-4000-8000-000000000003'::uuid)
    FROM app.runs AS run
    JOIN app.service_versions AS service_version
      ON service_version.tenant_id = run.tenant_id
     AND service_version.id = run.service_version_id
  ),
  'historical Service-version pins must resolve only their public Service id'
);

SELECT pg_temp.assert_true(
  (
    SELECT array_agg(page.id ORDER BY page.created_at DESC, page.id DESC)
    FROM (
      SELECT run.id, run.created_at
      FROM app.runs AS run
      WHERE run.public_status = 'queued'
        AND (run.created_at, run.id) < (
          '2026-01-01T12:00:00Z'::timestamptz,
          '74000000-0000-4000-8000-000000000022'::uuid
        )
      ORDER BY run.created_at DESC, run.id DESC
      LIMIT 1
    ) AS page
  ) = ARRAY['74000000-0000-4000-8000-000000000021'::uuid],
  'the id tie-breaker must make an equal-timestamp second page lossless'
);

DO $$
BEGIN
  BEGIN
    PERFORM internal_status FROM app.runs LIMIT 1;
    RAISE EXCEPTION 'customer role unexpectedly read internal_status';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM validated_input FROM app.runs LIMIT 1;
    RAISE EXCEPTION 'customer role unexpectedly read validated_input';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM schema_hash FROM app.service_versions LIMIT 1;
    RAISE EXCEPTION 'customer role unexpectedly read Service-version internals';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;

\if :{?run_detail_proof}
-- The detail operation must resolve the public Service identity from the exact
-- immutable version pinned by the Run and expose only current public state.
SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1
    FROM app.runs AS run
    JOIN app.service_versions AS service_version
      ON service_version.tenant_id = run.tenant_id
     AND service_version.id = run.service_version_id
    WHERE run.id = '74000000-0000-4000-8000-000000000024'::uuid
      AND service_version.service_id =
        '74000000-0000-4000-8000-000000000003'::uuid
      AND run.public_status = 'failed'
      AND run.customer_error_code = 'UPSTREAM_UNAVAILABLE'
      AND run.retryable = true
      AND run.created_at = '2026-01-01T10:00:00Z'::timestamptz
      AND run.updated_at = '2026-01-01T10:05:00Z'::timestamptz
      AND run.completed_at = '2026-01-01T10:05:00Z'::timestamptz
  ),
  'Run detail must project the exact public state and historical Service pin'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM app.runs
    WHERE id = '74000000-0000-4000-8000-000000000025'::uuid
  ),
  'Run detail must not reveal another Tenant Run by exact identifier'
);
\endif

RESET ROLE;
SET LOCAL ROLE dhumi_owner;
SELECT set_config('app.tenant_id', '74000000-0000-4000-8000-000000000001', true);
SELECT set_config('app.run_transition_writer', 'on', true);

UPDATE app.runs
SET public_status = 'running',
    internal_status = 'SUBMITTED',
    state_version = state_version + 1,
    started_at = '2026-01-01T12:01:00Z',
    updated_at = '2026-01-01T12:01:00Z'
WHERE id = '74000000-0000-4000-8000-000000000021';

\if :{?run_event_list_proof}
INSERT INTO app.run_events (
  id, tenant_id, run_id, sequence, event_type, source,
  event_idempotency_key, safe_payload, occurred_at
) VALUES (
  '76000000-0000-4000-8000-000000000005',
  '74000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000021', 4, 'progress', 'job_manager',
  'run-events.progress.v1', '{"provider_progress":"private"}'::jsonb,
  '2026-01-01T12:03:00Z'
);
\endif

RESET ROLE;
SET LOCAL ROLE dhumi_customer_api;
SELECT set_config('app.tenant_id', '74000000-0000-4000-8000-000000000001', true);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM app.runs AS run
    WHERE run.public_status = 'queued'
      AND (run.created_at, run.id) < (
        '2026-01-01T12:00:00Z'::timestamptz,
        '74000000-0000-4000-8000-000000000022'::uuid
      )
  ),
  'status-filtered pagination must use current row state after a transition'
);

SELECT pg_temp.assert_true(
  (SELECT count(*) FROM app.runs WHERE public_status = 'running') = 1,
  'the transitioned Run must appear under its current public status'
);

\if :{?run_event_list_proof}
SELECT pg_temp.assert_true(
  (
    SELECT array_agg(event.event_type ORDER BY event.sequence)
    FROM app.run_events AS event
    WHERE event.run_id = '74000000-0000-4000-8000-000000000021'::uuid
      AND event.sequence > 2
  ) = ARRAY['provider.failed', 'progress'],
  'an append after an earlier page must remain collision-free and discoverable'
);
\endif

RESET ROLE;
SET LOCAL ROLE dhumi_customer_api;
SELECT set_config('app.tenant_id', '74000000-0000-4000-8000-000000000006', true);

SELECT pg_temp.assert_true(
  (
    SELECT array_agg(id ORDER BY created_at DESC, id DESC)
    FROM app.runs
  ) = ARRAY['74000000-0000-4000-8000-000000000025'::uuid],
  'Tenant B must not see Tenant A Runs'
);

\if :{?run_event_list_proof}
SELECT pg_temp.assert_true(
  (
    SELECT array_agg(event.event_type ORDER BY event.sequence)
    FROM app.run_events AS event
  ) = ARRAY['accepted'],
  'Tenant B must see only its own Run events'
);
\endif

RESET ROLE;
SET LOCAL ROLE dhumi_customer_api;
SELECT set_config('app.tenant_id', '', true);

SELECT pg_temp.assert_true(
  (SELECT count(*) FROM app.runs) = 0,
  'Run RLS must fail closed without trusted Tenant context'
);

\if :{?run_event_list_proof}
SELECT pg_temp.assert_true(
  (SELECT count(*) FROM app.run_events) = 0,
  'Run-event RLS must fail closed without trusted Tenant context'
);
\endif

RESET ROLE;
ROLLBACK;
