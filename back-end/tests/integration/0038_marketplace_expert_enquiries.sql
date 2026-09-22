-- Privileged, rollback-only M6 Marketplace expert-enquiry proof.
-- No provider endpoint, payment, entitlement, Service, Run, Attempt, outbox
-- event or usage event is used.
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

SET LOCAL ROLE dhumi_operator;

SELECT * FROM app.begin_marketplace_catalog_import(
  '7f200000-0000-4000-8000-000000000010',
  'test',
  'm6.database.proof',
  'checkpoint://dataset-market/m6/database-proof'
);

SELECT app.complete_marketplace_catalog_import(
  '7f200000-0000-4000-8000-000000000010',
  jsonb_build_array(
    jsonb_build_object(
      'id', '7f200000-0000-4000-8000-000000000011',
      'offer_code', 'linkedin.posts',
      'provider_name', 'LinkedIn posts',
      'record_count', 1000000,
      'catalogue_entry_checksum_hex', repeat('11', 32),
      'ciphertext_hex', repeat('21', 40),
      'fingerprint_hex', repeat('31', 32),
      'metadata_object_key',
        'qualification/catalog-imports/7f200000-0000-4000-8000-000000000010/metadata/linkedin-posts.json',
      'metadata_checksum_hex',
        'c210bf596129141cee74e7d4b339fc70b12fd4117201c693116073bcdde7d3a4',
      'metadata_observed_at', '2026-09-12T10:00:00.000Z'
    ),
    jsonb_build_object(
      'id', '7f200000-0000-4000-8000-000000000012',
      'offer_code', 'linkedin.people.standard',
      'provider_name', 'LinkedIn people profiles',
      'record_count', 2000000,
      'catalogue_entry_checksum_hex', repeat('12', 32),
      'ciphertext_hex', repeat('22', 40),
      'fingerprint_hex', repeat('32', 32),
      'metadata_object_key',
        'qualification/catalog-imports/7f200000-0000-4000-8000-000000000010/metadata/linkedin-people-standard.json',
      'metadata_checksum_hex', repeat('42', 32),
      'metadata_observed_at', '2026-09-12T10:00:00.000Z'
    )
  ),
  'qualification/catalog-imports/7f200000-0000-4000-8000-000000000010/marketplace-dataset-list.json',
  decode(repeat('51', 32), 'hex'),
  'm6.database.proof'
);

SELECT * FROM app.review_marketplace_catalog_candidate(
  '7f200000-0000-4000-8000-000000000011',
  'approve',
  'm6.database.reviewer'
);

SELECT template_version_id, metadata_checksum
FROM app.resolve_marketplace_sample_ingestion_target('linkedin-posts', 1)
\gset m6_

SELECT * FROM app.record_marketplace_fixture_sample(
  '7f200000-0000-4000-8000-000000000020',
  :'m6_template_version_id'::uuid,
  1,
  'marketplace/samples/' || :'m6_template_version_id' || '/1/' || repeat('61', 32) || '.json',
  'application/json',
  2,
  321,
  decode(repeat('61', 32), 'hex'),
  :'m6_metadata_checksum'::bytea,
  1,
  'linkedin-posts-provider-mask-preservation-v1',
  'linkedin-posts-sample-30d-v1',
  'fixture://marketplace-samples/linkedin-posts-v1',
  statement_timestamp() - interval '1 hour',
  statement_timestamp() - interval '1 hour' + interval '30 days',
  'm6.database.proof'
);

RESET ROLE;

INSERT INTO app.tenants (id, display_name, state)
VALUES
  ('7f200000-0000-4000-8000-000000000090', 'M6 Tenant A', 'active'),
  ('7f200000-0000-4000-8000-000000000091', 'M6 Tenant B', 'active');

INSERT INTO app.users (id, email_normalized, password_hash, state)
VALUES
  ('7f200000-0000-4000-8000-000000000092', 'm6-a@example.test', 'not-a-login-secret', 'active'),
  ('7f200000-0000-4000-8000-000000000093', 'm6-b@example.test', 'not-a-login-secret', 'active');

INSERT INTO app.tenant_user_access (tenant_id, user_id, access_role, state)
VALUES
  ('7f200000-0000-4000-8000-000000000090', '7f200000-0000-4000-8000-000000000092', 'owner', 'active'),
  ('7f200000-0000-4000-8000-000000000091', '7f200000-0000-4000-8000-000000000093', 'owner', 'active');

