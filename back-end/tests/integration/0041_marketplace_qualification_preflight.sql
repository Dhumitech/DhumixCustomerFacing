-- M9: rollback-only qualification-packet and single-submission gate proof.
--
-- This proof uses protected fixture identifiers only. It performs no network
-- I/O, creates no customer execution path and makes zero provider calls.
\set ON_ERROR_STOP on
\pset pager off

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
  '81000000-0000-4000-8000-000000000010',
  'test',
  'm9.database.proof',
  'checkpoint://dataset-market/m9/database-proof'
);

SELECT app.complete_marketplace_catalog_import(
  '81000000-0000-4000-8000-000000000010',
  jsonb_build_array(
    jsonb_build_object(
      'id', '81000000-0000-4000-8000-000000000011',
      'offer_code', 'linkedin.posts',
      'provider_name', 'LinkedIn posts',
      'record_count', 500000,
      'catalogue_entry_checksum_hex', repeat('11', 32),
      'ciphertext_hex', repeat('21', 40),
      'fingerprint_hex', repeat('31', 32),
      'metadata_object_key',
        'qualification/catalog-imports/81000000-0000-4000-8000-000000000010/metadata/linkedin-posts.json',
      'metadata_checksum_hex', repeat('41', 32),
      'metadata_observed_at', '2026-09-12T10:00:00.000Z'
    ),
    jsonb_build_object(
      'id', '81000000-0000-4000-8000-000000000012',
      'offer_code', 'linkedin.people.standard',
      'provider_name', 'LinkedIn people profiles',
      'record_count', 115000000,
      'catalogue_entry_checksum_hex', repeat('12', 32),
      'ciphertext_hex', repeat('22', 40),
      'fingerprint_hex', repeat('32', 32),
      'metadata_object_key',
        'qualification/catalog-imports/81000000-0000-4000-8000-000000000010/metadata/linkedin-people-standard.json',
      'metadata_checksum_hex', repeat('42', 32),
      'metadata_observed_at', '2026-09-12T10:00:00.000Z'
    )
  ),
  'qualification/catalog-imports/81000000-0000-4000-8000-000000000010/marketplace-dataset-list.json',
  decode(repeat('51', 32), 'hex'),
  'm9.database.proof'
);

SELECT * FROM app.review_marketplace_catalog_candidate(
  '81000000-0000-4000-8000-000000000011',
  'approve',
  'm9.database.reviewer'
);
SELECT * FROM app.review_marketplace_catalog_candidate(
  '81000000-0000-4000-8000-000000000012',
  'reject',
  'm9.database.reviewer'
);

RESET ROLE;
CREATE TEMP TABLE m9_context AS
SELECT * FROM app.resolve_marketplace_qualification_context(
  '81000000-0000-4000-8000-000000000011',
  'test'
);
GRANT SELECT ON m9_context TO dhumi_operator;

SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM m9_context),
  'one approved LinkedIn Posts candidate must resolve through the disabled M7 boundary'
);
SELECT pg_temp.assert_true(
  (
    SELECT output_schema -> 'items' -> 'properties' ?& ARRAY['url', 'text']
      AND (
        SELECT count(*)
        FROM jsonb_object_keys(output_schema -> 'items' -> 'properties')
      ) = 2
    FROM m9_context
  ),
  'the packet must use only the two governed M4/M7 fields'
);

SET LOCAL ROLE dhumi_operator;
SELECT packet.*
FROM m9_context AS context
CROSS JOIN LATERAL app.prepare_marketplace_qualification_packet(
  '81000000-0000-4000-8000-000000000020',
  context.candidate_id,
  context.template_version_id,
  context.filter_adapter_version_id,
  'test',
  context.provider_resource_fingerprint,
  '{
    "records_limit":100,
    "selected_fields":["url","text"],
    "filter":{"name":"url","operator":"is_not_null"}
  }'::jsonb,
  250000,
  'USD',
  1,
  0,
  300000,
  ARRAY[
    'authorization_audit', 'request', 'protected_snapshot_reference',
    'poll_checkpoints', 'raw_artifact', 'normalized_artifact',
    'checksums', 'cost', 'execution_audit'
  ]::text[],
  'm9.database.proof'
) AS packet;

