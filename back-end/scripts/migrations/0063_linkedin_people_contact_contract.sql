-- Priority 3A: private, append-only LinkedIn People contact-choice evidence.
--
-- This records only what the retained official documents establish. It does
-- not publish a Template, expose a provider dataset identifier, enable contact
-- fulfillment, create a Service/Run/outbox job, or call a provider.

SET ROLE dhumi_owner;

CREATE TABLE app.marketplace_contact_contract_packets (
  id uuid PRIMARY KEY,
  catalog_candidate_id uuid NOT NULL
    REFERENCES app.catalog_candidates(id) ON DELETE RESTRICT,
  service_template_version_id uuid NOT NULL
    REFERENCES app.service_template_versions(id) ON DELETE RESTRICT,
  contract_version integer NOT NULL CHECK (contract_version = 1),
  evidence_object_key text NOT NULL UNIQUE,
  evidence_checksum bytea NOT NULL CHECK (octet_length(evidence_checksum) = 32),
  evidence_byte_count bigint NOT NULL CHECK (evidence_byte_count > 1),
  faq_evidence_object_key text NOT NULL UNIQUE,
  search_evidence_object_key text NOT NULL UNIQUE,
  provider_resource_ciphertext bytea NOT NULL
    CHECK (octet_length(provider_resource_ciphertext) >= 32),
  provider_resource_fingerprint bytea NOT NULL
    CHECK (octet_length(provider_resource_fingerprint) = 32),
  faq_source_uri text NOT NULL CHECK (
    faq_source_uri = 'https://docs.brightdata.com/products/marketplace/faqs'
  ),
  faq_checksum bytea NOT NULL CHECK (octet_length(faq_checksum) = 32),
  search_source_uri text NOT NULL CHECK (
    search_source_uri =
      'https://docs.brightdata.com/api-reference/marketplace-dataset-api/search-dataset'
  ),
  search_checksum bytea NOT NULL CHECK (octet_length(search_checksum) = 32),
  source_observed_on date NOT NULL,
  restricted_reference text NOT NULL
    CHECK (length(restricted_reference) BETWEEN 8 AND 1024),
  governance_state text NOT NULL
    CHECK (governance_state = 'fulfillment_evidence_pending'),
  fulfillment_state text NOT NULL CHECK (fulfillment_state = 'not_enabled'),
  provider_calls integer NOT NULL CHECK (provider_calls = 0),
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (service_template_version_id, contract_version)
);

CREATE TABLE app.marketplace_contact_mode_contracts (
  packet_id uuid NOT NULL
    REFERENCES app.marketplace_contact_contract_packets(id) ON DELETE RESTRICT,
  mode text NOT NULL CHECK (
    mode IN ('standard', 'enriched_when_available', 'contacts_only')
  ),
  display_order integer NOT NULL CHECK (display_order BETWEEN 1 AND 3),
  customer_meaning text NOT NULL CHECK (length(customer_meaning) BETWEEN 8 AND 512),
  preview_state text NOT NULL CHECK (preview_state IN ('available', 'not_enabled')),
  fulfillment_state text NOT NULL CHECK (fulfillment_state = 'not_enabled'),
  PRIMARY KEY (packet_id, mode),
  UNIQUE (packet_id, display_order),
  CHECK (
    (mode = 'standard' AND display_order = 1 AND preview_state = 'available')
    OR
    (mode = 'enriched_when_available' AND display_order = 2
      AND preview_state = 'not_enabled')
    OR
    (mode = 'contacts_only' AND display_order = 3
      AND preview_state = 'not_enabled')
  )
);

CREATE TRIGGER marketplace_contact_contract_packets_immutable
  BEFORE UPDATE OR DELETE ON app.marketplace_contact_contract_packets
  FOR EACH ROW EXECUTE FUNCTION app.reject_version_mutation();

