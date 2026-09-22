-- M10: rollback-only disabled Marketplace export-candidate proof.
-- Protected fixture bytes only; no network or provider call is possible here.
\set ON_ERROR_STOP on
\pset pager off

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
  '82000000-0000-4000-8000-000000000010',
  'test',
  'm10.database.proof',
  'checkpoint://dataset-market/m10/database-proof'
);

SELECT app.complete_marketplace_catalog_import(
  '82000000-0000-4000-8000-000000000010',
  jsonb_build_array(
    jsonb_build_object(
      'id', '82000000-0000-4000-8000-000000000011',
      'offer_code', 'linkedin.posts',
      'provider_name', 'LinkedIn posts',
      'record_count', 500000,
      'catalogue_entry_checksum_hex', repeat('11', 32),
      'ciphertext_hex', repeat('21', 40),
      'fingerprint_hex', repeat('31', 32),
      'metadata_object_key',
        'qualification/catalog-imports/82000000-0000-4000-8000-000000000010/metadata/linkedin-posts.json',
      'metadata_checksum_hex', repeat('41', 32),
      'metadata_observed_at', '2026-09-13T10:00:00.000Z'
    ),
    jsonb_build_object(
      'id', '82000000-0000-4000-8000-000000000012',
      'offer_code', 'linkedin.people.standard',
      'provider_name', 'LinkedIn people profiles',
      'record_count', 115000000,
      'catalogue_entry_checksum_hex', repeat('12', 32),
      'ciphertext_hex', repeat('22', 40),
      'fingerprint_hex', repeat('32', 32),
      'metadata_object_key',
        'qualification/catalog-imports/82000000-0000-4000-8000-000000000010/metadata/linkedin-people-standard.json',
      'metadata_checksum_hex', repeat('42', 32),
      'metadata_observed_at', '2026-09-13T10:00:00.000Z'
    )
  ),
  'qualification/catalog-imports/82000000-0000-4000-8000-000000000010/marketplace-dataset-list.json',
  decode(repeat('51', 32), 'hex'),
  'm10.database.proof'
);

SELECT * FROM app.review_marketplace_catalog_candidate(
  '82000000-0000-4000-8000-000000000011',
  'approve',
  'm10.database.reviewer'
);
SELECT * FROM app.review_marketplace_catalog_candidate(
  '82000000-0000-4000-8000-000000000012',
  'reject',
  'm10.database.reviewer'
);

RESET ROLE;
CREATE TEMP TABLE m10_context AS
SELECT * FROM app.resolve_marketplace_qualification_context(
  '82000000-0000-4000-8000-000000000011',
  'test'
);
GRANT SELECT ON m10_context TO dhumi_operator;

SET LOCAL ROLE dhumi_operator;
SELECT packet.*
FROM m10_context AS context
CROSS JOIN LATERAL app.prepare_marketplace_qualification_packet(
  '2e1560c3-ca8b-40a0-b578-c9e71ecf27cd',
  context.candidate_id,
  context.template_version_id,
  context.filter_adapter_version_id,
  'test',
  context.provider_resource_fingerprint,
  '{
    "records_limit":5,
    "selected_fields":["url","text"],
    "filter":{"name":"url","operator":"is_not_null"}
  }'::jsonb,
  12500,
  'USD', 1, 0, 300000,
  ARRAY[
    'authorization_audit', 'request', 'protected_snapshot_reference',
    'poll_checkpoints', 'raw_artifact', 'normalized_artifact',
    'checksums', 'cost', 'execution_audit'
  ]::text[],
  'm10.database.proof'
) AS packet;

RESET ROLE;
CREATE TEMP TABLE prepared AS
SELECT id AS packet_id, request_fingerprint
FROM app.marketplace_qualification_packets
WHERE id = '2e1560c3-ca8b-40a0-b578-c9e71ecf27cd';
GRANT SELECT ON prepared TO dhumi_operator;