RESET ROLE;
CREATE TEMP TABLE prepared AS
SELECT id AS packet_id, request_fingerprint, authorization_state
FROM app.marketplace_qualification_packets
WHERE id = '81000000-0000-4000-8000-000000000020';
GRANT SELECT ON prepared TO dhumi_operator;

SELECT pg_temp.assert_true(
  (
    SELECT authorization_state = 'not_authorized'
      AND octet_length(request_fingerprint) = 32
    FROM prepared
  ),
  'a prepared packet must be fingerprinted and explicitly not authorized'
);

SET LOCAL ROLE dhumi_operator;
DO $$
DECLARE fingerprint bytea := (SELECT request_fingerprint FROM prepared);
BEGIN
  PERFORM * FROM app.claim_marketplace_qualification_submission(
    '81000000-0000-4000-8000-000000000020', fingerprint, 'm9.database.proof'
  );
  RAISE EXCEPTION 'missing authorization unexpectedly admitted a submission';
EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM <> 'MARKETPLACE_QUALIFICATION_NOT_AUTHORIZED' THEN RAISE; END IF;
END;
$$;

DO $$
DECLARE fingerprint bytea := (SELECT request_fingerprint FROM prepared);
BEGIN
  PERFORM app.authorize_marketplace_qualification_packet(
    '81000000-0000-4000-8000-000000000020',
    fingerprint,
    101,
    250000,
    'USD',
    1,
    0,
    'checkpoint://dataset-market/m9/authorization/database-proof',
    decode(repeat('61', 32), 'hex'),
    'm9.release.owner',
    clock_timestamp() - interval '1 minute',
    clock_timestamp() + interval '1 hour'
  );
  RAISE EXCEPTION 'a mutated record ceiling unexpectedly matched authorization';
EXCEPTION WHEN SQLSTATE '22023' THEN
  IF SQLERRM <> 'MARKETPLACE_QUALIFICATION_AUTHORIZATION_MISMATCH' THEN RAISE; END IF;
END;
$$;

SELECT pg_temp.assert_true(
  app.authorize_marketplace_qualification_packet(
    '81000000-0000-4000-8000-000000000020',
    (SELECT request_fingerprint FROM prepared),
    100,
    250000,
    'USD',
    1,
    0,
    'checkpoint://dataset-market/m9/authorization/database-proof',
    decode(repeat('61', 32), 'hex'),
    'm9.release.owner',
    clock_timestamp() - interval '1 minute',
    clock_timestamp() + interval '1 hour'
  ) = 'authorized',
  'the exact bounded authorization must be recorded'
);

DO $$
BEGIN
  PERFORM packet.*
  FROM m9_context AS context
  CROSS JOIN LATERAL app.prepare_marketplace_qualification_packet(
    '81000000-0000-4000-8000-000000000020',
    context.candidate_id,
    context.template_version_id,
    context.filter_adapter_version_id,
    'test',
    context.provider_resource_fingerprint,
    '{
      "records_limit":100,
      "selected_fields":["url","text"],
      "filter":{"name":"url","operator":"is_not_null"}
    }'::jsonb,
    250000, 'USD', 1, 0, 300000,
    ARRAY[
      'authorization_audit', 'request', 'protected_snapshot_reference',
      'poll_checkpoints', 'raw_artifact', 'normalized_artifact',
      'checksums', 'cost', 'execution_audit'
    ]::text[],
    'm9.database.proof'
  ) AS packet;
  RAISE EXCEPTION 'an authorized packet unexpectedly accepted prepare replay';
EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM <> 'MARKETPLACE_QUALIFICATION_PACKET_REPLAY_CONFLICT' THEN RAISE; END IF;
END;
$$;

