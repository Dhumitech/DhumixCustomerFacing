-- Generated sample-download retention v1 (not source-sample retention):
-- failed reservations: immediate cleanup; abandoned reservations: after 1 hour;
-- authorized objects: only after download_expires_at + 1 hour.
-- Preserve authorization/idempotency/audit records. No provider work is created.
SET ROLE dhumi_owner;

CREATE FUNCTION app.fail_marketplace_sample_download_for_cleanup(p_authorization_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  authorization_row app.marketplace_sample_download_authorizations%ROWTYPE;
BEGIN
  SELECT candidate.* INTO authorization_row
  FROM app.marketplace_sample_download_authorizations AS candidate
  WHERE candidate.tenant_id = app.current_tenant_id() AND candidate.id = p_authorization_id
  FOR UPDATE;

  IF NOT FOUND OR authorization_row.state = 'authorized' THEN
    RETURN false;
  END IF;
  IF authorization_row.state = 'reserved' THEN
    UPDATE app.marketplace_sample_download_authorizations
    SET state = 'failed', failed_at = clock_timestamp()
    WHERE tenant_id = app.current_tenant_id() AND id = p_authorization_id;
  END IF;
  RETURN true;
END;
$$;

CREATE FUNCTION app.claim_marketplace_sample_download_cleanup(
  p_tenant_id uuid,
  p_authorization_id uuid,
  p_object_key text
)
RETURNS TABLE (
  disposition text,
  stored_content_type text,
  stored_file_name text,
  stored_byte_count bigint,
  stored_checksum bytea
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  authorization_row app.marketplace_sample_download_authorizations%ROWTYPE;
  evaluated_at timestamptz := clock_timestamp();
  prior_tenant text := current_setting('app.tenant_id', true);
  cleanup_allowed boolean := false;
BEGIN
  IF p_tenant_id IS NULL OR p_authorization_id IS NULL OR p_object_key IS NULL THEN
    RAISE EXCEPTION 'MARKETPLACE_SAMPLE_DOWNLOAD_CLEANUP_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- Only the private operator can choose a Tenant. Reuse the existing forced
  -- Tenant RLS policy instead of granting global table access to a new role.
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);
  SELECT candidate.* INTO authorization_row
  FROM app.marketplace_sample_download_authorizations AS candidate
  WHERE candidate.tenant_id = p_tenant_id AND candidate.id = p_authorization_id
    AND candidate.object_key = p_object_key
    AND candidate.object_key = 'marketplace/sample-downloads/' || p_tenant_id::text || '/'
      || p_authorization_id::text || '/' || encode(candidate.checksum, 'hex') || '.' || candidate.format
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'untracked'::text, NULL::text, NULL::text, NULL::bigint, NULL::bytea;
  ELSE
    cleanup_allowed := authorization_row.state = 'failed'
      OR (authorization_row.state = 'reserved'
        AND authorization_row.created_at <= evaluated_at - interval '1 hour')
      OR (authorization_row.state = 'authorized'
        AND authorization_row.download_expires_at <= evaluated_at - interval '1 hour');

    IF cleanup_allowed AND authorization_row.state = 'reserved' THEN
      -- This row lock serializes with completion. Once failed, late completion
      -- cannot authorize or disclose a URL for the object being reclaimed.
      UPDATE app.marketplace_sample_download_authorizations
      SET state = 'failed', failed_at = evaluated_at
      WHERE tenant_id = p_tenant_id AND id = p_authorization_id;
    END IF;

    RETURN QUERY SELECT
      CASE WHEN cleanup_allowed THEN 'eligible'::text ELSE 'protected'::text END,
      CASE WHEN cleanup_allowed THEN authorization_row.content_type END,
      CASE WHEN cleanup_allowed THEN authorization_row.file_name END,
      CASE WHEN cleanup_allowed THEN authorization_row.byte_count END,
      CASE WHEN cleanup_allowed THEN authorization_row.checksum END;
  END IF;
  PERFORM set_config('app.tenant_id', coalesce(prior_tenant, ''), true);
END;
$$;

REVOKE ALL ON FUNCTION app.fail_marketplace_sample_download_for_cleanup(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.claim_marketplace_sample_download_cleanup(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.fail_marketplace_sample_download_for_cleanup(uuid)
  TO dhumi_customer_api;
GRANT EXECUTE ON FUNCTION app.claim_marketplace_sample_download_cleanup(uuid, uuid, text)
  TO dhumi_operator;
RESET ROLE;
