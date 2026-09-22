-- Rollback-only Priority 3A database proof. Provider calls: zero.
\set ON_ERROR_STOP on

BEGIN;

CREATE FUNCTION pg_temp.assert_true(value boolean, message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'assertion failed: %', message;
  END IF;
END;
$$;

SET LOCAL ROLE dhumi_operator;

SELECT * FROM app.begin_marketplace_catalog_import(
  '8d000000-0000-4000-8000-000000000001',
  'test',
  'people.contact.database.proof',
  'checkpoint://dataset-market/linkedin-people/contact-database-proof'
);

SELECT app.complete_marketplace_catalog_import(
  '8d000000-0000-4000-8000-000000000001',
  jsonb_build_array(
    jsonb_build_object(
      'id', '8d000000-0000-4000-8000-000000000002',
      'offer_code', 'linkedin.posts',
      'provider_name', 'LinkedIn posts',
      'record_count', NULL,
      'catalogue_entry_checksum_hex', repeat('11', 32),
      'ciphertext_hex', repeat('21', 40),
      'fingerprint_hex', repeat('31', 32),
      'metadata_object_key',
        'qualification/catalog-imports/8d000000-0000-4000-8000-000000000001/metadata/linkedin-posts.json',
      'metadata_checksum_hex', repeat('41', 32),
      'metadata_observed_at', clock_timestamp()
    ),
    jsonb_build_object(
      'id', '8d000000-0000-4000-8000-000000000003',
      'offer_code', 'linkedin.people.standard',
      'provider_name', 'LinkedIn people profiles',
      'record_count', 115000000,
      'catalogue_entry_checksum_hex', repeat('12', 32),
      'ciphertext_hex', repeat('22', 40),
      'fingerprint_hex', repeat('32', 32),
      'metadata_object_key',
        'qualification/catalog-imports/8d000000-0000-4000-8000-000000000001/metadata/linkedin-people-standard.json',
      'metadata_checksum_hex', repeat('42', 32),
      'metadata_observed_at', clock_timestamp()
    )
  ),
  'qualification/catalog-imports/8d000000-0000-4000-8000-000000000001/marketplace-dataset-list.json',
  decode(repeat('51', 32), 'hex'),
  'people.contact.database.proof'
);

SELECT * FROM app.review_marketplace_catalog_candidate(
  '8d000000-0000-4000-8000-000000000002',
  'reject',
  'people.contact.database.reviewer'
);

SELECT * FROM app.review_marketplace_catalog_candidate(
  '8d000000-0000-4000-8000-000000000003',
  'approve',
  'people.contact.database.reviewer'
);

SELECT * FROM app.record_linkedin_people_metadata_observation(
  '8d000000-0000-4000-8000-000000000004',
  '8d000000-0000-4000-8000-000000000003',
  'qualification/catalog-imports/8d000000-0000-4000-8000-000000000004/metadata/linkedin-people-standard.json',
  decode('9b3b7be895b1e063363e46e205c1f9e46864011e6ee76e666ac8a27e0d7a86eb', 'hex'),
  32401,
  46,
  'application/json',
  'checkpoint://dataset-market/linkedin-people/metadata-v1',
  'people.contact.database.proof'
);

RESET ROLE;
SET LOCAL ROLE dhumi_owner;

INSERT INTO app.marketplace_sample_versions (
  id, service_template_version_id, sample_version, source_kind, object_key,
  content_type, record_count, byte_count, checksum, source_metadata_checksum,
  schema_version, masking_policy_version, retention_policy_version,
  provenance_evidence_reference, rights_evidence_reference, collected_at,
  published_at, expires_at, state, qualification_packet_id, field_dictionary,
  governance_state, interim_decision_reference
)
SELECT
  '8d000000-0000-4000-8000-000000000005',
  candidate.service_template_version_id,
  1,
  'synthetic_fixture',
  'marketplace/samples/' || candidate.service_template_version_id::text ||
    '/1/' || repeat('61', 32) || '.json',
  'application/json',
  5,
  2,
  decode(repeat('61', 32), 'hex'),
  observation.metadata_checksum,
  1,
  'linkedin-people-provider-metadata-pii-mask-v1',
  'linkedin-people-sample-30d-v1',
  'fixture://marketplace/linkedin-people/contact-contract-proof-v1',
  NULL,
  observation.observed_at,
  NULL,
  observation.observed_at + interval '720 hours',
  'validated_fixture',
  NULL,
  (
    SELECT jsonb_agg(jsonb_build_object(
      'name', 'proof_field_' || field_number,
      'type', 'text',
      'active', true,
      'required', false,
      'description', 'Synthetic proof field ' || field_number,
      'sample_visibility', 'visible',
      'allowed_operators', jsonb_build_array('='),
      'post_purchase_visibility', 'visible'
    ) ORDER BY field_number)
    FROM generate_series(1, 42) AS field_number
  ),
  'synthetic_fixture',
  NULL
FROM app.catalog_candidates AS candidate
JOIN app.marketplace_catalog_metadata_observations AS observation
  ON observation.catalog_candidate_id = candidate.id
WHERE candidate.id = '8d000000-0000-4000-8000-000000000003';

RESET ROLE;
SET LOCAL ROLE dhumi_operator;

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
      AND bool_and(candidate_id = '8d000000-0000-4000-8000-000000000003')
      AND bool_and(environment = 'test')
      AND bool_and(template_version = 1)
      AND bool_and(metadata_checksum = decode(
        '9b3b7be895b1e063363e46e205c1f9e46864011e6ee76e666ac8a27e0d7a86eb',
        'hex'
      ))
      AND bool_and(sample_version = 1)
    FROM app.resolve_linkedin_people_contact_contract_candidate(
      '8d000000-0000-4000-8000-000000000003'
    )
  ),
  'contact contract must require the completed standard People evidence chain'
);

