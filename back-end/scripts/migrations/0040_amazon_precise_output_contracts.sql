-- Pattern 8 Priority 4: stage evidence-backed, operation-specific output
-- contracts without publishing a Template, enabling a provider mapping,
-- calling Bright Data or creating a database identity.

SET ROLE dhumi_owner;

CREATE TEMP TABLE pattern8_amazon_output_contracts (
  operation_code text PRIMARY KEY,
  contract_state text NOT NULL CHECK (contract_state IN ('precise', 'unavailable')),
  normalizer_code text,
  normalizer_version integer,
  normalized_schema_version text,
  output_schema jsonb NOT NULL,
  CHECK (
    (contract_state = 'precise'
      AND normalizer_code IS NOT NULL
      AND normalizer_version = 2
      AND normalized_schema_version IS NOT NULL)
    OR
    (contract_state = 'unavailable'
      AND normalizer_code IS NULL
      AND normalizer_version IS NULL
      AND normalized_schema_version IS NULL)
  )
) ON COMMIT DROP;

INSERT INTO pattern8_amazon_output_contracts (
  operation_code,
  contract_state,
  normalizer_code,
  normalizer_version,
  normalized_schema_version,
  output_schema
) VALUES
  (
    'amazon.products.collect_by_url',
    'precise',
    'amazon.products.collect-by-url.projected-array',
    2,
    'amazon.products.collect-by-url.output.v1',
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"urn:dhumi:schema:amazon.products.collect-by-url.output.v1","type":"array","items":{"type":"object","additionalProperties":false,"required":["asin","title","url","domain","currency","final_price","initial_price","rating","reviews_count","availability","brand","image_url","timestamp"],"properties":{"asin":{"type":"string"},"title":{"type":"string"},"url":{"type":"string","format":"uri"},"domain":{"type":"string"},"currency":{"type":"string"},"final_price":{"type":"number"},"initial_price":{"type":"number"},"rating":{"type":"number"},"reviews_count":{"type":"number"},"availability":{"type":"string"},"brand":{"type":"string"},"image_url":{"type":"string","format":"uri"},"timestamp":{"type":"string"}}}}'::jsonb
  ),
  (
    'amazon.products_global.collect_by_url',
    'precise',
    'amazon.products-global.collect-by-url.projected-array',
    2,
    'amazon.products-global.collect-by-url.output.v1',
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"urn:dhumi:schema:amazon.products-global.collect-by-url.output.v1","type":"array","items":{"type":"object","additionalProperties":false,"required":["asin","title","url","domain","currency","final_price","initial_price","rating","reviews_count","availability","brand","image_url","timestamp"],"properties":{"asin":{"type":"string"},"title":{"type":"string"},"url":{"type":"string","format":"uri"},"domain":{"type":"string"},"currency":{"type":"string"},"final_price":{"type":"number"},"initial_price":{"type":"number"},"rating":{"type":"number"},"reviews_count":{"type":"number"},"availability":{"type":"string"},"brand":{"type":"string"},"image_url":{"type":"string","format":"uri"},"timestamp":{"type":"string"}}}}'::jsonb
  ),
  (
    'amazon.products_search.collect_by_url',
    'precise',
    'amazon.products-search.collect-by-url.projected-array',
    2,
    'amazon.products-search.collect-by-url.output.v1',
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"urn:dhumi:schema:amazon.products-search.collect-by-url.output.v1","type":"array","items":{"type":"object","additionalProperties":false,"required":["asin","name","url","domain","currency","final_price","initial_price","rating","num_ratings","brand","image","page_number","rank_on_page","bought_past_month","sold","sponsored","sponsored_video","total_results","timestamp"],"properties":{"asin":{"type":["string","null"]},"name":{"type":"string"},"url":{"type":"string","format":"uri"},"domain":{"type":"string"},"currency":{"type":"string"},"final_price":{"type":"number"},"initial_price":{"type":"number"},"rating":{"type":"number"},"num_ratings":{"type":"number"},"brand":{"type":["string","null"]},"image":{"type":"string","format":"uri"},"page_number":{"type":"number"},"rank_on_page":{"type":"number"},"bought_past_month":{"type":"number"},"sold":{"type":"number"},"sponsored":{"type":"string"},"sponsored_video":{"type":["string","null"]},"total_results":{"type":"number"},"timestamp":{"type":"string"}}}}'::jsonb
  ),
  (
    'amazon.products.discover_by_upc',
    'precise',
    'amazon.products.discover-by-upc.empty-array',
    2,
    'amazon.products.discover-by-upc.output.empty-v1',
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"urn:dhumi:schema:amazon.products.discover-by-upc.output.empty-v1","type":"array","maxItems":0}'::jsonb
  ),
  ('amazon.reviews.collect_by_url', 'unavailable', NULL, NULL, NULL,
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"array","items":{"type":"object","additionalProperties":true},"$comment":"Not publishable: precise success-output evidence is unavailable."}'::jsonb),
  ('amazon.sellers.collect_by_url', 'unavailable', NULL, NULL, NULL,
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"array","items":{"type":"object","additionalProperties":true},"$comment":"Not publishable: stored evidence contains a provider-error record, not seller output."}'::jsonb),
  ('amazon.products_global.discover_by_category_url', 'unavailable', NULL, NULL, NULL,
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"array","items":{"type":"object","additionalProperties":true},"$comment":"Not publishable: precise success-output evidence is unavailable."}'::jsonb),
  ('amazon.products.discover_by_category_url', 'unavailable', NULL, NULL, NULL,
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"array","items":{"type":"object","additionalProperties":true},"$comment":"Not publishable: precise success-output evidence is unavailable."}'::jsonb),
  ('amazon.products.discover_by_keyword', 'unavailable', NULL, NULL, NULL,
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"array","items":{"type":"object","additionalProperties":true},"$comment":"Not publishable: precise success-output evidence is unavailable."}'::jsonb),
  ('amazon.products.discover_by_best_sellers_url', 'unavailable', NULL, NULL, NULL,
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"array","items":{"type":"object","additionalProperties":true},"$comment":"Not publishable: precise success-output evidence is unavailable."}'::jsonb),
  ('amazon.products_global.discover_by_brand', 'unavailable', NULL, NULL, NULL,
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"array","items":{"type":"object","additionalProperties":true},"$comment":"Not publishable: precise success-output evidence is unavailable."}'::jsonb),
  ('amazon.products_global.discover_by_keyword', 'unavailable', NULL, NULL, NULL,
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"array","items":{"type":"object","additionalProperties":true},"$comment":"Not publishable: precise success-output evidence is unavailable."}'::jsonb),
  ('amazon.products_global.discover_by_seller', 'unavailable', NULL, NULL, NULL,
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"array","items":{"type":"object","additionalProperties":true},"$comment":"Not publishable: precise success-output evidence is unavailable."}'::jsonb);