DO $$
DECLARE fingerprint bytea := (SELECT request_fingerprint FROM prepared);
BEGIN
  PERFORM * FROM app.claim_marketplace_qualification_submission(
    '81000000-0000-4000-8000-000000000020',
    sha256(convert_to('mutated', 'UTF8')),
    'm9.database.proof'
  );
  RAISE EXCEPTION 'a mutated request fingerprint unexpectedly claimed submission';
EXCEPTION WHEN SQLSTATE '22023' THEN
  IF SQLERRM <> 'MARKETPLACE_QUALIFICATION_AUTHORIZATION_MISMATCH' THEN RAISE; END IF;
END;
$$;

SELECT * FROM app.claim_marketplace_qualification_submission(
  '81000000-0000-4000-8000-000000000020',
  (SELECT request_fingerprint FROM prepared),
  'm9.database.proof'
);

RESET ROLE;
SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
      AND bool_and(octet_length(candidate.provider_resource_ciphertext) = 40)
      AND bool_and(octet_length(candidate.provider_resource_fingerprint) = 32)
      AND bool_and(packet.maximum_estimated_cost_micros = 250000)
      AND bool_and(packet.currency_code = 'USD')
    FROM app.marketplace_qualification_packets AS packet
    JOIN app.catalog_candidates AS candidate
      ON candidate.id = packet.catalog_candidate_id
    WHERE packet.id = '81000000-0000-4000-8000-000000000020'
  ),
  'the claim must return one protected, exactly bounded execution packet'
);

SET LOCAL ROLE dhumi_operator;
DO $$
DECLARE fingerprint bytea := (SELECT request_fingerprint FROM prepared);
BEGIN
  PERFORM * FROM app.claim_marketplace_qualification_submission(
    '81000000-0000-4000-8000-000000000020', fingerprint, 'm9.database.proof'
  );
  RAISE EXCEPTION 'a duplicate provider submission was unexpectedly admitted';
EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM <> 'MARKETPLACE_QUALIFICATION_SUBMISSION_ALREADY_CLAIMED' THEN RAISE; END IF;
END;
$$;

SELECT app.record_marketplace_qualification_submission_start(
  '81000000-0000-4000-8000-000000000020',
  'qualification/operations/81000000-0000-4000-8000-000000000020/request.json',
  decode(repeat('71', 32), 'hex'),
  'application/json',
  128,
  'm9.database.proof'
);
SELECT app.record_marketplace_qualification_snapshot_reference(
  '81000000-0000-4000-8000-000000000020',
  decode(repeat('72', 40), 'hex'),
  decode(repeat('73', 32), 'hex'),
  'm9.database.proof'
);
SELECT app.record_marketplace_qualification_poll_checkpoint(
  '81000000-0000-4000-8000-000000000020',
  'scheduled', NULL, 'm9.database.proof'
);
SELECT app.record_marketplace_qualification_poll_checkpoint(
  '81000000-0000-4000-8000-000000000020',
  'building', NULL, 'm9.database.proof'
);
SELECT app.record_marketplace_qualification_poll_checkpoint(
  '81000000-0000-4000-8000-000000000020',
  'ready', NULL, 'm9.database.proof'
);
SELECT app.complete_marketplace_qualification_success(
  '81000000-0000-4000-8000-000000000020',
  'qualification/operations/81000000-0000-4000-8000-000000000020/raw.json',
  decode(repeat('74', 32), 'hex'), 'application/json', 512, 1,
  'qualification/operations/81000000-0000-4000-8000-000000000020/normalized.json',
  decode(repeat('75', 32), 'hex'), 'application/json', 256, 1,
  2500, 'USD', 'm9.database.proof', 'provider_execution_completed'
);

RESET ROLE;
DO $$
BEGIN
  UPDATE app.marketplace_qualification_packets
  SET exact_request = jsonb_set(exact_request, '{records_limit}', '101'::jsonb)
  WHERE id = '81000000-0000-4000-8000-000000000020';
  RAISE EXCEPTION 'immutable packet bytes were unexpectedly changed';
EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM <> 'MARKETPLACE_QUALIFICATION_PACKET_IMMUTABLE' THEN RAISE; END IF;
END;
$$;

