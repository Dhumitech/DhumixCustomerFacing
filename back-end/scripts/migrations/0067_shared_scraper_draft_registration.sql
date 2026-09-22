-- Generic, private draft registration for a reviewed shared-protocol scraper.
-- No provider mapping, credential activation, public pointer or Run is created.
SET ROLE dhumi_owner;

CREATE POLICY service_templates_shared_scraper_draft_insert ON app.service_templates
  FOR INSERT TO dhumi_owner WITH CHECK (
    product_family = 'scraper_library' AND state = 'draft' AND current_public_version_id IS NULL
  );

CREATE POLICY service_template_versions_shared_scraper_draft_insert ON app.service_template_versions
  FOR INSERT TO dhumi_owner WITH CHECK (
    version = 1 AND availability_state = 'coming_soon'
    AND effective_at IS NULL AND published_at IS NULL
    AND EXISTS (
      SELECT 1 FROM app.adapter_versions AS adapter
      JOIN app.adapter_definitions AS definition ON definition.id = adapter.adapter_definition_id
      WHERE adapter.id = adapter_version_id
        AND definition.code = 'bright_data.scraper_library.shared'
        AND definition.product_family = 'scraper_library'
        AND adapter.semantic_version = '1.0.0-shared-scraper-processing'
        AND adapter.code_artifact_digest = decode('007f1a56c59ec83ff8d6c4e359cc7b6121edf4a6c9d93ad7565d86b178bbca7f','hex')
    )
    AND EXISTS (
      SELECT 1 FROM app.launch_evidence AS evidence
      WHERE evidence.id = launch_evidence_id AND evidence.state = 'pending'
        AND evidence.scope_type = 'service_template_version'
        AND left(evidence.evidence_code, length('shared_scraper.template.')) = 'shared_scraper.template.'
    )
  );

CREATE POLICY audit_events_shared_scraper_draft_insert ON app.audit_events
  FOR INSERT TO dhumi_owner WITH CHECK (
    tenant_id IS NULL AND actor_user_id IS NULL AND actor_api_key_id IS NULL
    AND request_id IS NULL AND ip_fingerprint IS NULL
    AND action = 'scraper.operation.stage'
    AND target_type = 'service_template_version' AND target_id IS NOT NULL
  );

