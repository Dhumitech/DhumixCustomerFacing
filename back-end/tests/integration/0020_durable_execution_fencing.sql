-- Privileged, rollback-only proof for Pattern 4 migration 0029.
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

CREATE TEMP TABLE p4_context (
  tenant_id uuid NOT NULL,
  other_tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  mapping_id uuid NOT NULL,
  adapter_id uuid NOT NULL
);
INSERT INTO p4_context VALUES (
  '74000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000002',
  '74000000-0000-4000-8000-000000000003',
  '74000000-0000-4000-8000-000000000004',
  '74000000-0000-4000-8000-000000000005'
);
GRANT SELECT ON p4_context TO dhumi_outbox_dispatcher, dhumi_job_manager;

CREATE TEMP TABLE p4_claims (
  label text NOT NULL,
  disposition text NOT NULL,
  attempt_id uuid,
  attempt_number integer,
  fence_token uuid,
  worker_lease_expires_at timestamptz,
  run_state_version bigint NOT NULL,
  run_internal_status text NOT NULL,
  adapter_version_id uuid NOT NULL,
  provider_mapping_id uuid NOT NULL,
  provider_credential_id uuid,
  cancellation_requested boolean NOT NULL
);
GRANT SELECT, INSERT ON p4_claims TO dhumi_job_manager;

CREATE TEMP TABLE p4_outbox_claims (
  id uuid NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  tenant_id uuid,
  topic text NOT NULL,
  ordering_key text NOT NULL,
  payload jsonb NOT NULL,
  schema_version integer NOT NULL,
  claim_token uuid NOT NULL
);
GRANT SELECT, INSERT ON p4_outbox_claims TO dhumi_outbox_dispatcher;

INSERT INTO app.users (id, email_normalized, password_hash) VALUES
  ('74000000-0000-4000-8000-000000000006', 'pattern4@example.test', '$argon2id$test'),
  ('74000000-0000-4000-8000-000000000007', 'pattern4-other@example.test', '$argon2id$test');
INSERT INTO app.tenants (id, display_name) VALUES
  ((SELECT tenant_id FROM p4_context), 'Pattern 4 Tenant'),
  ((SELECT other_tenant_id FROM p4_context), 'Pattern 4 Other Tenant');
INSERT INTO app.tenant_user_access (tenant_id, user_id) VALUES
  ((SELECT tenant_id FROM p4_context), '74000000-0000-4000-8000-000000000006'),
  ((SELECT other_tenant_id FROM p4_context), '74000000-0000-4000-8000-000000000007');

INSERT INTO app.launch_evidence (
  id, evidence_code, scope_type, scope_key, state, restricted_reference,
  effective_at, approved_by, approved_at
) VALUES
  ('74000000-0000-4000-8000-000000000008', 'p4-template', 'template', 'p4',
   'approved', 'restricted:p4-template', clock_timestamp() - interval '1 hour',
   'test', clock_timestamp() - interval '1 hour'),
  ('74000000-0000-4000-8000-000000000009', 'p4-mapping', 'mapping', 'p4',
   'approved', 'restricted:p4-mapping', clock_timestamp() - interval '1 hour',
   'test', clock_timestamp() - interval '1 hour'),
  ('74000000-0000-4000-8000-00000000000a', 'p4-feature', 'feature', 'p4',
   'approved', 'restricted:p4-feature', clock_timestamp() - interval '1 hour',
   'test', clock_timestamp() - interval '1 hour');

INSERT INTO app.feature_flags (
  id, feature_code, environment, state, launch_evidence_id, changed_by, changed_reason
) VALUES (
  '74000000-0000-4000-8000-00000000000b', 'scraper_library', 'test', 'enabled',
  '74000000-0000-4000-8000-00000000000a', 'test', 'rollback-only proof'
);

INSERT INTO app.adapter_definitions (id, code, product_family) VALUES (
  '74000000-0000-4000-8000-00000000000c', 'pattern4-controlled', 'scraper_library'
);
INSERT INTO app.adapter_versions (
  id, adapter_definition_id, semantic_version, code_artifact_digest, state
) VALUES (
  (SELECT adapter_id FROM p4_context),
  '74000000-0000-4000-8000-00000000000c', '1.0.0-test',
  decode(repeat('11', 32), 'hex'), 'enabled'
);

