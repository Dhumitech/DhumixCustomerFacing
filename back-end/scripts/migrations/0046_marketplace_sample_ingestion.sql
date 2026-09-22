-- M3 fixture slice: immutable, private Marketplace sample ingestion.
--
-- This migration intentionally supports synthetic fixtures only. It creates no
-- customer route, public Template pointer, provider call, execution mapping,
-- entitlement, purchase, Search, Filter, export or real-sample publication.
-- DM-001, DM-006 and DM-007 remain required before a later migration may admit
-- a rights-approved real sample.

SET ROLE dhumi_owner;

CREATE TABLE app.marketplace_sample_versions (
  id uuid PRIMARY KEY,
  service_template_version_id uuid NOT NULL
    REFERENCES app.service_template_versions(id) ON DELETE RESTRICT,
  sample_version integer NOT NULL CHECK (sample_version > 0),
  source_kind text NOT NULL CHECK (source_kind = 'synthetic_fixture'),
  object_key text NOT NULL UNIQUE,
  content_type text NOT NULL CHECK (content_type = 'application/json'),
  record_count integer NOT NULL CHECK (record_count > 0),
  byte_count bigint NOT NULL CHECK (byte_count >= 2),
  checksum bytea NOT NULL CHECK (octet_length(checksum) = 32),
  source_metadata_checksum bytea NOT NULL
    CHECK (octet_length(source_metadata_checksum) = 32),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  masking_policy_version text NOT NULL
    CHECK (masking_policy_version ~ '^[a-z][a-z0-9._-]{2,127}$'),
  retention_policy_version text NOT NULL
    CHECK (retention_policy_version ~ '^[a-z][a-z0-9._-]{2,127}$'),
  provenance_evidence_reference text NOT NULL
    CHECK (
      provenance_evidence_reference ~
        '^fixture://[A-Za-z0-9][A-Za-z0-9._/-]*$'
      AND length(provenance_evidence_reference) BETWEEN 16 AND 1024
    ),
  rights_evidence_reference text,
  collected_at timestamptz NOT NULL,
  published_at timestamptz,
  expires_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state = 'validated_fixture'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT marketplace_sample_versions_identity_unique
    UNIQUE (service_template_version_id, sample_version),
  CONSTRAINT marketplace_sample_versions_fixture_only_check CHECK (
    rights_evidence_reference IS NULL
    AND published_at IS NULL
    AND expires_at > collected_at
  )
);

CREATE TRIGGER marketplace_sample_versions_immutable
  BEFORE UPDATE OR DELETE ON app.marketplace_sample_versions
  FOR EACH ROW EXECUTE FUNCTION app.reject_version_mutation();

ALTER TABLE app.marketplace_sample_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.marketplace_sample_versions FORCE ROW LEVEL SECURITY;

CREATE POLICY marketplace_sample_versions_m3_owner_select
  ON app.marketplace_sample_versions
  FOR SELECT
  TO dhumi_owner
  USING (
    source_kind = 'synthetic_fixture'
    AND state = 'validated_fixture'
    AND rights_evidence_reference IS NULL
    AND published_at IS NULL
  );

CREATE POLICY marketplace_sample_versions_m3_owner_insert
  ON app.marketplace_sample_versions
  FOR INSERT
  TO dhumi_owner
  WITH CHECK (
    source_kind = 'synthetic_fixture'
    AND state = 'validated_fixture'
    AND rights_evidence_reference IS NULL
    AND published_at IS NULL
  );

REVOKE ALL ON app.marketplace_sample_versions FROM PUBLIC;

-- audit_events uses FORCE RLS. Permit only the exact tenantless audit emitted
-- by the M3 fixture recorder; runtime roles receive no direct table grant.
CREATE POLICY audit_events_marketplace_sample_fixture_definer_insert
  ON app.audit_events
  FOR INSERT
  TO dhumi_owner
  WITH CHECK (
    tenant_id IS NULL
    AND actor_user_id IS NULL
    AND actor_api_key_id IS NULL
    AND request_id IS NULL
    AND ip_fingerprint IS NULL
    AND action = 'marketplace.sample_fixture.ingest'
    AND target_type = 'marketplace_sample_version'
    AND target_id IS NOT NULL
  );

