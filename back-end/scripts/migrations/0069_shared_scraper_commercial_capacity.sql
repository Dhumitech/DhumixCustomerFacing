-- No shared Scraper Run may create outbox work without an approved immutable
-- per-mapping commercial policy and a provider-enforced per-input record cap.
-- This function is common to every retailer using the shared protocol.
SET ROLE dhumi_owner;

CREATE FUNCTION app.require_shared_scraper_run_capacity(
  p_environment text, p_template_version_id uuid, p_mapping_id uuid, p_input_count integer
)
RETURNS TABLE (
  estimated_amount_micros bigint, currency_code text, unit text, evidence_reference text
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  tenant_uuid uuid := app.require_tenant_context();
  policy jsonb;
  request_rules jsonb;
  commercial_version text;
  evidence_uuid uuid;
  evidence app.launch_evidence%ROWTYPE;
  max_inputs integer;
  max_records_per_input integer;
  max_daily integer;
  max_concurrent integer;
  provider_limit integer;
  per_record_upper numeric;
  fixed_upper numeric;
  maximum_hold numeric;
  calculated_hold numeric;
  recent_runs bigint;
  active_runs bigint;
BEGIN
  IF p_environment NOT IN ('local','test') OR p_template_version_id IS NULL
     OR p_mapping_id IS NULL OR p_input_count IS NULL OR p_input_count < 1
     OR p_input_count > 20 THEN
    RAISE EXCEPTION 'SHARED_SCRAPER_CAPACITY_UNAVAILABLE' USING ERRCODE = 'P5104';
  END IF;

  SELECT mapping.output_policy->'scraper_spending',
    mapping.output_policy->'scraper_processing'->'request', mapping.commercial_config_version
  INTO policy, request_rules, commercial_version
  FROM app.provider_mappings AS mapping
  JOIN app.service_template_versions AS version ON version.id = mapping.service_template_version_id
  JOIN app.service_templates AS template ON template.id = version.service_template_id
  JOIN app.adapter_versions AS adapter ON adapter.id = mapping.adapter_version_id
    AND adapter.id = version.adapter_version_id
  JOIN app.adapter_definitions AS definition ON definition.id = adapter.adapter_definition_id
  WHERE mapping.id = p_mapping_id AND version.id = p_template_version_id
    AND mapping.environment = p_environment AND mapping.state = 'enabled'
    AND template.state = 'published' AND template.product_family = 'scraper_library'
    AND version.availability_state = 'available'
    AND definition.code = 'bright_data.scraper_library.shared'
    AND adapter.semantic_version = '1.1.0-shared-scraper-release'
    AND adapter.state = 'enabled'
    AND adapter.code_artifact_digest = decode('94cc1cb6132f65b60101964647087d967dbd57dae7c3a51610b184151928846a','hex');
  IF NOT FOUND OR jsonb_typeof(policy) <> 'object'
     OR jsonb_typeof(request_rules) <> 'object'
     OR policy - ARRAY['version','evidenceId','maxInputsPerRun','maxRecordsPerInput',
       'maxRunsPerDay','maxConcurrentRuns','upperBoundMicrosPerRecord',
       'fixedUpperBoundMicros','maximumHoldMicros','currencyCode'] <> '{}'::jsonb
     OR NOT (policy ?& ARRAY['version','evidenceId','maxInputsPerRun','maxRecordsPerInput',
       'maxRunsPerDay','maxConcurrentRuns','upperBoundMicrosPerRecord',
       'fixedUpperBoundMicros','maximumHoldMicros','currencyCode'])
     OR jsonb_typeof(policy->'version') IS DISTINCT FROM 'string'
     OR jsonb_typeof(policy->'evidenceId') IS DISTINCT FROM 'string'
     OR jsonb_typeof(policy->'currencyCode') IS DISTINCT FROM 'string'
     OR jsonb_typeof(policy->'maxInputsPerRun') IS DISTINCT FROM 'number'
     OR jsonb_typeof(policy->'maxRecordsPerInput') IS DISTINCT FROM 'number'
     OR jsonb_typeof(policy->'maxRunsPerDay') IS DISTINCT FROM 'number'
     OR jsonb_typeof(policy->'maxConcurrentRuns') IS DISTINCT FROM 'number'
     OR jsonb_typeof(policy->'upperBoundMicrosPerRecord') IS DISTINCT FROM 'number'
     OR jsonb_typeof(policy->'fixedUpperBoundMicros') IS DISTINCT FROM 'number'
     OR jsonb_typeof(policy->'maximumHoldMicros') IS DISTINCT FROM 'number'
     OR jsonb_typeof(request_rules->'limitPerInput') IS DISTINCT FROM 'number'
     OR policy->>'version' IS DISTINCT FROM commercial_version
     OR policy->>'evidenceId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR policy->>'maxInputsPerRun' !~ '^[1-9][0-9]{0,2}$'
     OR policy->>'maxRecordsPerInput' !~ '^[1-9][0-9]{0,5}$'
     OR policy->>'maxRunsPerDay' !~ '^[1-9][0-9]{0,4}$'
     OR policy->>'maxConcurrentRuns' !~ '^[1-9][0-9]{0,3}$'
     OR policy->>'upperBoundMicrosPerRecord' !~ '^[1-9][0-9]{0,12}$'
     OR policy->>'fixedUpperBoundMicros' !~ '^(0|[1-9][0-9]{0,12})$'
     OR policy->>'maximumHoldMicros' !~ '^[1-9][0-9]{0,13}$'
     OR policy->>'currencyCode' !~ '^[A-Z]{3}$'
     OR request_rules->>'limitPerInput' !~ '^[1-9][0-9]{0,5}$' THEN
    RAISE EXCEPTION 'SHARED_SCRAPER_COMMERCIAL_POLICY_UNAVAILABLE' USING ERRCODE = 'P5104';
  END IF;

  max_inputs := (policy->>'maxInputsPerRun')::integer;
  max_records_per_input := (policy->>'maxRecordsPerInput')::integer;
  max_daily := (policy->>'maxRunsPerDay')::integer;
  max_concurrent := (policy->>'maxConcurrentRuns')::integer;
  provider_limit := (request_rules->>'limitPerInput')::integer;
  per_record_upper := (policy->>'upperBoundMicrosPerRecord')::numeric;
  fixed_upper := (policy->>'fixedUpperBoundMicros')::numeric;
  maximum_hold := (policy->>'maximumHoldMicros')::numeric;
  IF max_inputs > 20 OR max_records_per_input > 1000 OR max_daily > 1000
     OR max_concurrent > 100 OR provider_limit > max_records_per_input
     OR p_input_count > max_inputs THEN
    RAISE EXCEPTION 'SHARED_SCRAPER_RUN_LIMIT_EXCEEDED' USING ERRCODE = 'P5101';
  END IF;
  calculated_hold := fixed_upper + p_input_count::numeric * provider_limit * per_record_upper;
  IF calculated_hold > maximum_hold OR calculated_hold > 9223372036854775807 THEN
    RAISE EXCEPTION 'SHARED_SCRAPER_COST_LIMIT_EXCEEDED' USING ERRCODE = 'P5101';
  END IF;

  evidence_uuid := (policy->>'evidenceId')::uuid;
  SELECT item.* INTO evidence FROM app.launch_evidence AS item
  WHERE item.id = evidence_uuid AND item.scope_type = 'scraper_commercial'
    AND item.scope_key = p_mapping_id::text AND item.state = 'approved'
    AND item.approved_by IS NOT NULL AND item.approved_at IS NOT NULL
    AND item.effective_at IS NOT NULL AND item.effective_at <= clock_timestamp()
    AND (item.expires_at IS NULL OR item.expires_at > clock_timestamp())
    AND item.evidence_hash = sha256(convert_to((policy - 'evidenceId')::text, 'UTF8'));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SHARED_SCRAPER_COMMERCIAL_EVIDENCE_UNAVAILABLE' USING ERRCODE = 'P5104';
  END IF;

  -- The existing global queue/Tenant check takes its advisory lock first.
  -- This second lock serializes one Tenant's admission for one mapping.
  PERFORM 1 FROM app.require_phase5_mock_run_capacity(p_environment);
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'shared-scraper-capacity:' || tenant_uuid::text || ':' || p_mapping_id::text, 0));
  SELECT count(*) INTO recent_runs FROM app.runs AS run
  WHERE run.tenant_id = tenant_uuid AND run.provider_mapping_id = p_mapping_id
    AND run.accepted_at >= clock_timestamp() - interval '24 hours';
  SELECT count(*) INTO active_runs FROM app.runs AS run
  WHERE run.tenant_id = tenant_uuid AND run.provider_mapping_id = p_mapping_id
    AND run.public_status IN ('queued','running');
  IF recent_runs >= max_daily OR active_runs >= max_concurrent THEN
    RAISE EXCEPTION 'SHARED_SCRAPER_TENANT_LIMIT_EXCEEDED' USING ERRCODE = 'P5101';
  END IF;

  RETURN QUERY SELECT calculated_hold::bigint, (policy->>'currencyCode')::text,
    'provider_records_upper_bound'::text, evidence.restricted_reference;
END;
$$;

REVOKE ALL ON FUNCTION app.require_shared_scraper_run_capacity(text,uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.require_shared_scraper_run_capacity(text,uuid,uuid,integer) TO dhumi_admission;
RESET ROLE;