INSERT INTO app.service_templates (id, slug, product_family, state) VALUES (
  '74000000-0000-4000-8000-00000000000d',
  'pattern4-controlled', 'scraper_library', 'draft'
);
INSERT INTO app.service_template_versions (
  id, service_template_id, version, public_name, public_description,
  input_schema, configuration_schema, output_schema, presentation_metadata,
  availability_copy, availability_state, adapter_version_id,
  launch_evidence_id, effective_at, published_at
) VALUES (
  '74000000-0000-4000-8000-00000000000e',
  '74000000-0000-4000-8000-00000000000d', 1,
  'Pattern 4 controlled', 'Rollback-only execution proof',
  '{"type":"object","additionalProperties":false}'::jsonb,
  '{"type":"object","additionalProperties":false}'::jsonb,
  '{"type":"object"}'::jsonb,
  '{"domain_slug":"amazon","domain_name":"Amazon","category":"web-data","icon_key":"amazon","operation_group":"Products","operation_name":"Controlled","display_priority":100}'::jsonb,
  'Test only', 'available', (SELECT adapter_id FROM p4_context),
  '74000000-0000-4000-8000-000000000008',
  clock_timestamp() - interval '1 hour', clock_timestamp() - interval '1 hour'
);
UPDATE app.service_templates
SET state = 'published',
    current_public_version_id = '74000000-0000-4000-8000-00000000000e'
WHERE id = '74000000-0000-4000-8000-00000000000d';

INSERT INTO app.provider_credentials (
  id, provider_code, environment, vault_secret_reference, permission_label,
  state, activated_at
) VALUES (
  '74000000-0000-4000-8000-00000000000f', 'bright_data', 'test',
  'vault://test-only/pattern4', 'test-only', 'active', clock_timestamp()
);
INSERT INTO app.provider_mappings (
  id, service_template_version_id, adapter_version_id, provider_credential_id,
  environment, operation_code, provider_resource_ciphertext,
  provider_resource_fingerprint, output_policy, commercial_config_version,
  config_version, launch_evidence_id, state
) VALUES (
  (SELECT mapping_id FROM p4_context),
  '74000000-0000-4000-8000-00000000000e',
  (SELECT adapter_id FROM p4_context),
  '74000000-0000-4000-8000-00000000000f', 'test',
  'amazon.products.collect_by_url', convert_to('private-test-only', 'UTF8'),
  decode(repeat('22', 32), 'hex'), '{}'::jsonb, 'test-v1', 'test-v1',
  '74000000-0000-4000-8000-000000000009', 'enabled'
);

INSERT INTO app.services (
  id, tenant_id, service_template_id, name, state, current_version
) VALUES (
  '74000000-0000-4000-8000-000000000010',
  (SELECT tenant_id FROM p4_context),
  '74000000-0000-4000-8000-00000000000d',
  'Pattern 4 Service', 'active', 1
);
INSERT INTO app.service_versions (
  id, tenant_id, service_id, version, service_template_version_id,
  validated_configuration, schema_hash, created_by_user_id
) VALUES (
  '74000000-0000-4000-8000-000000000011',
  (SELECT tenant_id FROM p4_context),
  '74000000-0000-4000-8000-000000000010', 1,
  '74000000-0000-4000-8000-00000000000e', '{}'::jsonb,
  decode(repeat('33', 32), 'hex'),
  '74000000-0000-4000-8000-000000000006'
);

INSERT INTO app.runs (
  id, tenant_id, service_version_id, service_template_version_id,
  adapter_version_id, provider_mapping_id, commercial_config_version,
  validated_input, template_launch_evidence_id, mapping_launch_evidence_id,
  feature_flag_id, feature_launch_evidence_id, public_status,
  internal_status, state_version, retryable
) VALUES (
  (SELECT run_id FROM p4_context), (SELECT tenant_id FROM p4_context),
  '74000000-0000-4000-8000-000000000011',
  '74000000-0000-4000-8000-00000000000e',
  (SELECT adapter_id FROM p4_context), (SELECT mapping_id FROM p4_context),
  'test-v1', '{}'::jsonb,
  '74000000-0000-4000-8000-000000000008',
  '74000000-0000-4000-8000-000000000009',
  '74000000-0000-4000-8000-00000000000b',
  '74000000-0000-4000-8000-00000000000a',
  'queued', 'QUEUED', 1, false
);
INSERT INTO app.run_events (
  id, tenant_id, run_id, sequence, event_type, source,
  event_idempotency_key, safe_payload
) VALUES (
  '74000000-0000-4000-8000-000000000012',
  (SELECT tenant_id FROM p4_context), (SELECT run_id FROM p4_context),
  1, 'accepted', 'admission', 'admission.accepted.v1', '{"status":"queued"}'::jsonb
);
INSERT INTO app.outbox_events (
  id, aggregate_type, aggregate_id, tenant_id, topic, ordering_key,
  payload, schema_version
) VALUES
  ('74000000-0000-4000-8000-000000000013', 'run',
   (SELECT run_id FROM p4_context), (SELECT tenant_id FROM p4_context),
   'jobs.execute', (SELECT run_id::text FROM p4_context),
   jsonb_build_object('run_id', (SELECT run_id FROM p4_context)), 1),
  ('74000000-0000-4000-8000-000000000014', 'tenant',
   (SELECT tenant_id FROM p4_context), (SELECT tenant_id FROM p4_context),
   'notifications.test', (SELECT tenant_id::text FROM p4_context), '{}'::jsonb, 1);