SET LOCAL ROLE dhumi_operator;
SELECT app.authorize_marketplace_qualification_packet(
  '2e1560c3-ca8b-40a0-b578-c9e71ecf27cd',
  (SELECT request_fingerprint FROM prepared),
  5, 12500, 'USD', 1, 0,
  'checkpoint://dataset-market/m10/fixture-authorization',
  decode(repeat('61', 32), 'hex'),
  'm10.release.owner',
  clock_timestamp() - interval '1 minute',
  clock_timestamp() + interval '1 hour'
);

SELECT * FROM app.claim_marketplace_qualification_submission(
  '2e1560c3-ca8b-40a0-b578-c9e71ecf27cd',
  (SELECT request_fingerprint FROM prepared),
  'm10.database.proof'
);

SELECT app.record_marketplace_qualification_submission_start(
  '2e1560c3-ca8b-40a0-b578-c9e71ecf27cd',
  'qualification/operations/2e1560c3-ca8b-40a0-b578-c9e71ecf27cd/request.json',
  decode('f8041530994ed911795f56aa605fde3d11000b8da3c7c587e41cb7da67155e1f', 'hex'),
  'application/json', 106,
  'm10.database.proof'
);
SELECT app.record_marketplace_qualification_snapshot_reference(
  '2e1560c3-ca8b-40a0-b578-c9e71ecf27cd',
  decode(repeat('72', 40), 'hex'), decode(repeat('73', 32), 'hex'),
  'm10.database.proof'
);
SELECT app.record_marketplace_qualification_poll_checkpoint(
  '2e1560c3-ca8b-40a0-b578-c9e71ecf27cd', 'ready', NULL,
  'm10.database.proof'
);
SELECT app.complete_marketplace_qualification_success(
  '2e1560c3-ca8b-40a0-b578-c9e71ecf27cd',
  'qualification/operations/2e1560c3-ca8b-40a0-b578-c9e71ecf27cd/raw.json',
  decode('d5a9c6c3403959349925d0574195e12e511ab2e861d421938e53b4a6738f6c95', 'hex'),
  'application/json', 25858, 5,
  'qualification/operations/2e1560c3-ca8b-40a0-b578-c9e71ecf27cd/normalized.json',
  decode('7e0f8497a7e02933b2c395a42b2215477f7aae4803762b30bda5e9d3f09bd170', 'hex'),
  'application/json', 675, 5,
  0, 'USD', 'm10.database.proof', 'provider_execution_completed'
);

SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM app.resolve_marketplace_export_candidate_source(
    '2e1560c3-ca8b-40a0-b578-c9e71ecf27cd',
    '82000000-0000-4000-8000-000000000030'
  )),
  'the exact successful M9-shaped packet must resolve one protected source'
);

SELECT * FROM app.register_marketplace_export_candidate_v1(
  '2e1560c3-ca8b-40a0-b578-c9e71ecf27cd',
  '82000000-0000-4000-8000-000000000030',
  decode(repeat('81', 40), 'hex'),
  decode(repeat('91', 32), 'hex'),
  'm10.release.owner',
  'checkpoint://dataset-market/m10/technical-acceptance',
  'accept_exact_m9_evidence_as_disabled_candidate'
);

RESET ROLE;

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
      AND bool_and(mapping.state = 'disabled')
      AND bool_and(mapping.provider_resource_aad_mapping_id = mapping.id)
      AND bool_and(adapter.state = 'disabled')
      AND bool_and(adapter.semantic_version = '1.0.0-m10-candidate')
      AND bool_and(adapter.capability_metadata @> '{
        "provider_http_enabled":false,
        "customer_execution_enabled":false,
        "can_purchase":false,
        "can_execute":false,
        "can_publish":false
      }'::jsonb)
    FROM app.marketplace_export_candidates AS candidate
    JOIN app.provider_mappings AS mapping
      ON mapping.id = candidate.provider_mapping_id
    JOIN app.adapter_versions AS adapter
      ON adapter.id = candidate.adapter_version_id
    WHERE candidate.marketplace_qualification_packet_id =
      '2e1560c3-ca8b-40a0-b578-c9e71ecf27cd'
      AND candidate.state = 'disabled_candidate'
  ),
  'M10 must create exactly one disabled and self-AAD-bound technical mapping'
);