CREATE TEMP TABLE execution_baseline AS
SELECT
  (SELECT count(*) FROM app.services) AS services,
  (SELECT count(*) FROM app.runs) AS runs,
  (SELECT count(*) FROM app.run_attempts) AS attempts,
  (SELECT count(*) FROM app.outbox_events) AS outbox_events,
  (SELECT count(*) FROM app.usage_events) AS usage_events;

SET LOCAL ROLE dhumi_customer_api;
SELECT set_config('app.tenant_id', '7f200000-0000-4000-8000-000000000090', true);

SELECT * FROM app.create_marketplace_expert_enquiry(
  '7f200000-0000-4000-8000-000000000030',
  '7f200000-0000-4000-8000-000000000092',
  NULL,
  decode(repeat('71', 32), 'hex'),
  'm6-enquiry-idempotency-0001',
  decode(repeat('72', 32), 'hex'),
  'linkedin-posts',
  1,
  '7f200000-0000-4000-8000-000000000040',
  decode(repeat('73', 32), 'hex')
)
\gset created_

SELECT pg_temp.assert_true(
  :'created_disposition' = 'created'
  AND :'created_enquiry_id'::uuid = '7f200000-0000-4000-8000-000000000030'::uuid
  AND :'created_template_slug' = 'linkedin-posts'
  AND :'created_template_version'::integer = 1
  AND :'created_enquiry_state' = 'received',
  'the first request must create one version-pinned received enquiry'
);

SELECT * FROM app.create_marketplace_expert_enquiry(
  '7f200000-0000-4000-8000-000000000031',
  '7f200000-0000-4000-8000-000000000092', NULL,
  decode(repeat('71', 32), 'hex'), 'm6-enquiry-idempotency-0001',
  decode(repeat('72', 32), 'hex'), 'linkedin-posts', 1,
  '7f200000-0000-4000-8000-000000000041', decode(repeat('74', 32), 'hex')
)
\gset replay_

SELECT pg_temp.assert_true(
  :'replay_disposition' = 'replay'
  AND :'replay_enquiry_id'::uuid = '7f200000-0000-4000-8000-000000000030'::uuid,
  'the same actor, key and request hash must replay the existing enquiry'
);

SELECT * FROM app.create_marketplace_expert_enquiry(
  '7f200000-0000-4000-8000-000000000032',
  '7f200000-0000-4000-8000-000000000092', NULL,
  decode(repeat('71', 32), 'hex'), 'm6-enquiry-idempotency-0001',
  decode(repeat('75', 32), 'hex'), 'linkedin-posts', 1,
  NULL, NULL
)
\gset conflict_

SELECT pg_temp.assert_true(
  :'conflict_disposition' = 'conflict',
  'reusing an idempotency key with a different request must fail closed'
);

SELECT * FROM app.create_marketplace_expert_enquiry(
  '7f200000-0000-4000-8000-000000000033',
  '7f200000-0000-4000-8000-000000000092', NULL,
  decode(repeat('71', 32), 'hex'), 'm6-enquiry-idempotency-0002',
  decode(repeat('72', 32), 'hex'), 'linkedin-posts', 1,
  NULL, NULL
)
\gset existing_

SELECT pg_temp.assert_true(
  :'existing_disposition' = 'existing'
  AND :'existing_enquiry_id'::uuid = '7f200000-0000-4000-8000-000000000030'::uuid,
  'a second key must return the one existing open enquiry for this Tenant and Template'
);

DO $$
BEGIN
  BEGIN
    PERFORM app.create_marketplace_expert_enquiry(
      '7f200000-0000-4000-8000-000000000034',
      '7f200000-0000-4000-8000-000000000092', NULL,
      decode(repeat('71', 32), 'hex'), 'm6-enquiry-idempotency-0003',
      decode(repeat('76', 32), 'hex'), 'linkedin-posts', 2,
      NULL, NULL
    );
    RAISE EXCEPTION 'expected stale Template rejection';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM NOT LIKE '%MARKETPLACE_EXPERT_ENQUIRY_STALE%' THEN RAISE; END IF;
  END;
END;
$$;