SELECT * FROM app.record_linkedin_people_contact_contract(
  '8d000000-0000-4000-8000-000000000006',
  '8d000000-0000-4000-8000-000000000003',
  (
    SELECT template_version_id
    FROM app.resolve_linkedin_people_contact_contract_candidate(
      '8d000000-0000-4000-8000-000000000003'
    )
  ),
  1,
  'qualification/contact-contracts/8d000000-0000-4000-8000-000000000006/source-manifest.json',
  decode(repeat('71', 32), 'hex'),
  512,
  'qualification/contact-contracts/8d000000-0000-4000-8000-000000000006/marketplace-faq.md',
  'qualification/contact-contracts/8d000000-0000-4000-8000-000000000006/search-contract.md',
  decode(repeat('81', 48), 'hex'),
  decode(repeat('91', 32), 'hex'),
  'https://docs.brightdata.com/products/marketplace/faqs',
  decode(repeat('a1', 32), 'hex'),
  'https://docs.brightdata.com/api-reference/marketplace-dataset-api/search-dataset',
  decode(repeat('b1', 32), 'hex'),
  current_date,
  'checkpoint://dataset-market/linkedin-people/contact-contract-v1',
  '[
    {
      "code":"standard","display_order":1,
      "customer_meaning":"Standard LinkedIn profile data without a contact-data promise.",
      "preview_state":"available","fulfillment_state":"not_enabled"
    },
    {
      "code":"enriched_when_available","display_order":2,
      "customer_meaning":"Standard profiles plus available business contact information.",
      "preview_state":"not_enabled","fulfillment_state":"not_enabled"
    },
    {
      "code":"contacts_only","display_order":3,
      "customer_meaning":"Only profiles satisfying the provider''s unproven contact-presence semantics.",
      "preview_state":"not_enabled","fulfillment_state":"not_enabled"
    }
  ]'::jsonb,
  0,
  'people.contact.database.proof'
);