CREATE TRIGGER marketplace_contact_mode_contracts_immutable
  BEFORE UPDATE OR DELETE ON app.marketplace_contact_mode_contracts
  FOR EACH ROW EXECUTE FUNCTION app.reject_version_mutation();

ALTER TABLE app.marketplace_contact_contract_packets ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.marketplace_contact_contract_packets FORCE ROW LEVEL SECURITY;
ALTER TABLE app.marketplace_contact_mode_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.marketplace_contact_mode_contracts FORCE ROW LEVEL SECURITY;

REVOKE ALL ON app.marketplace_contact_contract_packets FROM PUBLIC;
REVOKE ALL ON app.marketplace_contact_mode_contracts FROM PUBLIC;
GRANT SELECT ON app.marketplace_contact_contract_packets TO dhumi_operator;
GRANT SELECT ON app.marketplace_contact_mode_contracts TO dhumi_operator;

CREATE POLICY marketplace_contact_contract_packets_operator_select
  ON app.marketplace_contact_contract_packets
  FOR SELECT TO dhumi_operator USING (true);

CREATE POLICY marketplace_contact_contract_packets_owner_all
  ON app.marketplace_contact_contract_packets
  FOR ALL TO dhumi_owner USING (true) WITH CHECK (true);

CREATE POLICY marketplace_contact_mode_contracts_operator_select
  ON app.marketplace_contact_mode_contracts
  FOR SELECT TO dhumi_operator USING (true);

CREATE POLICY marketplace_contact_mode_contracts_owner_all
  ON app.marketplace_contact_mode_contracts
  FOR ALL TO dhumi_owner USING (true) WITH CHECK (true);

CREATE POLICY audit_events_marketplace_contact_contract_insert
  ON app.audit_events
  FOR INSERT TO dhumi_owner
  WITH CHECK (
    tenant_id IS NULL
    AND actor_user_id IS NULL
    AND actor_api_key_id IS NULL
    AND request_id IS NULL
    AND ip_fingerprint IS NULL
    AND action = 'provider.contact_contract.register'
    AND target_type = 'marketplace_contact_contract_packet'
    AND target_id IS NOT NULL
    AND outcome = 'completed'
  );