SELECT pg_temp.assert_true(
  (
    SELECT template.state = 'draft'
      AND template.current_public_version_id IS NULL
      AND count(*) FILTER (WHERE version.version = 1) = 1
      AND count(*) FILTER (
        WHERE version.version = 2
          AND version.availability_state = 'coming_soon'
          AND version.effective_at IS NULL
          AND version.published_at IS NULL
      ) = 1
    FROM app.service_templates AS template
    JOIN app.service_template_versions AS version
      ON version.service_template_id = template.id
    WHERE template.slug = 'linkedin-posts'
    GROUP BY template.state, template.current_public_version_id
  ),
  'the original preview identity must remain draft and unpointed beside private v2'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM app.services AS service
    JOIN app.service_templates AS template ON template.id = service.service_template_id
    WHERE template.slug = 'linkedin-posts'
  )
  AND NOT EXISTS (
    SELECT 1 FROM app.runs AS run
    JOIN app.service_template_versions AS version
      ON version.id = run.service_template_version_id
    JOIN app.service_templates AS template ON template.id = version.service_template_id
    WHERE template.slug = 'linkedin-posts'
  )
  AND NOT EXISTS (
    SELECT 1 FROM app.outbox_events AS event
    WHERE event.aggregate_id = '82000000-0000-4000-8000-000000000030'
  ),
  'M10 must create no Service, Run or queue work'
);

SELECT pg_temp.assert_true(
  NOT has_table_privilege(
    'dhumi_customer_api', 'app.marketplace_export_candidates', 'SELECT'
  )
  AND NOT has_function_privilege(
    'dhumi_customer_api',
    'app.resolve_marketplace_export_candidate_source(uuid,uuid)', 'EXECUTE'
  )
  AND NOT has_function_privilege(
    'dhumi_customer_api',
    'app.register_marketplace_export_candidate_v1(uuid,uuid,bytea,bytea,text,text,text)',
    'EXECUTE'
  ),
  'the Customer API must not read or mutate protected M10 configuration'
);

SET LOCAL ROLE dhumi_operator;
SELECT pg_temp.assert_true(
  (SELECT disposition = 'replayed'
   FROM app.register_marketplace_export_candidate_v1(
    '2e1560c3-ca8b-40a0-b578-c9e71ecf27cd',
    '82000000-0000-4000-8000-000000000030',
    decode(repeat('82', 40), 'hex'),
    decode(repeat('91', 32), 'hex'),
    'm10.release.owner',
    'checkpoint://dataset-market/m10/technical-acceptance',
    'accept_exact_m9_evidence_as_disabled_candidate'
  )),
  'semantic replay with the same AAD-bound fingerprint must be idempotent'
);

DO $$
BEGIN
  PERFORM * FROM app.register_marketplace_export_candidate_v1(
    '2e1560c3-ca8b-40a0-b578-c9e71ecf27cd',
    '82000000-0000-4000-8000-000000000030',
    decode(repeat('82', 40), 'hex'), decode(repeat('92', 32), 'hex'),
    'm10.release.owner',
    'checkpoint://dataset-market/m10/technical-acceptance',
    'accept_exact_m9_evidence_as_disabled_candidate'
  );
  RAISE EXCEPTION 'a changed protected fingerprint unexpectedly replayed';
EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM <> 'MARKETPLACE_EXPORT_CANDIDATE_REPLAY_CONFLICT' THEN RAISE; END IF;
END;
$$;