DO $$
BEGIN
  IF (SELECT count(*) FROM pattern8_amazon_output_contracts) <> 13
     OR (SELECT count(*) FROM pattern8_amazon_output_contracts WHERE contract_state = 'precise') <> 4
     OR (SELECT count(*) FROM pattern8_amazon_output_contracts WHERE contract_state = 'unavailable') <> 9 THEN
    RAISE EXCEPTION 'PATTERN8_OUTPUT_CONTRACT_REGISTRY_INVALID';
  END IF;
END;
$$;

INSERT INTO app.adapter_versions (
  adapter_definition_id,
  semantic_version,
  capability_metadata,
  request_schema,
  result_schema,
  error_schema,
  code_artifact_digest,
  state
)
SELECT
  definition.id,
  '1.1.0-pattern8-output-contracts',
  jsonb_build_object(
    'registry_version', 2,
    'operation_codes', (
      SELECT jsonb_agg(contract.operation_code ORDER BY contract.operation_code)
      FROM pattern8_amazon_output_contracts AS contract
    ),
    'provider_submission_endpoints', jsonb_build_array('scrape', 'trigger'),
    'inline_result', true,
    'snapshot_fallback', true,
    'multipart', 'conditional',
    'cancel', 'conditional',
    'output_contracts', (
      SELECT jsonb_object_agg(
        contract.operation_code,
        jsonb_strip_nulls(jsonb_build_object(
          'state', contract.contract_state,
          'normalizer_code', contract.normalizer_code,
          'normalizer_version', contract.normalizer_version,
          'normalized_schema_version', contract.normalized_schema_version
        ))
      )
      FROM pattern8_amazon_output_contracts AS contract
    )
  ),
  previous.request_schema,
  jsonb_build_object(
    '$schema', 'https://json-schema.org/draft/2020-12/schema',
    'oneOf', (
      SELECT jsonb_agg(contract.output_schema ORDER BY contract.operation_code)
      FROM pattern8_amazon_output_contracts AS contract
      WHERE contract.contract_state = 'precise'
    )
  ),
  previous.error_schema,
  decode('742d4035fcad32f5b78151d2dee0c8fbf2ca2b8bc0a42e1995a70ef6eca9cb14', 'hex'),
  'disabled'