CREATE FUNCTION app.resolve_linkedin_people_contact_contract_candidate(
  p_candidate_id uuid
)
RETURNS TABLE (
  candidate_id uuid,
  environment text,
  template_version_id uuid,
  template_version integer,
  metadata_checksum bytea,
  sample_version integer
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT
    candidate.id,
    import.environment,
    version.id,
    version.version,
    observation.metadata_checksum,
    sample.sample_version
  FROM app.catalog_candidates AS candidate
  JOIN app.catalog_imports AS import ON import.id = candidate.catalog_import_id
  JOIN app.service_template_versions AS version
    ON version.id = candidate.service_template_version_id
  JOIN app.service_templates AS template ON template.id = version.service_template_id
  JOIN app.marketplace_catalog_metadata_observations AS observation
    ON observation.catalog_candidate_id = candidate.id
  JOIN app.marketplace_sample_versions AS sample
    ON sample.service_template_version_id = version.id
   AND sample.source_metadata_checksum = observation.metadata_checksum
  JOIN app.adapter_versions AS adapter ON adapter.id = version.adapter_version_id
  JOIN app.adapter_definitions AS definition
    ON definition.id = adapter.adapter_definition_id
  WHERE candidate.id = p_candidate_id
    AND candidate.resource_code = 'linkedin.people.standard'
    AND candidate.review_state = 'approved'
    AND import.state = 'completed'
    AND import.environment IN ('local', 'test')
    AND template.slug = 'linkedin-people'
    AND template.product_family = 'marketplace_dataset'
    AND template.state = 'draft'
    AND template.current_public_version_id IS NULL
    AND version.version = 1
    AND version.availability_state = 'coming_soon'
    AND version.effective_at IS NULL
    AND version.published_at IS NULL
    AND observation.content_type = 'application/json'
    AND observation.field_count = 46
    AND sample.sample_version = 1
    AND sample.source_kind = 'synthetic_fixture'
    AND sample.state = 'validated_fixture'
    AND sample.governance_state = 'synthetic_fixture'
    AND sample.record_count = 5
    AND sample.masking_policy_version =
      'linkedin-people-provider-metadata-pii-mask-v1'
    AND sample.retention_policy_version = 'linkedin-people-sample-30d-v1'
    AND sample.expires_at > statement_timestamp()
    AND definition.code = 'bright_data.marketplace.catalogue'
    AND adapter.semantic_version = '1.0.0-m2'
    AND adapter.state = 'disabled'
  ORDER BY observation.observed_at DESC, observation.id DESC
  LIMIT 1;
$$;

CREATE FUNCTION app.record_linkedin_people_contact_contract(
  p_packet_id uuid,
  p_candidate_id uuid,
  p_template_version_id uuid,
  p_contract_version integer,
  p_evidence_object_key text,
  p_evidence_checksum bytea,
  p_evidence_byte_count bigint,
  p_faq_evidence_object_key text,
  p_search_evidence_object_key text,
  p_provider_resource_ciphertext bytea,
  p_provider_resource_fingerprint bytea,
  p_faq_source_uri text,
  p_faq_checksum bytea,
  p_search_source_uri text,
  p_search_checksum bytea,
  p_source_observed_on date,
  p_restricted_reference text,
  p_contact_modes jsonb,
  p_provider_calls integer,
  p_actor text
)
RETURNS TABLE (
  packet_id uuid,
  template_version_id uuid,
  contract_version integer,
  governance_state text,
  fulfillment_state text,
  registered_at timestamptz,
  disposition text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  source record;
  existing app.marketplace_contact_contract_packets%ROWTYPE;
  expected_modes constant jsonb := jsonb_build_array(
    jsonb_build_object(
      'code', 'standard',
      'display_order', 1,
      'customer_meaning',
        'Standard LinkedIn profile data without a contact-data promise.',
      'preview_state', 'available',
      'fulfillment_state', 'not_enabled'
    ),
    jsonb_build_object(
      'code', 'enriched_when_available',
      'display_order', 2,
      'customer_meaning',
        'Standard profiles plus available business contact information.',
      'preview_state', 'not_enabled',
      'fulfillment_state', 'not_enabled'
    ),
    jsonb_build_object(
      'code', 'contacts_only',
      'display_order', 3,
      'customer_meaning',
        'Only profiles satisfying the provider''s unproven contact-presence semantics.',
      'preview_state', 'not_enabled',
      'fulfillment_state', 'not_enabled'
    )
  );
BEGIN
  SELECT resolved.* INTO source
  FROM app.resolve_linkedin_people_contact_contract_candidate(p_candidate_id)
    AS resolved;

  IF source.candidate_id IS NULL THEN
    RAISE EXCEPTION 'LINKEDIN_PEOPLE_CONTACT_CONTRACT_SOURCE_UNAVAILABLE'
      USING ERRCODE = '55000';
  END IF;

  IF p_packet_id IS NULL
     OR p_template_version_id IS DISTINCT FROM source.template_version_id
     OR p_contract_version <> 1
     OR p_evidence_object_key IS DISTINCT FROM
       'qualification/contact-contracts/' || p_packet_id::text ||
       '/source-manifest.json'
     OR p_evidence_checksum IS NULL OR octet_length(p_evidence_checksum) <> 32
     OR p_evidence_byte_count <= 1
     OR p_faq_evidence_object_key IS DISTINCT FROM
       'qualification/contact-contracts/' || p_packet_id::text ||
       '/marketplace-faq.md'
     OR p_search_evidence_object_key IS DISTINCT FROM
       'qualification/contact-contracts/' || p_packet_id::text ||
       '/search-contract.md'
     OR p_provider_resource_ciphertext IS NULL
     OR octet_length(p_provider_resource_ciphertext) < 32
     OR p_provider_resource_fingerprint IS NULL
     OR octet_length(p_provider_resource_fingerprint) <> 32
     OR p_faq_source_uri IS DISTINCT FROM
       'https://docs.brightdata.com/products/marketplace/faqs'
     OR p_faq_checksum IS NULL OR octet_length(p_faq_checksum) <> 32
     OR p_search_source_uri IS DISTINCT FROM
       'https://docs.brightdata.com/api-reference/marketplace-dataset-api/search-dataset'
     OR p_search_checksum IS NULL OR octet_length(p_search_checksum) <> 32
     OR p_source_observed_on IS NULL
     OR p_source_observed_on > current_date
     OR length(p_restricted_reference) NOT BETWEEN 8 AND 1024
     OR btrim(p_restricted_reference) <> p_restricted_reference
     OR p_contact_modes IS DISTINCT FROM expected_modes
     OR p_provider_calls <> 0
     OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$' THEN
    RAISE EXCEPTION 'LINKEDIN_PEOPLE_CONTACT_CONTRACT_INVALID'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_template_version_id::text || ':contact-contract:1', 0)
  );

  SELECT packet.* INTO existing
  FROM app.marketplace_contact_contract_packets AS packet
  WHERE packet.service_template_version_id = p_template_version_id
    AND packet.contract_version = 1;

  IF FOUND THEN
    IF existing.catalog_candidate_id = p_candidate_id
       AND existing.id = p_packet_id
       AND existing.evidence_object_key = p_evidence_object_key
       AND existing.evidence_checksum = p_evidence_checksum
       AND existing.evidence_byte_count = p_evidence_byte_count
       AND existing.faq_evidence_object_key = p_faq_evidence_object_key
       AND existing.search_evidence_object_key = p_search_evidence_object_key
       AND existing.provider_resource_ciphertext = p_provider_resource_ciphertext
       AND existing.provider_resource_fingerprint = p_provider_resource_fingerprint
       AND existing.faq_source_uri = p_faq_source_uri
       AND existing.faq_checksum = p_faq_checksum
       AND existing.search_source_uri = p_search_source_uri
       AND existing.search_checksum = p_search_checksum
       AND existing.source_observed_on = p_source_observed_on
       AND existing.restricted_reference = p_restricted_reference
       AND existing.governance_state = 'fulfillment_evidence_pending'
       AND existing.fulfillment_state = 'not_enabled'
       AND existing.provider_calls = 0
       AND (
         SELECT jsonb_agg(jsonb_build_object(
           'code', mode.mode,
           'display_order', mode.display_order,
           'customer_meaning', mode.customer_meaning,
           'preview_state', mode.preview_state,
           'fulfillment_state', mode.fulfillment_state
         ) ORDER BY mode.display_order)
         FROM app.marketplace_contact_mode_contracts AS mode
         WHERE mode.packet_id = existing.id
       ) = expected_modes THEN
      RETURN QUERY SELECT
        existing.id, existing.service_template_version_id,
        existing.contract_version, existing.governance_state,
        existing.fulfillment_state, existing.registered_at, 'existing'::text;
      RETURN;
    END IF;
    RAISE EXCEPTION 'LINKEDIN_PEOPLE_CONTACT_CONTRACT_VERSION_CONFLICT'
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO app.marketplace_contact_contract_packets (
    id, catalog_candidate_id, service_template_version_id, contract_version,
    evidence_object_key, evidence_checksum, evidence_byte_count,
    faq_evidence_object_key, search_evidence_object_key,
    provider_resource_ciphertext, provider_resource_fingerprint,
    faq_source_uri, faq_checksum, search_source_uri, search_checksum,
    source_observed_on, restricted_reference, governance_state,
    fulfillment_state, provider_calls
  ) VALUES (
    p_packet_id, p_candidate_id, p_template_version_id, 1,
    p_evidence_object_key, p_evidence_checksum, p_evidence_byte_count,
    p_faq_evidence_object_key, p_search_evidence_object_key,
    p_provider_resource_ciphertext, p_provider_resource_fingerprint,
    p_faq_source_uri, p_faq_checksum, p_search_source_uri, p_search_checksum,
    p_source_observed_on, p_restricted_reference,
    'fulfillment_evidence_pending', 'not_enabled', 0
  ) RETURNING * INTO existing;

  INSERT INTO app.marketplace_contact_mode_contracts (
    packet_id, mode, display_order, customer_meaning, preview_state,
    fulfillment_state
  )
  SELECT
    p_packet_id,
    mode_item.value->>'code',
    (mode_item.value->>'display_order')::integer,
    mode_item.value->>'customer_meaning',
    mode_item.value->>'preview_state',
    mode_item.value->>'fulfillment_state'
  FROM jsonb_array_elements(expected_modes) AS mode_item(value);

  INSERT INTO app.audit_events (action, target_type, target_id, outcome, safe_diff)
  VALUES (
    'provider.contact_contract.register',
    'marketplace_contact_contract_packet',
    p_packet_id,
    'completed',
    jsonb_build_object(
      'actor', p_actor,
      'template_slug', 'linkedin-people',
      'template_version', 1,
      'contract_version', 1,
      'documented_mode_count', 3,
      'standard_preview_available', true,
      'contact_preview_enabled', false,
      'contact_fulfillment_enabled', false,
      'customer_execution_enabled', false,
      'provider_calls', 0
    )
  );

  RETURN QUERY SELECT
    existing.id, existing.service_template_version_id,
    existing.contract_version, existing.governance_state,
    existing.fulfillment_state, existing.registered_at, 'created'::text;
