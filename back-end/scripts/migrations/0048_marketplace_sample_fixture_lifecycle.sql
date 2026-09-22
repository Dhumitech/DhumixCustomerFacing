-- M3 operational fixture lifecycle.
--
-- This remains a private synthetic-sample boundary. It adds internal retrieval,
-- expiry selection and immutable deletion evidence. It does not publish a
-- customer route, admit provider bytes, or treat a pending MOU as rights proof.

SET ROLE dhumi_owner;

-- Supersede the calendar-day expression from 0047 with the exact duration used
-- by the application. This avoids daylight-saving/session-time-zone drift.
ALTER TABLE app.marketplace_sample_versions
  DROP CONSTRAINT marketplace_sample_versions_retention_policy_v1_check;

ALTER TABLE app.marketplace_sample_versions
  ADD CONSTRAINT marketplace_sample_versions_retention_policy_v2_check
  CHECK (
    retention_policy_version = 'linkedin-posts-sample-30d-v1'
    AND expires_at = collected_at + interval '720 hours'
  );

CREATE TABLE app.marketplace_sample_deletions (
  sample_version_id uuid PRIMARY KEY
    REFERENCES app.marketplace_sample_versions(id) ON DELETE RESTRICT,
  deleted_at timestamptz NOT NULL,
  storage_disposition text NOT NULL
    CHECK (storage_disposition IN ('deleted', 'already_absent')),
  actor text NOT NULL
    CHECK (actor ~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TRIGGER marketplace_sample_deletions_immutable
  BEFORE UPDATE OR DELETE ON app.marketplace_sample_deletions
  FOR EACH ROW EXECUTE FUNCTION app.reject_version_mutation();

ALTER TABLE app.marketplace_sample_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.marketplace_sample_deletions FORCE ROW LEVEL SECURITY;

CREATE POLICY marketplace_sample_deletions_m3_owner_select
  ON app.marketplace_sample_deletions
  FOR SELECT
  TO dhumi_owner
  USING (true);

CREATE POLICY marketplace_sample_deletions_m3_owner_insert
  ON app.marketplace_sample_deletions
  FOR INSERT
  TO dhumi_owner
  WITH CHECK (true);

REVOKE ALL ON app.marketplace_sample_deletions FROM PUBLIC;

CREATE POLICY audit_events_marketplace_sample_expiry_definer_insert
  ON app.audit_events
  FOR INSERT
  TO dhumi_owner
  WITH CHECK (
    tenant_id IS NULL
    AND actor_user_id IS NULL
    AND actor_api_key_id IS NULL
    AND request_id IS NULL
    AND ip_fingerprint IS NULL
    AND action = 'marketplace.sample_fixture.expire'
    AND target_type = 'marketplace_sample_version'
    AND target_id IS NOT NULL
  );

CREATE FUNCTION app.resolve_marketplace_fixture_sample(
  p_template_slug text,
  p_template_version integer,
  p_sample_version integer,
  p_as_of timestamptz
)
RETURNS TABLE (
  sample_id uuid,
  object_key text,
  content_type text,
  record_count integer,
  byte_count bigint,
  checksum bytea,
  metadata_checksum bytea,
  schema_version integer,
  masking_policy_version text,
  retention_policy_version text,
  provenance_evidence_reference text,
  collected_at timestamptz,
  expires_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT
    sample.id,
    sample.object_key,
    sample.content_type,
    sample.record_count,
    sample.byte_count,
    sample.checksum,
    sample.source_metadata_checksum,
    sample.schema_version,
    sample.masking_policy_version,
    sample.retention_policy_version,
    sample.provenance_evidence_reference,
    sample.collected_at,
    sample.expires_at
  FROM app.marketplace_sample_versions AS sample
  JOIN app.service_template_versions AS version
    ON version.id = sample.service_template_version_id
  JOIN app.service_templates AS template
    ON template.id = version.service_template_id
  WHERE p_template_slug = 'linkedin-posts'
    AND p_template_version = 1
    AND p_sample_version > 0
    AND p_as_of IS NOT NULL
    AND template.slug = p_template_slug
    AND template.product_family = 'marketplace_dataset'
    AND template.state = 'draft'
    AND template.current_public_version_id IS NULL
    AND version.version = p_template_version
    AND version.availability_state = 'coming_soon'
    AND sample.sample_version = p_sample_version
    AND sample.source_kind = 'synthetic_fixture'
    AND sample.state = 'validated_fixture'
    AND sample.rights_evidence_reference IS NULL
    AND sample.published_at IS NULL
    AND sample.masking_policy_version =
      'linkedin-posts-provider-mask-preservation-v1'
    AND sample.retention_policy_version = 'linkedin-posts-sample-30d-v1'
    AND sample.expires_at = sample.collected_at + interval '720 hours'
    AND p_as_of < sample.expires_at
    AND NOT EXISTS (
      SELECT 1
      FROM app.marketplace_sample_deletions AS deletion
      WHERE deletion.sample_version_id = sample.id
    );
$$;

CREATE FUNCTION app.list_expired_marketplace_fixture_samples(
  p_as_of timestamptz,
  p_limit integer
)
RETURNS TABLE (sample_id uuid, object_key text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF p_as_of IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'MARKETPLACE_SAMPLE_EXPIRY_INPUT_INVALID'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT sample.id, sample.object_key
  FROM app.marketplace_sample_versions AS sample
  WHERE sample.source_kind = 'synthetic_fixture'
    AND sample.state = 'validated_fixture'
    AND sample.rights_evidence_reference IS NULL
    AND sample.published_at IS NULL
    AND sample.retention_policy_version = 'linkedin-posts-sample-30d-v1'
    AND sample.expires_at <= p_as_of
    AND NOT EXISTS (
      SELECT 1
      FROM app.marketplace_sample_deletions AS deletion
      WHERE deletion.sample_version_id = sample.id
    )
  ORDER BY sample.expires_at, sample.id
  LIMIT p_limit;
END;
$$;

CREATE FUNCTION app.record_marketplace_fixture_deletion(
  p_sample_id uuid,
  p_deleted_at timestamptz,
  p_storage_disposition text,
  p_actor text
)
RETURNS TABLE (sample_id uuid, disposition text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  sample app.marketplace_sample_versions%ROWTYPE;
  existing app.marketplace_sample_deletions%ROWTYPE;
BEGIN
  IF p_sample_id IS NULL
     OR p_deleted_at IS NULL
     OR p_storage_disposition NOT IN ('deleted', 'already_absent')
     OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$' THEN
    RAISE EXCEPTION 'MARKETPLACE_SAMPLE_DELETION_INPUT_INVALID'
      USING ERRCODE = '22023';
  END IF;

  SELECT candidate.*
  INTO sample
  FROM app.marketplace_sample_versions AS candidate
  WHERE candidate.id = p_sample_id
    AND candidate.source_kind = 'synthetic_fixture'
    AND candidate.state = 'validated_fixture'
    AND candidate.rights_evidence_reference IS NULL
    AND candidate.published_at IS NULL
    AND candidate.expires_at <= p_deleted_at;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MARKETPLACE_SAMPLE_EXPIRY_NOT_DUE' USING ERRCODE = '55000';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_sample_id::text, 0));

  SELECT deletion.*
  INTO existing
  FROM app.marketplace_sample_deletions AS deletion
  WHERE deletion.sample_version_id = p_sample_id;

  IF FOUND THEN
    RETURN QUERY SELECT existing.sample_version_id, 'existing'::text;
    RETURN;
  END IF;

  INSERT INTO app.marketplace_sample_deletions (
    sample_version_id,
    deleted_at,
    storage_disposition,
    actor
  ) VALUES (
    p_sample_id,
    p_deleted_at,
    p_storage_disposition,
    p_actor
  );

  INSERT INTO app.audit_events (
    action, target_type, target_id, outcome, safe_diff
  ) VALUES (
    'marketplace.sample_fixture.expire',
    'marketplace_sample_version',
    p_sample_id,
    'completed',
    jsonb_build_object(
      'actor', p_actor,
      'deleted_at', p_deleted_at,
      'storage_disposition', p_storage_disposition,
      'checksum', encode(sample.checksum, 'hex'),
      'byte_count', sample.byte_count,
      'sample_content_retained', false,
      'provider_calls', 0
    )
  );

  RETURN QUERY SELECT p_sample_id, 'created'::text;
END;
$$;

REVOKE ALL ON FUNCTION app.resolve_marketplace_fixture_sample(
  text, integer, integer, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.list_expired_marketplace_fixture_samples(
  timestamptz, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.record_marketplace_fixture_deletion(
  uuid, timestamptz, text, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.resolve_marketplace_fixture_sample(
  text, integer, integer, timestamptz
) TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.list_expired_marketplace_fixture_samples(
  timestamptz, integer
) TO dhumi_operator;
GRANT EXECUTE ON FUNCTION app.record_marketplace_fixture_deletion(
  uuid, timestamptz, text, text
) TO dhumi_operator;

RESET ROLE;