FROM app.adapter_definitions AS definition
JOIN app.adapter_versions AS previous
  ON previous.adapter_definition_id = definition.id
 AND previous.semantic_version = '1.0.0-pattern6'
WHERE definition.code = 'bright_data.amazon.scraper_library';

INSERT INTO app.launch_evidence (
  evidence_code,
  scope_type,
  scope_key,
  state,
  restricted_reference
)
SELECT
  'amazon.template.' || contract.operation_code || '.v2',
  'service_template_version',
  contract.operation_code || ':2',
  'pending',
  'checkpoint://amazon/pattern8/output-contracts/' || contract.operation_code
FROM pattern8_amazon_output_contracts AS contract;

ALTER TABLE app.service_templates DISABLE ROW LEVEL SECURITY;
ALTER TABLE app.service_template_versions DISABLE ROW LEVEL SECURITY;

INSERT INTO app.service_template_versions (
  service_template_id,
  version,
  public_name,
  public_description,
  input_schema,
  configuration_schema,
  output_schema,
  presentation_metadata,
  availability_copy,
  availability_state,
  adapter_version_id,
  launch_evidence_id,
  effective_at,
  published_at
)
SELECT
  previous.service_template_id,
  2,
  previous.public_name,
  CASE contract.contract_state
    WHEN 'precise' THEN previous.public_name || ' through Dhumi. Qualification is pending.'
    ELSE previous.public_name || ' through Dhumi. Precise output qualification is unavailable.'
  END,
  previous.input_schema,
  previous.configuration_schema,
  contract.output_schema,
  previous.presentation_metadata,
  CASE contract.contract_state
    WHEN 'precise' THEN 'Qualification pending'
    ELSE 'Precise output contract unavailable'
  END,
  'coming_soon',
  adapter.id,
  evidence.id,
  NULL,
  NULL
FROM pattern8_amazon_output_contracts AS contract
JOIN app.launch_evidence AS old_evidence
  ON old_evidence.scope_type = 'service_template_version'
 AND old_evidence.scope_key = contract.operation_code || ':1'
JOIN app.service_template_versions AS previous
  ON previous.launch_evidence_id = old_evidence.id
 AND previous.version = 1
JOIN app.launch_evidence AS evidence
  ON evidence.scope_type = 'service_template_version'
 AND evidence.scope_key = contract.operation_code || ':2'
CROSS JOIN LATERAL (
  SELECT version.id
  FROM app.adapter_versions AS version
  JOIN app.adapter_definitions AS definition
    ON definition.id = version.adapter_definition_id
  WHERE definition.code = 'bright_data.amazon.scraper_library'
    AND version.semantic_version = '1.1.0-pattern8-output-contracts'
) AS adapter;

SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE app.service_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.service_template_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.service_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.service_templates FORCE ROW LEVEL SECURITY;

DROP POLICY service_template_versions_amazon_qualification_definer_select
  ON app.service_template_versions;
CREATE POLICY service_template_versions_amazon_qualification_definer_select
  ON app.service_template_versions
  FOR SELECT
  TO dhumi_owner
  USING (
    version = 2
    AND effective_at IS NULL
    AND published_at IS NULL
    AND availability_state = 'coming_soon'
    AND EXISTS (
      SELECT 1
      FROM app.launch_evidence AS evidence
      WHERE evidence.id = launch_evidence_id
        AND evidence.scope_type = 'service_template_version'
        AND evidence.scope_key ~ '^amazon\.[a-z0-9_.]{3,120}:2$'
        AND evidence.state = 'pending'
    )
    AND EXISTS (
      SELECT 1
      FROM app.adapter_versions AS adapter
      JOIN app.adapter_definitions AS definition
        ON definition.id = adapter.adapter_definition_id
      WHERE adapter.id = adapter_version_id
        AND definition.code = 'bright_data.amazon.scraper_library'
        AND adapter.semantic_version = '1.1.0-pattern8-output-contracts'
        AND adapter.state = 'disabled'
    )
  );

