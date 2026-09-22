-- Privileged, rollback-only M5 stored-sample download authorization proof.
-- No provider endpoint, Service, Run, Attempt, outbox event, or usage event is used.
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
  '7f100000-0000-4000-8000-000000000010',
  'test',
  'm5.database.proof',
  'checkpoint://dataset-market/m5/database-proof'
);

SELECT app.complete_marketplace_catalog_import(
  '7f100000-0000-4000-8000-000000000010',
  jsonb_build_array(
    jsonb_build_object(
      'id', '7f100000-0000-4000-8000-000000000011',
      'offer_code', 'linkedin.posts',
      'provider_name', 'LinkedIn posts',
      'record_count', 1000000,
      'catalogue_entry_checksum_hex', repeat('11', 32),
      'ciphertext_hex', repeat('21', 40),
      'fingerprint_hex', repeat('31', 32),
      'metadata_object_key',
        'qualification/catalog-imports/7f100000-0000-4000-8000-000000000010/metadata/linkedin-posts.json',
      'metadata_checksum_hex', repeat('41', 32),
      'metadata_observed_at', '2026-09-11T10:00:00.000Z'
    ),
    jsonb_build_object(
      'id', '7f100000-0000-4000-8000-000000000012',
      'offer_code', 'linkedin.people.standard',
      'provider_name', 'LinkedIn people profiles',
      'record_count', 2000000,
      'catalogue_entry_checksum_hex', repeat('12', 32),
      'ciphertext_hex', repeat('22', 40),
      'fingerprint_hex', repeat('32', 32),
      'metadata_object_key',
        'qualification/catalog-imports/7f100000-0000-4000-8000-000000000010/metadata/linkedin-people-standard.json',
      'metadata_checksum_hex', repeat('42', 32),
      'metadata_observed_at', '2026-09-11T10:00:00.000Z'
    )
  ),
  'qualification/catalog-imports/7f100000-0000-4000-8000-000000000010/marketplace-dataset-list.json',
  decode(repeat('51', 32), 'hex'),
  'm5.database.proof'
);

SELECT * FROM app.review_marketplace_catalog_candidate(
  '7f100000-0000-4000-8000-000000000011',
  'approve',
  'm5.database.reviewer'
);

SELECT template_version_id, metadata_checksum
FROM app.resolve_marketplace_sample_ingestion_target('linkedin-posts', 1)
\gset m5_

-- Seed the governed source using the current schema. This proof covers M5
-- authorization/cleanup, not the superseded M3 fixture-recorder helper (which
-- predates the required dictionary/governance columns added by migration 0057).
RESET ROLE;
INSERT INTO app.marketplace_sample_versions (
  id, service_template_version_id, sample_version, source_kind, object_key,
  content_type, record_count, byte_count, checksum, source_metadata_checksum,
  schema_version, masking_policy_version, retention_policy_version,
  provenance_evidence_reference, collected_at, expires_at, state,
  field_dictionary, governance_state
) VALUES (
  '7f100000-0000-4000-8000-000000000020',
  :'m5_template_version_id'::uuid,
  1,
  'synthetic_fixture',
  'marketplace/samples/' || :'m5_template_version_id' || '/1/' || repeat('61', 32) || '.json',
  'application/json',
  2,
  321,
  decode(repeat('61', 32), 'hex'),
  :'m5_metadata_checksum'::bytea,
  1,
  'linkedin-posts-provider-mask-preservation-v1',
  'linkedin-posts-sample-30d-v1',
  'fixture://marketplace-samples/linkedin-posts-v1',
  statement_timestamp() - interval '1 hour',
  statement_timestamp() - interval '1 hour' + interval '30 days',
  'validated_fixture',
  '[
    {"name":"url","type":"url","active":true,"required":true,
     "description":"LinkedIn post URL","sample_visibility":"visible",
     "allowed_operators":["=","!=","in","not_in","includes","not_includes","is_null","is_not_null"],
     "post_purchase_visibility":"visible"},
    {"name":"text","type":"text","active":true,"required":false,
     "description":"LinkedIn post text","sample_visibility":"masked",
     "allowed_operators":[],"post_purchase_visibility":"visible"}
  ]'::jsonb,
  'synthetic_fixture'
);

