-- PostgreSQL-authoritative timestamps for LinkedIn Posts provider samples.
--
-- PostgreSQL qualification evidence retains microseconds while JavaScript Date
-- retains milliseconds. The M9 packet timestamp is
-- 2026-09-12 20:20:22.574503+00; a Node round-trip produces
-- 2026-09-12T20:20:22.574Z. The v1 write function correctly required exact
-- evidence timestamps, but accepting those timestamps from Node made a valid
-- persistent promotion impossible. This wrapper derives collection and expiry
-- timestamps inside PostgreSQL from the retained qualification packet.
--
-- This migration does not call Bright Data, publish a Template or mapping,
-- grant customer execution, create a Service/Run, or enqueue provider work.

SET ROLE dhumi_owner;

CREATE FUNCTION app.record_marketplace_provider_sample_v2(
  p_sample_id uuid,
  p_packet_id uuid,
  p_template_version_id uuid,
  p_sample_version integer,
  p_object_key text,
  p_record_count integer,
  p_byte_count bigint,
  p_checksum bytea,
  p_metadata_checksum bytea,
  p_field_dictionary jsonb,
  p_interim_decision_reference text,
  p_actor text
)
RETURNS TABLE (
  sample_id uuid,
  disposition text,
  collected_at timestamptz,
  expires_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT
    recorded.sample_id,
    recorded.disposition,
    source.completed_at,
    source.completed_at + interval '720 hours'
  FROM app.resolve_marketplace_provider_sample_source(p_packet_id) AS source
  CROSS JOIN LATERAL app.record_marketplace_provider_sample_v1(
    p_sample_id,
    source.packet_id,
    p_template_version_id,
    p_sample_version,
    p_object_key,
    p_record_count,
    p_byte_count,
    p_checksum,
    p_metadata_checksum,
    p_field_dictionary,
    p_interim_decision_reference,
    source.completed_at,
    source.completed_at + interval '720 hours',
    p_actor
  ) AS recorded;
$$;

REVOKE ALL ON FUNCTION app.record_marketplace_provider_sample_v2(
  uuid, uuid, uuid, integer, text, integer, bigint, bytea, bytea, jsonb,
  text, text
) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION app.record_marketplace_provider_sample_v1(
  uuid, uuid, uuid, integer, text, integer, bigint, bytea, bytea, jsonb,
  text, timestamptz, timestamptz, text
) FROM dhumi_operator;

GRANT EXECUTE ON FUNCTION app.record_marketplace_provider_sample_v2(
  uuid, uuid, uuid, integer, text, integer, bigint, bytea, bytea, jsonb,
  text, text
) TO dhumi_operator;

RESET ROLE;
