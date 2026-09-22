-- Priority 2: append-only, private metadata evidence for standard LinkedIn People.
-- This migration creates no public pointer, sample, mapping, Run, outbox job,
-- entitlement, payment, Search, Filter, purchase or export capability.

SET ROLE dhumi_owner;

CREATE TABLE app.marketplace_catalog_metadata_observations (
  id uuid PRIMARY KEY,
  catalog_candidate_id uuid NOT NULL
    REFERENCES app.catalog_candidates(id) ON DELETE RESTRICT,
  evidence_object_key text NOT NULL UNIQUE,
  metadata_checksum bytea NOT NULL CHECK (octet_length(metadata_checksum) = 32),
  byte_count bigint NOT NULL CHECK (byte_count > 1),
  field_count integer NOT NULL CHECK (field_count > 0 AND field_count <= 10000),
  content_type text NOT NULL CHECK (content_type = 'application/json'),
  restricted_reference text NOT NULL
    CHECK (length(restricted_reference) BETWEEN 8 AND 1024),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TRIGGER marketplace_catalog_metadata_observations_immutable
  BEFORE UPDATE OR DELETE ON app.marketplace_catalog_metadata_observations
  FOR EACH ROW EXECUTE FUNCTION app.reject_version_mutation();

ALTER TABLE app.marketplace_catalog_metadata_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.marketplace_catalog_metadata_observations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.marketplace_catalog_metadata_observations FROM PUBLIC;

CREATE POLICY marketplace_catalog_metadata_observations_operator_select
  ON app.marketplace_catalog_metadata_observations
  FOR SELECT TO dhumi_operator USING (true);

CREATE POLICY marketplace_catalog_metadata_observations_owner_all
  ON app.marketplace_catalog_metadata_observations
  FOR ALL TO dhumi_owner USING (true) WITH CHECK (true);

-- audit_events uses FORCE RLS. Permit only the exact tenantless audit emitted
-- by the private metadata observation recorder; runtime roles receive no
-- direct table grant.
CREATE POLICY audit_events_linkedin_people_metadata_observation_insert
  ON app.audit_events
  FOR INSERT TO dhumi_owner
  WITH CHECK (
    tenant_id IS NULL
    AND actor_user_id IS NULL
    AND actor_api_key_id IS NULL
    AND request_id IS NULL
    AND ip_fingerprint IS NULL
    AND action = 'provider.catalog_metadata.capture'
    AND target_type = 'marketplace_catalog_metadata_observation'
    AND target_id IS NOT NULL
    AND outcome = 'completed'
  );

CREATE FUNCTION app.resolve_linkedin_people_metadata_candidate(p_candidate_id uuid)
RETURNS TABLE (
  candidate_id uuid,
  environment text,
  resource_code text,
  provider_resource_ciphertext bytea,
  provider_resource_fingerprint bytea
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT
    candidate.id,
    import.environment,
    candidate.resource_code,
    candidate.provider_resource_ciphertext,
    candidate.provider_resource_fingerprint
  FROM app.catalog_candidates AS candidate
  JOIN app.catalog_imports AS import ON import.id = candidate.catalog_import_id
  JOIN app.adapter_versions AS adapter ON adapter.id = candidate.adapter_version_id
  JOIN app.adapter_definitions AS definition
    ON definition.id = adapter.adapter_definition_id
  WHERE candidate.id = p_candidate_id
    AND candidate.resource_code = 'linkedin.people.standard'
    AND candidate.review_state = 'approved'
    AND candidate.service_template_version_id IS NOT NULL
    AND import.state = 'completed'
    AND import.environment IN ('local', 'test')
    AND definition.code = 'bright_data.marketplace.catalogue'
    AND adapter.semantic_version = '1.0.0-m2';
$$;

CREATE FUNCTION app.record_linkedin_people_metadata_observation(
  p_observation_id uuid,
  p_candidate_id uuid,
  p_evidence_object_key text,
  p_metadata_checksum bytea,
  p_byte_count bigint,
  p_field_count integer,
  p_content_type text,
  p_restricted_reference text,
  p_actor text
)
RETURNS TABLE (
  observation_id uuid,
  candidate_id uuid,
  field_count integer,
  byte_count bigint,
  metadata_checksum bytea,
  observed_at timestamptz,
  disposition text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  resolved app.marketplace_catalog_metadata_observations%ROWTYPE;
BEGIN
  IF p_observation_id IS NULL
     OR p_candidate_id IS NULL
     OR p_evidence_object_key <>
       'qualification/catalog-imports/' || p_observation_id::text ||
       '/metadata/linkedin-people-standard.json'
     OR p_metadata_checksum IS NULL
     OR octet_length(p_metadata_checksum) <> 32
     OR p_byte_count <= 1
     OR p_field_count NOT BETWEEN 1 AND 10000
     OR p_content_type <> 'application/json'
     OR length(p_restricted_reference) NOT BETWEEN 8 AND 1024
     OR btrim(p_restricted_reference) <> p_restricted_reference
     OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$' THEN
    RAISE EXCEPTION 'MARKETPLACE_PEOPLE_METADATA_OBSERVATION_INVALID'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM app.resolve_linkedin_people_metadata_candidate(p_candidate_id)
  ) THEN
    RAISE EXCEPTION 'MARKETPLACE_PEOPLE_METADATA_CANDIDATE_NOT_FOUND'
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO app.marketplace_catalog_metadata_observations (
    id, catalog_candidate_id, evidence_object_key, metadata_checksum,
    byte_count, field_count, content_type, restricted_reference
  ) VALUES (
    p_observation_id, p_candidate_id, p_evidence_object_key, p_metadata_checksum,
    p_byte_count, p_field_count, p_content_type, p_restricted_reference
  ) RETURNING * INTO resolved;

  INSERT INTO app.audit_events (
    action, target_type, target_id, outcome, safe_diff
  ) VALUES (
    'provider.catalog_metadata.capture',
    'marketplace_catalog_metadata_observation',
    resolved.id,
    'completed',
    jsonb_build_object(
      'actor', p_actor,
      'candidate_id', p_candidate_id,
      'resource_code', 'linkedin.people.standard',
      'field_count', p_field_count,
      'byte_count', p_byte_count,
      'provider_method', 'GET',
      'provider_call_count', 1,
      'public_template_changed', false,
      'customer_execution_enabled', false
    )
  );

  RETURN QUERY SELECT
    resolved.id, resolved.catalog_candidate_id, resolved.field_count,
    resolved.byte_count, resolved.metadata_checksum, resolved.observed_at,
    'created'::text;
END;
$$;

REVOKE ALL ON FUNCTION app.resolve_linkedin_people_metadata_candidate(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.record_linkedin_people_metadata_observation(
  uuid, uuid, text, bytea, bigint, integer, text, text, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.resolve_linkedin_people_metadata_candidate(uuid)
  TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.record_linkedin_people_metadata_observation(
  uuid, uuid, text, bytea, bigint, integer, text, text, text
) TO dhumi_operator;

RESET ROLE;