RESET ROLE;
DO $$
BEGIN
  UPDATE app.marketplace_export_candidates SET state = 'disabled_candidate'
  WHERE provider_mapping_id = '82000000-0000-4000-8000-000000000030';
  RAISE EXCEPTION 'immutable M10 evidence unexpectedly accepted an update';
EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM <> 'marketplace_export_candidates versions are immutable' THEN RAISE; END IF;
END;
$$;

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
    FROM app.audit_events
    WHERE action = 'provider.marketplace_export_candidate.register'
      AND target_type = 'provider_mapping'
      AND target_id = '82000000-0000-4000-8000-000000000030'
      AND outcome = 'registered'
      AND safe_diff @> '{
        "mapping_state":"disabled",
        "customer_execution_enabled":false,
        "provider_http_called":false,
        "provider_submission_count":1,
        "automatic_submission_retries":0,
        "record_count":5,
        "observed_cost_micros":0,
        "currency_code":"USD"
      }'::jsonb
  ),
  'the disabled acceptance must have one safe immutable audit record'
);

-- M3 real-sample closure: promote only the exact M9 evidence already assembled
-- above. This remains rollback-only and creates no provider/network request.
SET LOCAL ROLE dhumi_operator;
WITH reviewed_fields(name, type, required, masked, ordinal) AS (
  VALUES
    ('url','url',true,false,1), ('id','text',true,false,2),
    ('user_id','text',false,true,3), ('use_url','url',false,false,4),
    ('title','text',false,true,5), ('headline','text',false,true,6),
    ('post_text','text',false,false,7), ('date_posted','date',false,false,8),
    ('hashtags','array',false,false,9), ('embedded_links','array',false,false,10),
    ('images','array',false,false,11), ('videos','array',false,false,12),
    ('num_likes','number',false,false,13), ('num_comments','number',false,false,14),
    ('more_articles_by_user','array',false,false,15),
    ('more_relevant_posts','array',false,false,16),
    ('top_visible_comments','array',false,true,17),
    ('user_followers','number',false,false,18),
    ('user_posts','number',false,false,19), ('user_articles','number',false,false,20),
    ('post_type','text',false,false,21), ('account_type','text',false,false,22),
    ('post_text_html','text',false,false,23), ('repost','object',false,true,24),
    ('tagged_companies','array',false,false,25),
    ('tagged_people','array',false,true,26), ('user_title','text',false,true,27),
    ('author_profile_pic','url',false,true,28),
    ('num_connections','number',false,false,29),
    ('video_duration','number',false,false,30),
    ('external_link_data','array',false,true,31),
    ('video_thumbnail','url',false,false,32),
    ('document_cover_image','url',false,false,33),
    ('document_page_count','number',false,false,34),
    ('user_profile_pic','url',false,true,35), ('user_name','text',false,true,36),
    ('original_post_text','text',false,false,37)
), dictionary AS (
  SELECT jsonb_agg(
    jsonb_build_object(
      'name', name,
      'type', type,
      'active', true,
      'required', required,
      'description', 'Verified provider field ' || name,
      'sample_visibility', CASE WHEN masked THEN 'masked' ELSE 'visible' END,
      'allowed_operators', CASE
        WHEN masked THEN '[]'::jsonb
        WHEN type IN ('array','object') THEN '["is_null","is_not_null"]'::jsonb
        WHEN type = 'number' THEN
          '["=","!=","in","not_in","is_null","is_not_null"]'::jsonb
        ELSE
          '["=","!=","in","not_in","includes","not_includes","is_null","is_not_null"]'::jsonb
      END,
      'post_purchase_visibility', 'visible'
    ) ORDER BY ordinal
  ) AS fields
  FROM reviewed_fields
), source AS (
  SELECT * FROM app.resolve_marketplace_provider_sample_source(
    '2e1560c3-ca8b-40a0-b578-c9e71ecf27cd'
  )
)
SELECT promoted.*
FROM source
CROSS JOIN dictionary
CROSS JOIN LATERAL app.record_marketplace_provider_sample_v2(
  '82000000-0000-4000-8000-000000000040',
  source.packet_id,
  source.template_version_id,
  3,
  'marketplace/samples/' || source.template_version_id::text || '/3/' ||
    'd5a9c6c3403959349925d0574195e12e511ab2e861d421938e53b4a6738f6c95.json',
  5,
  25858,
  decode('d5a9c6c3403959349925d0574195e12e511ab2e861d421938e53b4a6738f6c95', 'hex'),
  decode('039685f485ab09f0a6f9503517a2aa34957920c0f2faf827684c0b600512499b', 'hex'),
  dictionary.fields,
  'decision://product-owner/2026-09-13/linkedin-posts-real-sample-local-demo-formal-agreement-pending',
  'm3.provider.sample.database.proof'
) AS promoted;