SELECT set_config('app.tenant_id', '7f200000-0000-4000-8000-000000000091', true);

SELECT * FROM app.create_marketplace_expert_enquiry(
  '7f200000-0000-4000-8000-000000000035',
  '7f200000-0000-4000-8000-000000000093', NULL,
  decode(repeat('81', 32), 'hex'), 'm6-enquiry-idempotency-0001',
  decode(repeat('72', 32), 'hex'), 'linkedin-posts', 1,
  NULL, NULL
)
\gset tenant_b_

SELECT pg_temp.assert_true(
  :'tenant_b_disposition' = 'created'
  AND :'tenant_b_enquiry_id'::uuid = '7f200000-0000-4000-8000-000000000035'::uuid,
  'a second Tenant must receive its own isolated enquiry'
);

RESET ROLE;

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 2
      AND count(*) FILTER (WHERE tenant_id = '7f200000-0000-4000-8000-000000000090') = 1
      AND count(*) FILTER (WHERE tenant_id = '7f200000-0000-4000-8000-000000000091') = 1
      AND bool_and(state = 'received')
    FROM app.marketplace_expert_enquiries
  ),
  'exactly one received enquiry must exist per Tenant'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 2
      AND bool_and(action = 'marketplace.expert_enquiry.create')
      AND bool_and(outcome = 'received')
      AND bool_and(safe_diff->>'provider_calls' = '0')
      AND bool_and(safe_diff->>'payment_created' = 'false')
      AND bool_and(safe_diff->>'entitlement_created' = 'false')
      AND bool_and(safe_diff->>'run_created' = 'false')
      AND bool_and(safe_diff->>'outbox_event_created' = 'false')
    FROM app.audit_events
    WHERE target_type = 'marketplace_expert_enquiry'
  ),
  'creation must commit one safe provider-free audit per Tenant enquiry'
);

SELECT pg_temp.assert_true(
  (
    SELECT
      baseline.services = (SELECT count(*) FROM app.services)
      AND baseline.runs = (SELECT count(*) FROM app.runs)
      AND baseline.attempts = (SELECT count(*) FROM app.run_attempts)
      AND baseline.outbox_events = (SELECT count(*) FROM app.outbox_events)
      AND baseline.usage_events = (SELECT count(*) FROM app.usage_events)
    FROM execution_baseline AS baseline
  ),
  'M6 must not create execution, queue or usage state'
);

SELECT pg_temp.assert_true(
  has_function_privilege(
    'dhumi_customer_api',
    'app.create_marketplace_expert_enquiry(uuid,uuid,uuid,bytea,text,bytea,text,integer,uuid,bytea)',
    'EXECUTE'
  )
  AND NOT has_table_privilege(
    'dhumi_customer_api',
    'app.marketplace_expert_enquiries',
    'SELECT'
  ),
  'the Customer API must use one narrow function rather than direct table access'
);

SET LOCAL ROLE dhumi_operator;
SELECT set_config('app.tenant_id', '7f200000-0000-4000-8000-000000000090', true);

SELECT * FROM app.transition_marketplace_expert_enquiry(
  '7f200000-0000-4000-8000-000000000030',
  'received',
  'in_review',
  'm6.database.operator'
);
SELECT * FROM app.transition_marketplace_expert_enquiry(
  '7f200000-0000-4000-8000-000000000030',
  'in_review',
  'contacted',
  'm6.database.operator'
);
SELECT * FROM app.transition_marketplace_expert_enquiry(
  '7f200000-0000-4000-8000-000000000030',
  'contacted',
  'closed',
  'm6.database.operator'
);

RESET ROLE;

SELECT pg_temp.assert_true(
  (
    SELECT state = 'closed'
      AND contacted_at IS NOT NULL
      AND closed_at IS NOT NULL
    FROM app.marketplace_expert_enquiries
    WHERE id = '7f200000-0000-4000-8000-000000000030'
  ),
  'the internal lifecycle must follow received to in_review to contacted to closed'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 3
      AND bool_and(safe_diff->>'provider_calls' = '0')
    FROM app.audit_events
    WHERE target_id = '7f200000-0000-4000-8000-000000000030'
      AND action = 'marketplace.expert_enquiry.transition'
  ),
  'each internal transition must be immutably audited without provider work'
);

ROLLBACK;