RESET ROLE;

INSERT INTO app.tenants (id, display_name, state)
VALUES
  ('7f100000-0000-4000-8000-000000000090', 'M5 Tenant A', 'active'),
  ('7f100000-0000-4000-8000-000000000091', 'M5 Tenant B', 'active');

INSERT INTO app.users (id, email_normalized, password_hash, state)
VALUES
  ('7f100000-0000-4000-8000-000000000092', 'm5-a@example.test', 'not-a-login-secret', 'active'),
  ('7f100000-0000-4000-8000-000000000093', 'm5-b@example.test', 'not-a-login-secret', 'active');

INSERT INTO app.tenant_user_access (tenant_id, user_id, access_role, state)
VALUES
  ('7f100000-0000-4000-8000-000000000090', '7f100000-0000-4000-8000-000000000092', 'owner', 'active'),
  ('7f100000-0000-4000-8000-000000000091', '7f100000-0000-4000-8000-000000000093', 'owner', 'active');

RESET ROLE;
SET LOCAL ROLE dhumi_customer_api;
SELECT set_config('app.tenant_id', '7f100000-0000-4000-8000-000000000090', true);

SELECT * FROM app.reserve_marketplace_sample_download(
  '7f100000-0000-4000-8000-000000000030',
  '7f100000-0000-4000-8000-000000000092',
  NULL,
  decode(repeat('71', 32), 'hex'),
  'm5-download-idempotency-0001',
  decode(repeat('72', 32), 'hex'),
  'linkedin-posts',
  1,
  'json',
  '["url","text"]'::jsonb,
  decode(repeat('73', 32), 'hex'),
  2,
  2,
  'marketplace/sample-downloads/7f100000-0000-4000-8000-000000000090/7f100000-0000-4000-8000-000000000030/' || repeat('74', 32) || '.json',
  'application/json; charset=utf-8',
  'linkedin-posts-sample-v1.json',
  241,
  decode(repeat('74', 32), 'hex'),
  10,
  3600
)
\gset created_

SELECT pg_temp.assert_true(
  :'created_disposition' = 'created'
  AND :'created_stored_state' = 'reserved'
  AND :'created_stored_record_count'::integer = 2,
  'the first exact authorization must reserve one bounded projection'
);

SELECT app.complete_marketplace_sample_download(
  '7f100000-0000-4000-8000-000000000030',
  clock_timestamp() + interval '5 minutes',
  '7f100000-0000-4000-8000-000000000040',
  decode(repeat('75', 32), 'hex')
);

RESET ROLE;

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
      AND bool_and(state = 'authorized')
      AND bool_and(record_limit = 2)
      AND bool_and(record_count = 2)
      AND bool_and(format = 'json')
      AND bool_and(byte_count = 241)
      AND bool_and(encode(checksum, 'hex') = repeat('74', 32))
    FROM app.marketplace_sample_download_authorizations
    WHERE id = '7f100000-0000-4000-8000-000000000030'
  ),
  'the authorization must persist its exact projection metadata'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
      AND bool_and(action = 'marketplace.sample_download_authorize')
      AND bool_and(outcome = 'authorized')
      AND bool_and(safe_diff->>'provider_calls' = '0')
      AND bool_and(safe_diff->>'format' = 'json')
      AND bool_and(safe_diff->>'record_count' = '2')
    FROM app.audit_events
    WHERE target_id = '7f100000-0000-4000-8000-000000000030'
  ),
  'completion must commit exactly one immutable, provider-free authorization audit'
);

SET LOCAL ROLE dhumi_customer_api;
SELECT set_config('app.tenant_id', '7f100000-0000-4000-8000-000000000090', true);