RESET ROLE;

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
      AND bool_and(sample.source_kind = 'provider_qualification')
      AND bool_and(sample.state = 'validated_provider_sample')
      AND bool_and(sample.governance_state = 'formal_agreement_pending_local_demo')
      AND bool_and(sample.rights_evidence_reference IS NULL)
      AND bool_and(sample.qualification_packet_id =
        '2e1560c3-ca8b-40a0-b578-c9e71ecf27cd'::uuid)
      AND bool_and(jsonb_array_length(sample.field_dictionary) = 37)
      AND bool_and(sample.expires_at = sample.collected_at + interval '720 hours')
    FROM app.marketplace_sample_versions AS sample
    WHERE sample.id = '82000000-0000-4000-8000-000000000040'
  ),
  'the exact provider sample must be immutable, versioned and 30-day bounded'
);

SELECT pg_temp.assert_true(
  (
    SELECT preview.sample_version = 3
      AND preview.sample_record_count = 5
      AND jsonb_array_length(preview.fields) = 37
      AND (
        SELECT count(*) = 11
          AND bool_and(field->'allowed_operators' = '[]'::jsonb)
          AND bool_and(NOT (field ? 'post_purchase_visibility'))
        FROM jsonb_array_elements(preview.fields) AS field
        WHERE field->>'sample_visibility' = 'masked'
      )
    FROM app.resolve_marketplace_sample_preview(
      'linkedin-posts', statement_timestamp()
    ) AS preview
  ),
  'pre-purchase preview must select real v3 and suppress masked-field inference'
);

SELECT pg_temp.assert_true(
  NOT has_function_privilege(
    'dhumi_customer_api',
    'app.record_marketplace_provider_sample_v2(uuid,uuid,uuid,integer,text,integer,bigint,bytea,bytea,jsonb,text,text)',
    'EXECUTE'
  )
  AND (
    SELECT mapping.state = 'disabled'
      AND adapter.state = 'disabled'
      AND adapter.capability_metadata->>'customer_execution_enabled' = 'false'
    FROM app.marketplace_export_candidates AS candidate
    JOIN app.provider_mappings AS mapping
      ON mapping.id = candidate.provider_mapping_id
    JOIN app.adapter_versions AS adapter
      ON adapter.id = candidate.adapter_version_id
    WHERE candidate.marketplace_qualification_packet_id =
      '2e1560c3-ca8b-40a0-b578-c9e71ecf27cd'
  ),
  'sample promotion must not grant customers paid execution or enable M10'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
      AND bool_and(safe_diff @> '{
        "record_count":5,
        "field_count":37,
        "masked_field_count":11,
        "pre_purchase_masking":true,
        "masked_field_filtering":false,
        "post_purchase_unmask_requires_entitlement":true,
        "formal_agreement_reference_present":false,
        "provider_calls":0
      }'::jsonb)
    FROM app.audit_events
    WHERE action = 'marketplace.provider_sample.promote'
      AND target_id = '82000000-0000-4000-8000-000000000040'
  ),
  'provider sample promotion must leave one safe governance audit'
);

ROLLBACK;