RESET ROLE;

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
      AND bool_and(contract_version = 1)
      AND bool_and(governance_state = 'fulfillment_evidence_pending')
      AND bool_and(fulfillment_state = 'not_enabled')
      AND bool_and(provider_calls = 0)
      AND bool_and(octet_length(provider_resource_ciphertext) = 48)
      AND bool_and(octet_length(provider_resource_fingerprint) = 32)
    FROM app.marketplace_contact_contract_packets
    WHERE id = '8d000000-0000-4000-8000-000000000006'
  ),
  'one immutable private contact-contract packet must be recorded'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 3
      AND count(*) FILTER (WHERE preview_state = 'available') = 1
      AND count(*) FILTER (WHERE preview_state = 'not_enabled') = 2
      AND bool_and(fulfillment_state = 'not_enabled')
    FROM app.marketplace_contact_mode_contracts
    WHERE packet_id = '8d000000-0000-4000-8000-000000000006'
  ),
  'the exact three documented modes must exist and fulfillment must stay disabled'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 3
      AND count(*) FILTER (WHERE code = 'standard'
        AND preview_state = 'available') = 1
      AND count(*) FILTER (WHERE code <> 'standard'
        AND preview_state = 'not_enabled') = 2
      AND bool_and(fulfillment_state = 'not_enabled')
    FROM app.resolve_marketplace_contact_modes(
      (
        SELECT service_template_id
        FROM app.service_template_versions
        WHERE id = (
          SELECT service_template_version_id
          FROM app.marketplace_contact_contract_packets
          WHERE id = '8d000000-0000-4000-8000-000000000006'
        )
      ),
      1
    )
  ),
  'customer-safe projection must return exact modes without private evidence'
);

SET LOCAL ROLE dhumi_customer_api;

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 3
      AND bool_and(fulfillment_state = 'not_enabled')
    FROM app.resolve_marketplace_contact_modes(
      (
        SELECT template_id
        FROM app.resolve_marketplace_sample_preview(
          'linkedin-people',
          statement_timestamp()
        )
      ),
      1
    )
  ),
  'customer role must receive only the safe three-mode projection'
);

RESET ROLE;

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
      AND bool_and((safe_diff->>'documented_mode_count')::integer = 3)
      AND bool_and((safe_diff->>'contact_fulfillment_enabled')::boolean = false)
      AND bool_and((safe_diff->>'customer_execution_enabled')::boolean = false)
      AND bool_and((safe_diff->>'provider_calls')::integer = 0)
    FROM app.audit_events
    WHERE action = 'provider.contact_contract.register'
      AND target_id = '8d000000-0000-4000-8000-000000000006'
  ),
  'registration must produce one safe, explicit zero-call audit event'
);

RESET ROLE;

SELECT pg_temp.assert_true(
  NOT has_table_privilege(
    'dhumi_customer_api', 'app.marketplace_contact_contract_packets', 'SELECT'
  )
  AND NOT has_table_privilege(
    'dhumi_customer_api', 'app.marketplace_contact_mode_contracts', 'SELECT'
  )
  AND NOT has_function_privilege(
    'dhumi_customer_api',
    'app.resolve_linkedin_people_contact_contract_candidate(uuid)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'dhumi_customer_api',
    'app.record_linkedin_people_contact_contract(uuid,uuid,uuid,integer,text,bytea,bigint,text,text,bytea,bytea,text,bytea,text,bytea,date,text,jsonb,integer,text)',
    'EXECUTE'
  )
  AND has_function_privilege(
    'dhumi_customer_api',
    'app.resolve_marketplace_contact_modes(uuid,integer)',
    'EXECUTE'
  ),
  'customer API must have no access to private contact evidence'
);

DO $$
BEGIN
  BEGIN
    UPDATE app.marketplace_contact_contract_packets
    SET fulfillment_state = 'not_enabled'
    WHERE id = '8d000000-0000-4000-8000-000000000006';
    RAISE EXCEPTION 'immutable contact packet unexpectedly changed';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;

  BEGIN
    UPDATE app.marketplace_contact_mode_contracts
    SET preview_state = 'not_enabled'
    WHERE packet_id = '8d000000-0000-4000-8000-000000000006'
      AND mode = 'standard';
    RAISE EXCEPTION 'immutable contact mode unexpectedly changed';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END;
$$;

SELECT pg_temp.assert_true(
  NOT EXISTS (SELECT 1 FROM app.services)
  AND NOT EXISTS (SELECT 1 FROM app.runs)
  AND NOT EXISTS (SELECT 1 FROM app.outbox_events)
  AND (
    SELECT current_public_version_id IS NULL
    FROM app.service_templates
    WHERE slug = 'linkedin-people'
  ),
  'contact evidence must not publish or create customer/provider work'
);

ROLLBACK;