SELECT * FROM app.reserve_marketplace_sample_download(
  '7f100000-0000-4000-8000-000000000031',
  '7f100000-0000-4000-8000-000000000092', NULL,
  decode(repeat('71', 32), 'hex'), 'm5-download-idempotency-0001',
  decode(repeat('72', 32), 'hex'), 'linkedin-posts', 1, 'json',
  '["url","text"]'::jsonb, decode(repeat('73', 32), 'hex'), 2, 2,
  'marketplace/sample-downloads/7f100000-0000-4000-8000-000000000090/7f100000-0000-4000-8000-000000000031/' || repeat('76', 32) || '.json',
  'application/json; charset=utf-8', 'linkedin-posts-sample-v1.json', 241,
  decode(repeat('76', 32), 'hex'), 10, 3600
)
\gset replay_

SELECT pg_temp.assert_true(
  :'replay_disposition' = 'replay'
  AND :'replay_authorization_id'::uuid = '7f100000-0000-4000-8000-000000000030'::uuid,
  'the same actor, key and request hash must replay the existing authorization'
);

SELECT * FROM app.reserve_marketplace_sample_download(
  '7f100000-0000-4000-8000-000000000032',
  '7f100000-0000-4000-8000-000000000092', NULL,
  decode(repeat('71', 32), 'hex'), 'm5-download-idempotency-0001',
  decode(repeat('77', 32), 'hex'), 'linkedin-posts', 1, 'csv',
  '["url"]'::jsonb, decode(repeat('78', 32), 'hex'), 1, 1,
  'marketplace/sample-downloads/7f100000-0000-4000-8000-000000000090/7f100000-0000-4000-8000-000000000032/' || repeat('79', 32) || '.csv',
  'text/csv; charset=utf-8', 'linkedin-posts-sample-v1.csv', 100,
  decode(repeat('79', 32), 'hex'), 10, 3600
)
\gset conflict_

SELECT pg_temp.assert_true(
  :'conflict_disposition' = 'conflict',
  'reusing an idempotency key with a different request must fail closed'
);

DO $$
BEGIN
  BEGIN
    PERFORM app.reserve_marketplace_sample_download(
      '7f100000-0000-4000-8000-000000000033',
      '7f100000-0000-4000-8000-000000000092', NULL,
      decode(repeat('71', 32), 'hex'), 'm5-download-idempotency-0002',
      decode(repeat('81', 32), 'hex'), 'linkedin-posts', 1, 'json',
      '["url"]'::jsonb, decode(repeat('82', 32), 'hex'), 1, 1,
      'marketplace/sample-downloads/7f100000-0000-4000-8000-000000000090/7f100000-0000-4000-8000-000000000033/' || repeat('83', 32) || '.json',
      'application/json; charset=utf-8', 'linkedin-posts-sample-v1.json', 100,
      decode(repeat('83', 32), 'hex'), 1, 3600
    );
    RAISE EXCEPTION 'expected tenant rate limiting';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE '%MARKETPLACE_SAMPLE_DOWNLOAD_RATE_LIMITED%' THEN
      RAISE;
    END IF;
  END;
END;
$$;

SELECT set_config('app.tenant_id', '7f100000-0000-4000-8000-000000000091', true);

DO $$
BEGIN
  BEGIN
    PERFORM app.complete_marketplace_sample_download(
      '7f100000-0000-4000-8000-000000000030',
      clock_timestamp() + interval '5 minutes',
      '7f100000-0000-4000-8000-000000000041',
      decode(repeat('84', 32), 'hex')
    );
    RAISE EXCEPTION 'expected cross-Tenant completion rejection';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;
END;
$$;

SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1 FROM app.get_platform_status_v2('test')
    WHERE family = 'marketplace_dataset'
      AND state = 'operational'
      AND message LIKE 'Preview only:%purchase and full export are not enabled.'
  ),
  'platform status must describe the exact preview-only boundary'
);