SET LOCAL ROLE dhumi_outbox_dispatcher;
INSERT INTO p4_outbox_claims
SELECT * FROM app.claim_job_outbox_events('p4-dispatcher', 10, interval '1 minute');
SELECT pg_temp.assert_true(
  (SELECT count(*) FROM p4_outbox_claims) = 1
  AND (SELECT topic FROM p4_outbox_claims) = 'jobs.execute',
  'execution dispatcher must claim only supported job topics'
);
SELECT pg_temp.assert_true(
  app.mark_outbox_event_published(
    (SELECT id FROM p4_outbox_claims),
    (SELECT claim_token FROM p4_outbox_claims)
  ),
  'exact claim token must acknowledge a published command'
);
SELECT pg_temp.assert_true(
  NOT app.mark_outbox_event_published(
    (SELECT id FROM p4_outbox_claims),
    (SELECT claim_token FROM p4_outbox_claims)
  ),
  'a published command must not acknowledge twice'
);
RESET ROLE;
SELECT pg_temp.assert_true(
  (SELECT claimed_at IS NULL AND published_at IS NULL
   FROM app.outbox_events WHERE id = '74000000-0000-4000-8000-000000000014'),
  'unrelated outbox rows must remain untouched'
);

SET LOCAL ROLE dhumi_job_manager;
SELECT set_config('app.tenant_id', (SELECT tenant_id::text FROM p4_context), true);
INSERT INTO p4_claims
SELECT 'first', claim.*
FROM app.claim_run_attempt(
  (SELECT run_id FROM p4_context), 'submission', interval '1 minute'
) AS claim;
INSERT INTO p4_claims
SELECT 'busy', claim.*
FROM app.claim_run_attempt(
  (SELECT run_id FROM p4_context), 'submission', interval '1 minute'
) AS claim;
SELECT pg_temp.assert_true(
  (SELECT disposition = 'claimed' AND fence_token IS NOT NULL FROM p4_claims WHERE label = 'first')
  AND (SELECT disposition = 'busy' AND fence_token IS NULL FROM p4_claims WHERE label = 'busy'),
  'a second live claim must not receive the active fence'
);

DO $$
DECLARE rejected boolean := false;
BEGIN
  BEGIN
    PERFORM app.transition_run(
      (SELECT run_id FROM p4_context), 1, 'SUBMITTED', 'submitted',
      'p4.unfenced', (SELECT attempt_id FROM p4_claims WHERE label = 'first'),
      NULL, false, '{"status":"running"}'::jsonb
    );
  EXCEPTION WHEN insufficient_privilege THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'unfenced transition surface must be denied');
END;
$$;
RESET ROLE;

UPDATE app.run_attempts
SET worker_lease_expires_at = clock_timestamp() - interval '1 second'
WHERE id = (SELECT attempt_id FROM p4_claims WHERE label = 'first');

SET LOCAL ROLE dhumi_job_manager;
SELECT set_config('app.tenant_id', (SELECT tenant_id::text FROM p4_context), true);
INSERT INTO p4_claims
SELECT 'recovered', claim.*
FROM app.claim_run_attempt(
  (SELECT run_id FROM p4_context), 'submission', interval '1 minute'
) AS claim;
SELECT pg_temp.assert_true(
  (SELECT disposition = 'recovered' FROM p4_claims WHERE label = 'recovered')
  AND (SELECT fence_token FROM p4_claims WHERE label = 'recovered') <>
      (SELECT fence_token FROM p4_claims WHERE label = 'first'),
  'expired queued work must recover with a new fence'
);