-- A second packet receives a valid but not-yet-effective authorization. The
-- claim must reject it without consuming the submission budget.
SET LOCAL ROLE dhumi_operator;
SELECT packet.*
FROM m9_context AS context
CROSS JOIN LATERAL app.prepare_marketplace_qualification_packet(
  '81000000-0000-4000-8000-000000000030',
  context.candidate_id,
  context.template_version_id,
  context.filter_adapter_version_id,
  'test',
  context.provider_resource_fingerprint,
  '{
    "records_limit":10,
    "selected_fields":["url"],
    "filter":{"name":"url","operator":"is_not_null"}
  }'::jsonb,
  50000,
  'USD', 1, 0, 300000,
    ARRAY[
      'authorization_audit', 'request', 'protected_snapshot_reference',
      'poll_checkpoints', 'raw_artifact', 'normalized_artifact',
      'checksums', 'cost', 'execution_audit'
    ]::text[],
  'm9.database.proof'
) AS packet;

RESET ROLE;
CREATE TEMP TABLE future_packet AS
SELECT id AS packet_id, request_fingerprint, authorization_state
FROM app.marketplace_qualification_packets
WHERE id = '81000000-0000-4000-8000-000000000030';
GRANT SELECT ON future_packet TO dhumi_operator;

SET LOCAL ROLE dhumi_operator;
SELECT app.authorize_marketplace_qualification_packet(
  '81000000-0000-4000-8000-000000000030',
  (SELECT request_fingerprint FROM future_packet),
  10, 50000, 'USD', 1, 0,
  'checkpoint://dataset-market/m9/authorization/future-proof',
  decode(repeat('62', 32), 'hex'),
  'm9.release.owner',
  clock_timestamp() + interval '10 minutes',
  clock_timestamp() + interval '20 minutes'
);

DO $$
DECLARE fingerprint bytea := (SELECT request_fingerprint FROM future_packet);
BEGIN
  PERFORM * FROM app.claim_marketplace_qualification_submission(
    '81000000-0000-4000-8000-000000000030', fingerprint, 'm9.database.proof'
  );
  RAISE EXCEPTION 'inactive authorization unexpectedly admitted a submission';
EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM <> 'MARKETPLACE_QUALIFICATION_AUTHORIZATION_EXPIRED' THEN RAISE; END IF;
END;
$$;

RESET ROLE;

-- A third packet is authorized while valid, then must fail closed after its
-- exact authorization window expires. The wait advances local database time
-- only and performs no network or provider operation.
SET LOCAL ROLE dhumi_operator;
SELECT packet.*
FROM m9_context AS context
CROSS JOIN LATERAL app.prepare_marketplace_qualification_packet(
  '81000000-0000-4000-8000-000000000040',
  context.candidate_id,
  context.template_version_id,
  context.filter_adapter_version_id,
  'test',
  context.provider_resource_fingerprint,
  '{
    "records_limit":5,
    "selected_fields":["url"],
    "filter":{"name":"url","operator":"is_not_null"}
  }'::jsonb,
  25000,
  'USD', 1, 0, 300000,
  ARRAY[
    'authorization_audit', 'request', 'protected_snapshot_reference',
    'poll_checkpoints', 'raw_artifact', 'normalized_artifact',
    'checksums', 'cost', 'execution_audit'
  ]::text[],
  'm9.database.proof'
) AS packet;

RESET ROLE;
CREATE TEMP TABLE expiring_packet AS
SELECT id AS packet_id, request_fingerprint, authorization_state
FROM app.marketplace_qualification_packets
WHERE id = '81000000-0000-4000-8000-000000000040';
GRANT SELECT ON expiring_packet TO dhumi_operator;

SET LOCAL ROLE dhumi_operator;
SELECT app.authorize_marketplace_qualification_packet(
  '81000000-0000-4000-8000-000000000040',
  (SELECT request_fingerprint FROM expiring_packet),
  5, 25000, 'USD', 1, 0,
  'checkpoint://dataset-market/m9/authorization/expiry-proof',
  decode(repeat('63', 32), 'hex'),
  'm9.release.owner',
  clock_timestamp() - interval '1 minute',
  clock_timestamp() + interval '1 second'
);
SELECT pg_sleep(1.2);

