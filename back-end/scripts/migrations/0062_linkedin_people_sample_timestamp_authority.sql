-- PostgreSQL-owned timestamp authority for LinkedIn People sample ingestion.
--
-- The provider metadata observation is stored with PostgreSQL microsecond
-- precision, while JavaScript Date values have millisecond precision. Passing
-- the observation timestamp through JavaScript therefore cannot preserve an
-- exact equality boundary. This forward-only correction keeps migration 0061
-- immutable and makes PostgreSQL pass its retained source timestamp directly
-- into the existing fail-closed recorder.

SET ROLE dhumi_owner;

CREATE FUNCTION app.record_linkedin_people_synthetic_sample_v2(
  p_sample_id uuid,
  p_observation_id uuid,
  p_template_version_id uuid,
  p_sample_version integer,
  p_object_key text,
  p_record_count integer,
  p_byte_count bigint,
  p_checksum bytea,
  p_metadata_checksum bytea,
  p_field_dictionary jsonb,
  p_actor text
)
RETURNS TABLE (sample_id uuid, disposition text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  source record;
BEGIN
  SELECT resolved.* INTO source
  FROM app.resolve_linkedin_people_synthetic_sample_source() AS resolved
  WHERE resolved.observation_id = p_observation_id;

  IF source.observation_id IS NULL THEN
    RAISE EXCEPTION 'LINKEDIN_PEOPLE_SYNTHETIC_SAMPLE_SOURCE_UNAVAILABLE'
      USING ERRCODE = '55000';
  END IF;

  RETURN QUERY
  SELECT recorded.sample_id, recorded.disposition
  FROM app.record_linkedin_people_synthetic_sample_v1(
    p_sample_id,
    p_observation_id,
    p_template_version_id,
    p_sample_version,
    p_object_key,
    p_record_count,
    p_byte_count,
    p_checksum,
    p_metadata_checksum,
    p_field_dictionary,
    source.observed_at,
    source.observed_at + interval '720 hours',
    p_actor
  ) AS recorded;
END;
$$;

REVOKE EXECUTE ON FUNCTION app.record_linkedin_people_synthetic_sample_v1(
  uuid, uuid, uuid, integer, text, integer, bigint, bytea, bytea, jsonb,
  timestamptz, timestamptz, text
) FROM dhumi_operator;

REVOKE ALL ON FUNCTION app.record_linkedin_people_synthetic_sample_v2(
  uuid, uuid, uuid, integer, text, integer, bigint, bytea, bytea, jsonb, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.record_linkedin_people_synthetic_sample_v2(
  uuid, uuid, uuid, integer, text, integer, bigint, bytea, bytea, jsonb, text
) TO dhumi_operator;

RESET ROLE;