CREATE FUNCTION app.stage_shared_scraper_operation_v1(
  p_manifest jsonb, p_restricted_reference text, p_actor text, p_expected_database text
)
RETURNS TABLE (template_id uuid, template_version_id uuid, disposition text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  operation_code text := p_manifest->>'operationCode';
  slug_value text := p_manifest->>'slug';
  draft_evidence_code text;
  evidence_id uuid;
  adapter_id uuid;
  existing_template app.service_templates%ROWTYPE;
  existing_version app.service_template_versions%ROWTYPE;
  existing_evidence app.launch_evidence%ROWTYPE;
  created_template_id uuid;
  created_version_id uuid;
BEGIN
  IF current_database() IS DISTINCT FROM p_expected_database
     OR p_expected_database !~ '^dhumi_[a-z0-9_]{1,58}$'
     OR jsonb_typeof(p_manifest) <> 'object'
     OR p_manifest - ARRAY['operationCode','contractHash','packageSha256','slug',
       'publicName','publicDescription','availabilityCopy','configurationSchema',
       'presentationMetadata','inputSchema','outputSchema','processing'] <> '{}'::jsonb
     OR NOT (p_manifest ?& ARRAY['operationCode','contractHash','packageSha256','slug',
       'publicName','publicDescription','availabilityCopy','configurationSchema',
       'presentationMetadata','inputSchema','outputSchema','processing'])
     OR operation_code !~ '^[a-z][a-z0-9_.-]{2,127}$'
     OR slug_value !~ '^[a-z0-9][a-z0-9-]{1,98}[a-z0-9]$'
     OR p_manifest->>'contractHash' !~ '^[a-f0-9]{64}$'
     OR p_manifest->>'packageSha256' !~ '^[a-f0-9]{64}$'
     OR length(p_manifest->>'publicName') NOT BETWEEN 1 AND 160
     OR length(p_manifest->>'publicDescription') NOT BETWEEN 1 AND 2000
     OR length(p_manifest->>'availabilityCopy') NOT BETWEEN 1 AND 240
     OR jsonb_typeof(p_manifest->'inputSchema') <> 'object'
     OR jsonb_typeof(p_manifest->'outputSchema') <> 'object'
     OR jsonb_typeof(p_manifest->'configurationSchema') <> 'object'
     OR jsonb_typeof(p_manifest->'presentationMetadata') <> 'object'
     OR jsonb_typeof(p_manifest->'processing') <> 'object'
     OR length(p_restricted_reference) NOT BETWEEN 8 AND 1024
     OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$' THEN
    RAISE EXCEPTION 'SCRAPER_DRAFT_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('shared-scraper-stage:' || slug_value, 0));
  draft_evidence_code := 'shared_scraper.template.' || operation_code || '.v1';
  SELECT adapter.id INTO adapter_id
  FROM app.adapter_versions AS adapter
  JOIN app.adapter_definitions AS definition ON definition.id = adapter.adapter_definition_id
  WHERE definition.code = 'bright_data.scraper_library.shared'
    AND definition.product_family = 'scraper_library'
    AND adapter.semantic_version = '1.0.0-shared-scraper-processing'
    AND adapter.code_artifact_digest = decode('007f1a56c59ec83ff8d6c4e359cc7b6121edf4a6c9d93ad7565d86b178bbca7f','hex')
    AND adapter.state = 'disabled';
  IF adapter_id IS NULL THEN
    RAISE EXCEPTION 'SCRAPER_DRAFT_ADAPTER_NOT_AVAILABLE' USING ERRCODE = '55000';
  END IF;

  SELECT template.* INTO existing_template
  FROM app.service_templates AS template WHERE template.slug = slug_value;
  IF FOUND THEN
    SELECT version.* INTO existing_version FROM app.service_template_versions AS version
    WHERE version.service_template_id = existing_template.id AND version.version = 1;
    SELECT evidence.* INTO existing_evidence FROM app.launch_evidence AS evidence
    WHERE evidence.id = existing_version.launch_evidence_id;
    IF existing_template.product_family <> 'scraper_library' OR existing_template.state <> 'draft'
       OR existing_template.current_public_version_id IS NOT NULL
       OR existing_version.id IS NULL OR existing_version.adapter_version_id <> adapter_id
       OR existing_version.public_name <> p_manifest->>'publicName'
       OR existing_version.public_description <> p_manifest->>'publicDescription'
       OR existing_version.input_schema <> p_manifest->'inputSchema'
       OR existing_version.output_schema <> p_manifest->'outputSchema'
       OR existing_version.configuration_schema <> p_manifest->'configurationSchema'
       OR existing_version.presentation_metadata <> p_manifest->'presentationMetadata'
       OR existing_version.availability_copy <> p_manifest->>'availabilityCopy'
       OR existing_version.availability_state <> 'coming_soon'
       OR existing_evidence.id IS NULL
       OR existing_evidence.evidence_code IS DISTINCT FROM draft_evidence_code
       OR existing_evidence.scope_type <> 'service_template_version'
       OR existing_evidence.scope_key <> operation_code || ':1'
       OR existing_evidence.state <> 'pending'
       OR existing_evidence.restricted_reference <> p_restricted_reference
       OR existing_evidence.evidence_hash IS DISTINCT FROM decode(p_manifest->>'packageSha256','hex') THEN
      RAISE EXCEPTION 'SCRAPER_DRAFT_CONFLICT' USING ERRCODE = '55000';
    END IF;
    RETURN QUERY SELECT existing_template.id, existing_version.id, 'replayed'::text;
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM app.launch_evidence AS evidence
    WHERE evidence.evidence_code = draft_evidence_code AND evidence.scope_type = 'service_template_version'
      AND evidence.scope_key = operation_code || ':1') THEN
    RAISE EXCEPTION 'SCRAPER_DRAFT_OPERATION_CONFLICT' USING ERRCODE = '55000';
  END IF;
  INSERT INTO app.launch_evidence (
    evidence_code, scope_type, scope_key, state, restricted_reference, evidence_hash
  ) VALUES (
    draft_evidence_code, 'service_template_version', operation_code || ':1', 'pending',
    p_restricted_reference, decode(p_manifest->>'packageSha256','hex')
  ) RETURNING id INTO evidence_id;
  INSERT INTO app.service_templates (slug, product_family, state)
  VALUES (slug_value, 'scraper_library', 'draft') RETURNING id INTO created_template_id;
  INSERT INTO app.service_template_versions (
    service_template_id, version, public_name, public_description,
    input_schema, output_schema, configuration_schema, presentation_metadata,
    availability_copy, availability_state, adapter_version_id, launch_evidence_id
  ) VALUES (
    created_template_id, 1, p_manifest->>'publicName', p_manifest->>'publicDescription',
    p_manifest->'inputSchema', p_manifest->'outputSchema', p_manifest->'configurationSchema',
    p_manifest->'presentationMetadata', p_manifest->>'availabilityCopy', 'coming_soon',
    adapter_id, evidence_id
  ) RETURNING id INTO created_version_id;
  INSERT INTO app.audit_events (action, target_type, target_id, outcome, safe_diff)
  VALUES ('scraper.operation.stage', 'service_template_version', created_version_id,
    'accepted', jsonb_build_object('actor', p_actor, 'operation_code', operation_code,
      'contract_hash', p_manifest->>'contractHash'));
  RETURN QUERY SELECT created_template_id, created_version_id, 'created'::text;
END;
$$;

REVOKE ALL ON FUNCTION app.stage_shared_scraper_operation_v1(jsonb,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.stage_shared_scraper_operation_v1(jsonb,text,text,text) TO dhumi_operator;
RESET ROLE;