DO $$
DECLARE rejected boolean := false;
BEGIN
  BEGIN
    PERFORM app.transition_run_fenced(
      (SELECT run_id FROM p4_context), 1, 'SUBMITTED', 'submitted',
      'p4.stale-fence', (SELECT attempt_id FROM p4_claims WHERE label = 'first'),
      (SELECT fence_token FROM p4_claims WHERE label = 'first'),
      NULL, false, '{"status":"running"}'::jsonb
    );
  EXCEPTION WHEN serialization_failure THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'stale fence must not transition the Run');
END;
$$;

DO $$
DECLARE rejected boolean := false;
BEGIN
  BEGIN
    PERFORM app.transition_run_fenced(
      (SELECT run_id FROM p4_context), 1, 'SUBMITTED', 'submitted',
      'p4.null-fence', (SELECT attempt_id FROM p4_claims WHERE label = 'recovered'),
      NULL,
      NULL, false, '{"status":"running"}'::jsonb
    );
  EXCEPTION WHEN serialization_failure THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'a NULL fence must fail closed');
END;
$$;

SAVEPOINT cancellation_race;

INSERT INTO app.run_events (
  id, tenant_id, run_id, sequence, event_type, source,
  event_idempotency_key, safe_payload
)
VALUES (
  '74000000-0000-4000-8000-000000000017',
  (SELECT tenant_id FROM p4_context),
  (SELECT run_id FROM p4_context),
  2, 'cancellation_requested', 'admission',
  'cancel.requested.v1:74000000-0000-4000-8000-000000000017',
  '{"status":"queued"}'::jsonb
);

DO $$
DECLARE rejected boolean := false;
BEGIN
  BEGIN
    PERFORM app.transition_run_fenced(
      (SELECT run_id FROM p4_context), 1, 'SUBMITTED', 'submitted',
      'p4.cancel-race-submitted',
      (SELECT attempt_id FROM p4_claims WHERE label = 'recovered'),
      (SELECT fence_token FROM p4_claims WHERE label = 'recovered'),
      NULL, false, '{"status":"running"}'::jsonb
    );
  EXCEPTION WHEN raise_exception THEN
    rejected := SQLERRM = 'RUN_CANCELLATION_REQUESTED';
  END;
  PERFORM pg_temp.assert_true(rejected, 'cancellation must win the claim-to-submit race');
END;
$$;

ROLLBACK TO SAVEPOINT cancellation_race;
SELECT set_config('app.tenant_id', (SELECT tenant_id::text FROM p4_context), true);

SELECT app.transition_run_fenced(
  (SELECT run_id FROM p4_context), 1, 'SUBMITTED', 'submitted',
  'p4.submitted', (SELECT attempt_id FROM p4_claims WHERE label = 'recovered'),
  (SELECT fence_token FROM p4_claims WHERE label = 'recovered'),
  NULL, false, '{"status":"running"}'::jsonb
);
SELECT pg_temp.assert_true(
  (SELECT internal_status = 'SUBMITTED' AND state_version = 2
   FROM app.runs WHERE id = (SELECT run_id FROM p4_context)),
  'current fence must perform the legal transition exactly once'
);
SELECT pg_temp.assert_true(
  app.renew_run_attempt_claim(
    (SELECT attempt_id FROM p4_claims WHERE label = 'recovered'),
    (SELECT fence_token FROM p4_claims WHERE label = 'recovered'),
    interval '1 minute'
  ) IS NOT NULL,
  'current fence must renew its PostgreSQL lease'
);
SELECT pg_temp.assert_true(
  app.finish_run_attempt_claim(
    (SELECT attempt_id FROM p4_claims WHERE label = 'recovered'),
    (SELECT fence_token FROM p4_claims WHERE label = 'recovered'),
    'completed', 'controlled_execution_completed'
  ),
  'current fence must finish its Attempt once'
);
SELECT pg_temp.assert_true(
  NOT app.finish_run_attempt_claim(
    (SELECT attempt_id FROM p4_claims WHERE label = 'recovered'),
    (SELECT fence_token FROM p4_claims WHERE label = 'recovered'),
    'completed', 'controlled_execution_completed'
  ),
  'a finished Attempt must not finish twice'
);

SELECT set_config('app.tenant_id', (SELECT other_tenant_id::text FROM p4_context), true);
DO $$
DECLARE rejected boolean := false;
BEGIN
  BEGIN
    PERFORM * FROM app.claim_run_attempt(
      (SELECT run_id FROM p4_context), 'submission', interval '1 minute'
    );
  EXCEPTION WHEN no_data_found THEN
    rejected := true;
  END;
  PERFORM pg_temp.assert_true(rejected, 'cross-Tenant command must not resolve the Run');
END;
$$;
RESET ROLE;

ROLLBACK;