DO $$
DECLARE fingerprint bytea := (SELECT request_fingerprint FROM expiring_packet);
BEGIN
  PERFORM * FROM app.claim_marketplace_qualification_submission(
    '81000000-0000-4000-8000-000000000040', fingerprint, 'm9.database.proof'
  );
  RAISE EXCEPTION 'expired authorization unexpectedly admitted a submission';
EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM <> 'MARKETPLACE_QUALIFICATION_AUTHORIZATION_EXPIRED' THEN RAISE; END IF;
END;
$$;

RESET ROLE;

SELECT pg_temp.assert_true(
  (
    SELECT authorization_state = 'consumed'
      AND provider_submission_count = 1
      AND submission_claimed_at IS NOT NULL
      AND execution_state = 'succeeded'
      AND provider_poll_count = 3
      AND raw_record_count = 1
      AND normalized_record_count = 1
      AND observed_cost_micros = 2500
    FROM app.marketplace_qualification_packets
    WHERE id = '81000000-0000-4000-8000-000000000020'
  ),
  'one submission must retain a complete exact qualification evidence lifecycle'
);
SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 3
      AND min(sequence) = 1
      AND max(sequence) = 3
      AND bool_or(provider_status = 'ready')
    FROM app.marketplace_qualification_poll_checkpoints
    WHERE marketplace_qualification_packet_id =
      '81000000-0000-4000-8000-000000000020'
  ),
  'the protected Snapshot lifecycle must retain ordered poll checkpoints'
);
SELECT pg_temp.assert_true(
  (
    SELECT authorization_state = 'authorized'
      AND provider_submission_count = 0
    FROM app.marketplace_qualification_packets
    WHERE id = '81000000-0000-4000-8000-000000000030'
  ),
  'an inactive authorization must consume no provider submission slot'
);
SELECT pg_temp.assert_true(
  (
    SELECT authorization_state = 'authorized'
      AND provider_submission_count = 0
    FROM app.marketplace_qualification_packets
    WHERE id = '81000000-0000-4000-8000-000000000040'
  ),
  'an expired authorization must consume no provider submission slot'
);
SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 7
    FROM app.audit_events
    WHERE target_type = 'marketplace_qualification_packet'
      AND target_id IN (
        '81000000-0000-4000-8000-000000000020',
        '81000000-0000-4000-8000-000000000030',
        '81000000-0000-4000-8000-000000000040'
      )
      AND action IN (
        'provider.marketplace_qualification.prepare',
        'provider.marketplace_qualification.authorize',
        'provider.marketplace_qualification.submission_claim'
      )
  ),
  'prepare, authorization and the one successful claim must be auditable'
);
SELECT pg_temp.assert_true(
  NOT has_table_privilege(
    'dhumi_customer_api', 'app.marketplace_qualification_packets', 'SELECT'
  )
  AND NOT has_function_privilege(
    'dhumi_customer_api',
    'app.claim_marketplace_qualification_submission(uuid,bytea,text)',
    'EXECUTE'
  ),
  'the Customer API must not read packets or claim provider submissions'
);
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM app.provider_mappings AS mapping
    JOIN app.adapter_versions AS adapter ON adapter.id = mapping.adapter_version_id
    JOIN app.adapter_definitions AS definition
      ON definition.id = adapter.adapter_definition_id
    WHERE definition.code = 'bright_data.marketplace.filter'
      AND adapter.semantic_version = '1.0.0-m7-fixture'
  )
  AND NOT EXISTS (
    SELECT 1 FROM app.services
    WHERE service_template_id = (
      SELECT service_template_id FROM app.service_template_versions
      WHERE id = (SELECT template_version_id FROM m9_context)
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM app.runs
    WHERE service_template_version_id = (SELECT template_version_id FROM m9_context)
  ),
  'M9 preflight must create no mapping, Service, Run or customer execution path'
);

ROLLBACK;