CREATE FUNCTION app.resolve_marketplace_sample_ingestion_target(
  p_template_slug text,
  p_template_version integer
)
RETURNS TABLE (
  template_version_id uuid,
  template_slug text,
  template_version integer,
  metadata_checksum bytea
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT
    version.id,
    template.slug,
    version.version,
    candidate.metadata_checksum
  FROM app.service_templates AS template
  JOIN app.service_template_versions AS version
    ON version.service_template_id = template.id
  JOIN app.catalog_candidates AS candidate
    ON candidate.service_template_version_id = version.id
  JOIN app.adapter_versions AS adapter
    ON adapter.id = version.adapter_version_id
  JOIN app.adapter_definitions AS definition
    ON definition.id = adapter.adapter_definition_id
  WHERE p_template_slug = 'linkedin-posts'
    AND p_template_version = 1
    AND template.slug = p_template_slug
    AND template.product_family = 'marketplace_dataset'
    AND template.state = 'draft'
    AND template.current_public_version_id IS NULL
    AND version.version = p_template_version
    AND version.availability_state = 'coming_soon'
    AND version.effective_at IS NULL
    AND version.published_at IS NULL
    AND candidate.resource_code = 'linkedin.posts'
    AND candidate.review_state = 'approved'
    AND candidate.metadata_checksum IS NOT NULL
    AND octet_length(candidate.metadata_checksum) = 32
    AND definition.code = 'bright_data.marketplace.catalogue'
    AND adapter.semantic_version = '1.0.0-m2'
    AND adapter.state = 'disabled';
$$;

CREATE FUNCTION app.record_marketplace_fixture_sample(
  p_sample_id uuid,
  p_template_version_id uuid,
  p_sample_version integer,
  p_object_key text,
  p_content_type text,
  p_record_count integer,
  p_byte_count bigint,
  p_checksum bytea,
  p_metadata_checksum bytea,
  p_schema_version integer,
  p_masking_policy_version text,
  p_retention_policy_version text,
  p_provenance_evidence_reference text,
  p_collected_at timestamptz,
  p_expires_at timestamptz,
  p_actor text
)
RETURNS TABLE (sample_id uuid, disposition text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  existing_sample app.marketplace_sample_versions%ROWTYPE;
  expected_object_key text;
BEGIN
  expected_object_key := 'marketplace/samples/' || p_template_version_id::text ||
    '/' || p_sample_version::text || '/' || encode(p_checksum, 'hex') || '.json';

  IF p_sample_id IS NULL
     OR p_template_version_id IS NULL
     OR p_sample_version IS NULL OR p_sample_version < 1
     OR p_content_type <> 'application/json'
     OR p_record_count IS NULL OR p_record_count < 1
     OR p_byte_count IS NULL OR p_byte_count < 2
     OR p_checksum IS NULL OR octet_length(p_checksum) <> 32
     OR p_metadata_checksum IS NULL OR octet_length(p_metadata_checksum) <> 32
     OR p_schema_version IS NULL OR p_schema_version < 1
     OR p_masking_policy_version !~ '^[a-z][a-z0-9._-]{2,127}$'
     OR p_retention_policy_version !~ '^[a-z][a-z0-9._-]{2,127}$'
     OR p_provenance_evidence_reference !~
       '^fixture://[A-Za-z0-9][A-Za-z0-9._/-]*$'
     OR length(p_provenance_evidence_reference) NOT BETWEEN 16 AND 1024
     OR p_collected_at IS NULL
     OR p_expires_at IS NULL OR p_expires_at <= p_collected_at
     OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$'
     OR p_object_key IS DISTINCT FROM expected_object_key THEN
    RAISE EXCEPTION 'MARKETPLACE_FIXTURE_SAMPLE_INVALID' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM app.resolve_marketplace_sample_ingestion_target('linkedin-posts', 1) AS target
    WHERE target.template_version_id = p_template_version_id
      AND target.metadata_checksum = p_metadata_checksum
  ) THEN
    RAISE EXCEPTION 'MARKETPLACE_SAMPLE_TARGET_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_template_version_id::text || ':' || p_sample_version::text, 0)
  );

  SELECT sample.*
  INTO existing_sample
  FROM app.marketplace_sample_versions AS sample
  WHERE sample.service_template_version_id = p_template_version_id
    AND sample.sample_version = p_sample_version;

  IF FOUND THEN
    IF existing_sample.object_key = p_object_key
       AND existing_sample.content_type = p_content_type
       AND existing_sample.record_count = p_record_count
       AND existing_sample.byte_count = p_byte_count
       AND existing_sample.checksum = p_checksum
       AND existing_sample.source_metadata_checksum = p_metadata_checksum
       AND existing_sample.schema_version = p_schema_version
       AND existing_sample.masking_policy_version = p_masking_policy_version
       AND existing_sample.retention_policy_version = p_retention_policy_version
       AND existing_sample.provenance_evidence_reference = p_provenance_evidence_reference
       AND existing_sample.collected_at = p_collected_at
       AND existing_sample.expires_at = p_expires_at
       AND existing_sample.source_kind = 'synthetic_fixture'
       AND existing_sample.state = 'validated_fixture'
       AND existing_sample.rights_evidence_reference IS NULL
       AND existing_sample.published_at IS NULL THEN
      RETURN QUERY SELECT existing_sample.id, 'existing'::text;
      RETURN;
    END IF;
    RAISE EXCEPTION 'MARKETPLACE_SAMPLE_VERSION_CONFLICT' USING ERRCODE = '23505';
  END IF;

  INSERT INTO app.marketplace_sample_versions (
    id,
    service_template_version_id,
    sample_version,
    source_kind,
    object_key,
    content_type,
    record_count,
    byte_count,
    checksum,
    source_metadata_checksum,
    schema_version,
    masking_policy_version,
    retention_policy_version,
    provenance_evidence_reference,
    rights_evidence_reference,
    collected_at,
    published_at,
    expires_at,
    state
  ) VALUES (
    p_sample_id,
    p_template_version_id,
    p_sample_version,
    'synthetic_fixture',
    p_object_key,
    p_content_type,
    p_record_count,
    p_byte_count,
    p_checksum,
    p_metadata_checksum,
    p_schema_version,
    p_masking_policy_version,
    p_retention_policy_version,
    p_provenance_evidence_reference,
    NULL,
    p_collected_at,
    NULL,
    p_expires_at,
    'validated_fixture'
  );

  INSERT INTO app.audit_events (
    action, target_type, target_id, outcome, safe_diff
  ) VALUES (
    'marketplace.sample_fixture.ingest',
    'marketplace_sample_version',
    p_sample_id,
    'completed',
    jsonb_build_object(
      'actor', p_actor,
      'template_slug', 'linkedin-posts',
      'template_version', 1,
      'sample_version', p_sample_version,
      'record_count', p_record_count,
      'byte_count', p_byte_count,
      'checksum', encode(p_checksum, 'hex'),
      'schema_version', p_schema_version,
      'masking_policy_version', p_masking_policy_version,
      'retention_policy_version', p_retention_policy_version,
      'expires_at', p_expires_at,
      'source_kind', 'synthetic_fixture',
      'customer_visible', false,
      'provider_calls', 0
    )
  );

  RETURN QUERY SELECT p_sample_id, 'created'::text;
END;
$$;

REVOKE ALL ON FUNCTION app.resolve_marketplace_sample_ingestion_target(text, integer)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app.record_marketplace_fixture_sample(
  uuid, uuid, integer, text, text, integer, bigint, bytea, bytea, integer,
  text, text, text, timestamptz, timestamptz, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.resolve_marketplace_sample_ingestion_target(text, integer)
  TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.record_marketplace_fixture_sample(
  uuid, uuid, integer, text, text, integer, bigint, bytea, bytea, integer,
  text, text, text, timestamptz, timestamptz, text
) TO dhumi_operator;

RESET ROLE;