END;
$$;

-- Customer-safe read projection. It exposes only the documented Dhumi mode,
-- ordering, explanatory copy and disabled/available states. Evidence paths,
-- checksums and the encrypted provider identifier remain private.
CREATE FUNCTION app.resolve_marketplace_contact_modes(
  p_template_id uuid,
  p_template_version integer
)
RETURNS TABLE (
  code text,
  display_order integer,
  customer_meaning text,
  preview_state text,
  fulfillment_state text
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT
    mode.mode,
    mode.display_order,
    mode.customer_meaning,
    mode.preview_state,
    mode.fulfillment_state
  FROM app.marketplace_contact_contract_packets AS packet
  JOIN app.service_template_versions AS version
    ON version.id = packet.service_template_version_id
  JOIN app.marketplace_contact_mode_contracts AS mode
    ON mode.packet_id = packet.id
  WHERE version.service_template_id = p_template_id
    AND version.version = p_template_version
    AND packet.contract_version = 1
    AND packet.governance_state = 'fulfillment_evidence_pending'
    AND packet.fulfillment_state = 'not_enabled'
    AND packet.provider_calls = 0
  ORDER BY mode.display_order;
$$;

REVOKE ALL ON FUNCTION app.resolve_linkedin_people_contact_contract_candidate(uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app.record_linkedin_people_contact_contract(
  uuid, uuid, uuid, integer, text, bytea, bigint, text, text, bytea, bytea,
  text, bytea, text, bytea, date, text, jsonb, integer, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_marketplace_contact_modes(uuid, integer)
  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.resolve_linkedin_people_contact_contract_candidate(uuid)
  TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.record_linkedin_people_contact_contract(
  uuid, uuid, uuid, integer, text, bytea, bigint, text, text, bytea, bytea,
  text, bytea, text, bytea, date, text, jsonb, integer, text
) TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.resolve_marketplace_contact_modes(uuid, integer)
  TO dhumi_customer_api;

RESET ROLE;