RESET ROLE;

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM app.runs
    WHERE tenant_id IN (
      '7f100000-0000-4000-8000-000000000090',
      '7f100000-0000-4000-8000-000000000091'
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM app.run_attempts
    WHERE tenant_id IN (
      '7f100000-0000-4000-8000-000000000090',
      '7f100000-0000-4000-8000-000000000091'
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM app.outbox_events
    WHERE tenant_id IN (
      '7f100000-0000-4000-8000-000000000090',
      '7f100000-0000-4000-8000-000000000091'
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM app.usage_events
    WHERE tenant_id IN (
      '7f100000-0000-4000-8000-000000000090',
      '7f100000-0000-4000-8000-000000000091'
    )
  ),
  'M5 sample download must not create execution, queue or usage state for either fixture Tenant'
);

SELECT pg_temp.assert_true(
  has_function_privilege(
    'dhumi_customer_api',
    'app.reserve_marketplace_sample_download(uuid,uuid,uuid,bytea,text,bytea,text,integer,text,jsonb,bytea,integer,integer,text,text,text,bigint,bytea,integer,integer)',
    'EXECUTE'
  )
  AND NOT has_table_privilege(
    'dhumi_customer_api',
    'app.marketplace_sample_download_authorizations',
    'SELECT'
  ),
  'the Customer API must use narrow functions rather than direct table access'
);

-- Migration 0064: crash recovery, ambiguous completion protection and
-- generated-object retention. Never delete authorization or audit rows.
SET LOCAL ROLE dhumi_customer_api;
SELECT set_config('app.tenant_id', '7f100000-0000-4000-8000-000000000090', true);
DO $$
DECLARE
  case_number integer;
  authorization_id uuid;
BEGIN
  FOR case_number IN 50..55 LOOP
    authorization_id := ('7f100000-0000-4000-8000-' || lpad(case_number::text, 12, '0'))::uuid;
    PERFORM app.reserve_marketplace_sample_download(
      authorization_id,
      '7f100000-0000-4000-8000-000000000092', NULL,
      decode(repeat('71', 32), 'hex'), 'cleanup-proof-idempotency-' || case_number,
      decode(repeat('72', 32), 'hex'), 'linkedin-posts', 1, 'json',
      '["url","text"]'::jsonb, decode(repeat('73', 32), 'hex'), 2, 2,
      'marketplace/sample-downloads/7f100000-0000-4000-8000-000000000090/'
        || authorization_id::text || '/' || repeat('aa', 32) || '.json',
      'application/json; charset=utf-8', 'linkedin-posts-sample-v1.json', 241,
      decode(repeat('aa', 32), 'hex'), 100, 3600
    );
    IF case_number IN (52, 54, 55) THEN
      PERFORM app.complete_marketplace_sample_download(
        authorization_id, clock_timestamp() + interval '5 minutes', NULL, NULL
      );
    END IF;
  END LOOP;
END;
$$;

SELECT pg_temp.assert_true(
  app.fail_marketplace_sample_download_for_cleanup('7f100000-0000-4000-8000-000000000051'),
  'a confirmed reservation failure permits immediate targeted cleanup'
);
SELECT pg_temp.assert_true(
  NOT app.fail_marketplace_sample_download_for_cleanup('7f100000-0000-4000-8000-000000000052'),
  'a committed authorization must survive a lost completion acknowledgement'
);
SELECT set_config('app.tenant_id', '7f100000-0000-4000-8000-000000000091', true);
SELECT pg_temp.assert_true(
  NOT app.fail_marketplace_sample_download_for_cleanup('7f100000-0000-4000-8000-000000000050'),
  'another Tenant cannot fail or reclaim a reservation'
);

RESET ROLE;
UPDATE app.marketplace_sample_download_authorizations
SET created_at = clock_timestamp() - interval '2 hours'
WHERE id = '7f100000-0000-4000-8000-000000000053';
UPDATE app.marketplace_sample_download_authorizations
SET authorized_at = clock_timestamp() - interval '3 hours',
    download_expires_at = clock_timestamp() - interval '2 hours'
WHERE id = '7f100000-0000-4000-8000-000000000054';
UPDATE app.marketplace_sample_download_authorizations
SET authorized_at = clock_timestamp() - interval '30 minutes',
    download_expires_at = clock_timestamp() - interval '1 minute'
WHERE id = '7f100000-0000-4000-8000-000000000055';

SET LOCAL ROLE dhumi_operator;
DO $$
DECLARE
  case_number integer;
  authorization_id uuid;
  expected_disposition text;
  actual record;
BEGIN
  FOR case_number IN 50..55 LOOP
    authorization_id := ('7f100000-0000-4000-8000-' || lpad(case_number::text, 12, '0'))::uuid;
    expected_disposition := CASE WHEN case_number IN (51, 53, 54) THEN 'eligible' ELSE 'protected' END;
    SELECT * INTO actual FROM app.claim_marketplace_sample_download_cleanup(
      '7f100000-0000-4000-8000-000000000090', authorization_id,
      'marketplace/sample-downloads/7f100000-0000-4000-8000-000000000090/'
        || authorization_id::text || '/' || repeat('aa', 32) || '.json'
    );
    PERFORM pg_temp.assert_true(actual.disposition = expected_disposition,
      'cleanup eligibility for case ' || case_number);
    IF actual.disposition = 'eligible' THEN
      PERFORM pg_temp.assert_true(actual.stored_byte_count = 241
        AND actual.stored_checksum = decode(repeat('aa', 32), 'hex'),
        'cleanup must return the exact authorized receipt');
    END IF;
  END LOOP;
  PERFORM pg_temp.assert_true(app.current_tenant_id() = '7f100000-0000-4000-8000-000000000091',
    'operator cleanup restores prior Tenant context');
  SELECT * INTO actual FROM app.claim_marketplace_sample_download_cleanup(
    '7f100000-0000-4000-8000-000000000091',
    '7f100000-0000-4000-8000-000000000051',
    'marketplace/sample-downloads/7f100000-0000-4000-8000-000000000090/'
      || '7f100000-0000-4000-8000-000000000051/' || repeat('aa', 32) || '.json'
  );
  PERFORM pg_temp.assert_true(actual.disposition = 'untracked', 'wrong Tenant/object key must fail closed');
END;
$$;

RESET ROLE;
SELECT pg_temp.assert_true(
  (SELECT state = 'failed' FROM app.marketplace_sample_download_authorizations
    WHERE id = '7f100000-0000-4000-8000-000000000053')
  AND (SELECT state = 'authorized' FROM app.marketplace_sample_download_authorizations
    WHERE id = '7f100000-0000-4000-8000-000000000052')
  AND (SELECT count(*) = 1 FROM app.audit_events
    WHERE target_id = '7f100000-0000-4000-8000-000000000052'),
  'abandoned reservations are fenced; committed authorizations/audits stay intact'
);

SET LOCAL ROLE dhumi_customer_api;
SELECT set_config('app.tenant_id', '7f100000-0000-4000-8000-000000000090', true);
DO $$
BEGIN
  BEGIN
    PERFORM app.complete_marketplace_sample_download(
      '7f100000-0000-4000-8000-000000000053', clock_timestamp() + interval '5 minutes', NULL, NULL
    );
    RAISE EXCEPTION 'expected late completion to be fenced';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END;
$$;
RESET ROLE;

SELECT pg_temp.assert_true(
  NOT has_function_privilege('dhumi_customer_api',
    'app.claim_marketplace_sample_download_cleanup(uuid,uuid,text)', 'EXECUTE')
  AND has_function_privilege('dhumi_operator',
    'app.claim_marketplace_sample_download_cleanup(uuid,uuid,text)', 'EXECUTE')
  AND NOT has_table_privilege('dhumi_operator', 'app.marketplace_sample_download_authorizations', 'SELECT'),
  'global cleanup is operator-only and grants no direct table access'
);

ROLLBACK;