CREATE FUNCTION app.begin_amazon_scraper_catalog_import_v2(
  p_import_id uuid,
  p_environment text,
  p_actor text,
  p_restricted_reference text
)
RETURNS TABLE (
  import_id uuid,
  adapter_version_id uuid,
  provider_credential_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  resolved_adapter_version_id uuid;
  resolved_evidence_id uuid;
  resolved_credential_id uuid;
BEGIN
  IF p_import_id IS NULL
     OR p_environment NOT IN ('local', 'test')
     OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$'
     OR length(p_restricted_reference) NOT BETWEEN 8 AND 1024 THEN
    RAISE EXCEPTION 'QUALIFICATION_IMPORT_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT version.id INTO resolved_adapter_version_id
  FROM app.adapter_versions AS version
  JOIN app.adapter_definitions AS definition
    ON definition.id = version.adapter_definition_id
  WHERE definition.code = 'bright_data.amazon.scraper_library'
    AND version.semantic_version = '1.1.0-pattern8-output-contracts';

  IF resolved_adapter_version_id IS NULL THEN
    RAISE EXCEPTION 'QUALIFICATION_ADAPTER_NOT_AVAILABLE' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO app.launch_evidence (
    evidence_code, scope_type, scope_key, state, restricted_reference
  ) VALUES (
    'bright_data.credential.' || p_environment || '.qualification',
    'provider_credential',
    'bright_data:' || p_environment || ':BRIGHTDATA_API_KEY',
    'pending',
    p_restricted_reference
  ) ON CONFLICT (evidence_code, scope_type, scope_key) DO NOTHING;

  SELECT evidence.id INTO resolved_evidence_id
  FROM app.launch_evidence AS evidence
  WHERE evidence.evidence_code = 'bright_data.credential.' || p_environment || '.qualification'
    AND evidence.scope_type = 'provider_credential'
    AND evidence.scope_key = 'bright_data:' || p_environment || ':BRIGHTDATA_API_KEY'
    AND evidence.state IN ('pending', 'approved');

  IF resolved_evidence_id IS NULL THEN
    RAISE EXCEPTION 'QUALIFICATION_CREDENTIAL_EVIDENCE_NOT_AVAILABLE' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO app.provider_credentials (
    provider_code, environment, vault_secret_reference, owner_metadata,
    permission_label, state, launch_evidence_id
  ) VALUES (
    'bright_data', p_environment, 'BRIGHTDATA_API_KEY',
    jsonb_build_object('use', 'pattern7_qualification'),
    'scraper_qualification', 'inactive', resolved_evidence_id
  ) ON CONFLICT (provider_code, environment, vault_secret_reference) DO NOTHING;

  SELECT credential.id INTO resolved_credential_id
  FROM app.provider_credentials AS credential
  WHERE credential.provider_code = 'bright_data'
    AND credential.environment = p_environment
    AND credential.vault_secret_reference = 'BRIGHTDATA_API_KEY'
    AND credential.state IN ('inactive', 'active');

  IF resolved_credential_id IS NULL THEN
    RAISE EXCEPTION 'QUALIFICATION_CREDENTIAL_NOT_AVAILABLE' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO app.catalog_imports (
    id, adapter_version_id, provider_credential_id, state, started_at,
    environment, candidate_count
  ) VALUES (
    p_import_id, resolved_adapter_version_id, resolved_credential_id,
    'running', clock_timestamp(), p_environment, 0
  );

  INSERT INTO app.audit_events (action, target_type, target_id, outcome, safe_diff)
  VALUES (
    'provider.catalog_import.begin', 'catalog_import', p_import_id, 'accepted',
    jsonb_build_object('actor', p_actor, 'environment', p_environment, 'contract_registry_version', 2)
  );

  RETURN QUERY SELECT p_import_id, resolved_adapter_version_id, resolved_credential_id;
END;
$$;

CREATE FUNCTION app.resolve_amazon_qualification_candidate_v2(
  p_candidate_id uuid,
  p_operation_code text,
  p_environment text
)
RETURNS TABLE (
  candidate_ciphertext bytea,
  candidate_fingerprint bytea,
  service_template_version_id uuid,
  adapter_version_id uuid,
  provider_credential_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT
    candidate.provider_resource_ciphertext,
    candidate.provider_resource_fingerprint,
    version.id,
    catalog_import.adapter_version_id,
    catalog_import.provider_credential_id
  FROM app.catalog_candidates AS candidate
  JOIN app.catalog_imports AS catalog_import
    ON catalog_import.id = candidate.catalog_import_id
  JOIN app.service_template_versions AS version
    ON version.adapter_version_id = catalog_import.adapter_version_id
  JOIN app.launch_evidence AS evidence ON evidence.id = version.launch_evidence_id
  WHERE candidate.id = p_candidate_id
    AND candidate.review_state = 'approved'
    AND catalog_import.state = 'completed'
    AND catalog_import.environment = p_environment
    AND evidence.scope_type = 'service_template_version'
    AND evidence.scope_key = p_operation_code || ':2';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'QUALIFICATION_CANDIDATE_NOT_AVAILABLE' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

CREATE FUNCTION app.begin_amazon_provider_qualification_v3(
  p_qualification_id uuid,
  p_candidate_id uuid,
  p_operation_code text,
  p_environment text,
  p_provider_execution_mode text,
  p_request_object_key text,
  p_request_checksum bytea,
  p_actor text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  candidate_plan record;
BEGIN
  IF p_qualification_id IS NULL
     OR p_provider_execution_mode NOT IN ('scrape', 'trigger')
     OR p_request_object_key !~ '^qualification/operations/[0-9a-f-]{36}/request\.json$'
     OR p_request_checksum IS NULL OR octet_length(p_request_checksum) <> 32
     OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$' THEN
    RAISE EXCEPTION 'QUALIFICATION_BEGIN_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO candidate_plan
  FROM app.resolve_amazon_qualification_candidate_v2(
    p_candidate_id, p_operation_code, p_environment
  );

  INSERT INTO app.provider_qualification_attempts (
    id, operation_code, environment, provider_execution_mode,
    service_template_version_id, adapter_version_id, provider_credential_id,
    catalog_candidate_id, request_object_key, request_checksum, created_by
  ) VALUES (
    p_qualification_id, p_operation_code, p_environment, p_provider_execution_mode,
    candidate_plan.service_template_version_id, candidate_plan.adapter_version_id,
    candidate_plan.provider_credential_id, p_candidate_id, p_request_object_key,
    p_request_checksum, p_actor
  );

  INSERT INTO app.audit_events (action, target_type, target_id, outcome, safe_diff)
  VALUES (
    'provider.qualification.begin', 'provider_qualification', p_qualification_id,
    'accepted', jsonb_build_object(
      'actor', p_actor,
      'operation_code', p_operation_code,
      'provider_execution_mode', p_provider_execution_mode,
      'contract_registry_version', 2
    )
  );
  RETURN true;
END;
$$;

CREATE FUNCTION app.resolve_amazon_qualification_acceptance_plan_v3(
  p_qualification_id uuid
)
RETURNS TABLE (
  candidate_id uuid,
  operation_code text,
  environment text,
  provider_execution_mode text,
  candidate_ciphertext bytea,
  candidate_fingerprint bytea
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT
    attempt.catalog_candidate_id,
    attempt.operation_code,
    attempt.environment,
    attempt.provider_execution_mode,
    candidate.provider_resource_ciphertext,
    candidate.provider_resource_fingerprint
  FROM app.provider_qualification_attempts AS attempt
  JOIN app.catalog_candidates AS candidate
    ON candidate.id = attempt.catalog_candidate_id
  JOIN app.service_template_versions AS version
    ON version.id = attempt.service_template_version_id
   AND version.version = 2
  JOIN app.adapter_versions AS adapter
    ON adapter.id = attempt.adapter_version_id
   AND adapter.id = version.adapter_version_id
  WHERE attempt.id = p_qualification_id
    AND attempt.state = 'succeeded'
    AND attempt.review_state = 'pending'
    AND candidate.review_state = 'approved'
    AND adapter.capability_metadata #>> ARRAY[
      'output_contracts', attempt.operation_code, 'state'
    ] = 'precise';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'QUALIFICATION_ACCEPTANCE_PLAN_NOT_AVAILABLE' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

CREATE FUNCTION app.accept_amazon_provider_qualification_v3(
  p_qualification_id uuid,
  p_mapping_id uuid,
  p_mapping_ciphertext bytea,
  p_mapping_fingerprint bytea,
  p_output_policy jsonb,
  p_commercial_config_version text,
  p_config_version text,
  p_restricted_reference text,
  p_evidence_hash bytea,
  p_reviewer text,
  p_expires_at timestamptz DEFAULT NULL
)
RETURNS TABLE (provider_mapping_id uuid, launch_evidence_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  expected_contract jsonb;
  template_version integer;
  template_schema_id text;
BEGIN
  SELECT
    adapter.capability_metadata #> ARRAY['output_contracts', attempt.operation_code],
    version.version,
    version.output_schema ->> '$id'
  INTO expected_contract, template_version, template_schema_id
  FROM app.provider_qualification_attempts AS attempt
  JOIN app.service_template_versions AS version
    ON version.id = attempt.service_template_version_id
  JOIN app.adapter_versions AS adapter
    ON adapter.id = attempt.adapter_version_id
   AND adapter.id = version.adapter_version_id
  WHERE attempt.id = p_qualification_id
  FOR UPDATE OF attempt;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'QUALIFICATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF (expected_contract ->> 'state') IS DISTINCT FROM 'precise'
     OR template_version IS DISTINCT FROM 2
     OR template_schema_id IS DISTINCT FROM
        'urn:dhumi:schema:' || (expected_contract ->> 'normalized_schema_version') THEN
    RAISE EXCEPTION 'QUALIFICATION_OUTPUT_CONTRACT_UNAVAILABLE' USING ERRCODE = '55000';
  END IF;

  IF (p_output_policy ->> 'normalizer_code') IS DISTINCT FROM
        (expected_contract ->> 'normalizer_code')
     OR (p_output_policy -> 'normalizer_version') IS DISTINCT FROM
        (expected_contract -> 'normalizer_version')
     OR (p_output_policy ->> 'normalized_schema_version') IS DISTINCT FROM
        (expected_contract ->> 'normalized_schema_version') THEN
    RAISE EXCEPTION 'QUALIFICATION_OUTPUT_CONTRACT_MISMATCH' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT * FROM app.accept_amazon_provider_qualification_v2(
    p_qualification_id,
    p_mapping_id,
    p_mapping_ciphertext,
    p_mapping_fingerprint,
    p_output_policy,
    p_commercial_config_version,
    p_config_version,
    p_restricted_reference,
    p_evidence_hash,
    p_reviewer,
    p_expires_at
  );
END;
$$;

-- The v1/v2 entry points remain present for migration history but the runtime
-- operator may only use the contract-versioned path after this migration.
REVOKE EXECUTE ON FUNCTION app.begin_amazon_scraper_catalog_import(uuid, text, text, text)
  FROM dhumi_operator;
REVOKE EXECUTE ON FUNCTION app.resolve_amazon_qualification_candidate(uuid, text, text)
  FROM dhumi_operator;
REVOKE EXECUTE ON FUNCTION app.begin_amazon_provider_qualification_v2(
  uuid, uuid, text, text, text, text, bytea, text
) FROM dhumi_operator;
REVOKE EXECUTE ON FUNCTION app.resolve_amazon_qualification_acceptance_plan_v2(uuid)
  FROM dhumi_operator;
REVOKE EXECUTE ON FUNCTION app.accept_amazon_provider_qualification_v2(
  uuid, uuid, bytea, bytea, jsonb, text, text, text, bytea, text, timestamptz
) FROM dhumi_operator;

REVOKE ALL ON FUNCTION app.begin_amazon_scraper_catalog_import_v2(uuid, text, text, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_amazon_qualification_candidate_v2(uuid, text, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app.begin_amazon_provider_qualification_v3(
  uuid, uuid, text, text, text, text, bytea, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_amazon_qualification_acceptance_plan_v3(uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app.accept_amazon_provider_qualification_v3(
  uuid, uuid, bytea, bytea, jsonb, text, text, text, bytea, text, timestamptz
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.begin_amazon_scraper_catalog_import_v2(uuid, text, text, text)
  TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.resolve_amazon_qualification_candidate_v2(uuid, text, text)
  TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.begin_amazon_provider_qualification_v3(
  uuid, uuid, text, text, text, text, bytea, text
) TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.resolve_amazon_qualification_acceptance_plan_v3(uuid)
  TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.accept_amazon_provider_qualification_v3(
  uuid, uuid, bytea, bytea, jsonb, text, text, text, bytea, text, timestamptz
) TO dhumi_operator;

RESET ROLE;
