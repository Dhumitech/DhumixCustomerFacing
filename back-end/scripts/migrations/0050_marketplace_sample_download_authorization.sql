-- M5: bounded, tenant-scoped Marketplace sample download authorizations.
--
-- This migration authorizes only locally materialized stored-sample bytes. It
-- creates no Service, Run, Attempt, usage event, outbox event, entitlement,
-- purchase, provider Search/Filter request, or provider identifier exposure.

SET ROLE dhumi_owner;

CREATE TABLE app.marketplace_sample_download_authorizations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  sample_version_id uuid NOT NULL
    REFERENCES app.marketplace_sample_versions(id) ON DELETE RESTRICT,
  actor_user_id uuid,
  actor_api_key_id uuid,
  actor_fingerprint bytea NOT NULL CHECK (octet_length(actor_fingerprint) = 32),
  idempotency_key text NOT NULL
    CHECK (
      length(idempotency_key) BETWEEN 16 AND 128
      AND idempotency_key ~ '^[A-Za-z0-9._:-]+$'
    ),
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  template_slug text NOT NULL
    CHECK (template_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  template_version integer NOT NULL CHECK (template_version > 0),
  sample_version integer NOT NULL CHECK (sample_version > 0),
  format text NOT NULL CHECK (format IN ('json', 'csv')),
  selected_fields jsonb NOT NULL
    CHECK (jsonb_typeof(selected_fields) = 'array' AND jsonb_array_length(selected_fields) > 0),
  projection_fingerprint bytea NOT NULL
    CHECK (octet_length(projection_fingerprint) = 32),
  record_limit integer NOT NULL CHECK (record_limit BETWEEN 1 AND 100),
  record_count integer NOT NULL CHECK (record_count BETWEEN 0 AND record_limit),
  object_key text NOT NULL UNIQUE,
  content_type text NOT NULL
    CHECK (content_type IN ('application/json; charset=utf-8', 'text/csv; charset=utf-8')),
  file_name text NOT NULL
    CHECK (file_name ~ '^[a-z0-9][a-z0-9._-]{2,159}\.(json|csv)$'),
  byte_count bigint NOT NULL CHECK (byte_count > 0),
  checksum bytea NOT NULL CHECK (octet_length(checksum) = 32),
  state text NOT NULL CHECK (state IN ('reserved', 'authorized', 'failed')),
  download_expires_at timestamptz,
  request_id uuid,
  ip_fingerprint bytea,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  authorized_at timestamptz,
  failed_at timestamptz,
  CONSTRAINT marketplace_sample_download_actor_check CHECK (
    (actor_user_id IS NOT NULL)::integer +
    (actor_api_key_id IS NOT NULL)::integer = 1
  ),
  CONSTRAINT marketplace_sample_download_state_check CHECK (
    (state = 'reserved' AND authorized_at IS NULL AND failed_at IS NULL AND download_expires_at IS NULL)
    OR
    (state = 'authorized' AND authorized_at IS NOT NULL AND failed_at IS NULL
      AND download_expires_at > authorized_at)
    OR
    (state = 'failed' AND authorized_at IS NULL AND failed_at IS NOT NULL AND download_expires_at IS NULL)
  ),
  CONSTRAINT marketplace_sample_download_actor_user_tenant_fk
    FOREIGN KEY (tenant_id, actor_user_id)
    REFERENCES app.tenant_user_access (tenant_id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT marketplace_sample_download_actor_api_key_tenant_fk
    FOREIGN KEY (tenant_id, actor_api_key_id)
    REFERENCES app.platform_api_keys (tenant_id, id)
    ON DELETE RESTRICT,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX marketplace_sample_download_tenant_rate_idx
  ON app.marketplace_sample_download_authorizations (tenant_id, created_at DESC)
  WHERE state IN ('reserved', 'authorized');

ALTER TABLE app.marketplace_sample_download_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.marketplace_sample_download_authorizations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.marketplace_sample_download_authorizations FROM PUBLIC;

CREATE POLICY marketplace_sample_download_owner_access
  ON app.marketplace_sample_download_authorizations
  FOR ALL TO dhumi_owner
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY audit_events_marketplace_sample_download_definer_insert
  ON app.audit_events
  FOR INSERT TO dhumi_owner
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND action = 'marketplace.sample_download_authorize'
    AND target_type = 'marketplace_sample_download'
    AND target_id IS NOT NULL
    AND outcome = 'authorized'
  );

CREATE FUNCTION app.reserve_marketplace_sample_download(
  p_authorization_id uuid,
  p_actor_user_id uuid,
  p_actor_api_key_id uuid,
  p_actor_fingerprint bytea,
  p_idempotency_key text,
  p_request_hash bytea,
  p_template_slug text,
  p_expected_sample_version integer,
  p_format text,
  p_selected_fields jsonb,
  p_projection_fingerprint bytea,
  p_record_limit integer,
  p_record_count integer,
  p_object_key text,
  p_content_type text,
  p_file_name text,
  p_byte_count bigint,
  p_checksum bytea,
  p_rate_limit_max integer,
  p_rate_window_seconds integer
)
RETURNS TABLE (
  disposition text,
  authorization_id uuid,
  stored_state text,
  stored_object_key text,
  stored_content_type text,
  stored_file_name text,
  stored_byte_count bigint,
  stored_checksum bytea,
  stored_record_count integer,
  stored_download_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  tenant uuid := app.current_tenant_id();
  manifest record;
  sample_id uuid;
  existing app.marketplace_sample_download_authorizations%ROWTYPE;
BEGIN
  IF tenant IS NULL
     OR p_authorization_id IS NULL
     OR ((p_actor_user_id IS NOT NULL)::integer + (p_actor_api_key_id IS NOT NULL)::integer) <> 1
     OR p_actor_fingerprint IS NULL OR octet_length(p_actor_fingerprint) <> 32
     OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
     OR p_request_hash IS NULL OR octet_length(p_request_hash) <> 32
     OR p_projection_fingerprint IS NULL OR octet_length(p_projection_fingerprint) <> 32
     OR p_expected_sample_version IS NULL OR p_expected_sample_version < 1
     OR p_format NOT IN ('json', 'csv')
     OR jsonb_typeof(p_selected_fields) <> 'array' OR jsonb_array_length(p_selected_fields) < 1
     OR p_record_limit IS NULL OR p_record_limit NOT BETWEEN 1 AND 100
     OR p_record_count IS NULL OR p_record_count NOT BETWEEN 0 AND p_record_limit
     OR p_byte_count IS NULL OR p_byte_count < 1
     OR p_checksum IS NULL OR octet_length(p_checksum) <> 32
     OR p_rate_limit_max IS NULL OR p_rate_limit_max NOT BETWEEN 1 AND 10000
     OR p_rate_window_seconds IS NULL OR p_rate_window_seconds NOT BETWEEN 60 AND 86400 THEN
    RAISE EXCEPTION 'MARKETPLACE_SAMPLE_DOWNLOAD_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT preview.* INTO manifest
  FROM app.resolve_marketplace_sample_preview(p_template_slug, statement_timestamp()) AS preview
  WHERE preview.sample_version = p_expected_sample_version;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MARKETPLACE_SAMPLE_DOWNLOAD_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- resolve_marketplace_sample_preview exposes the public Service Template ID,
  -- so resolve the immutable version identity explicitly before authorizing
  -- bytes from the private sample object.
  SELECT sample.id INTO sample_id
  FROM app.marketplace_sample_versions AS sample
  JOIN app.service_template_versions AS version
    ON version.id = sample.service_template_version_id
  WHERE version.service_template_id = manifest.template_id
    AND version.version = manifest.template_version
    AND sample.sample_version = manifest.sample_version
    AND sample.object_key = manifest.sample_object_key;

  IF sample_id IS NULL THEN
    RAISE EXCEPTION 'MARKETPLACE_SAMPLE_DOWNLOAD_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text, 0));

  SELECT candidate.* INTO existing
  FROM app.marketplace_sample_download_authorizations AS candidate
  WHERE candidate.tenant_id = tenant
    AND candidate.idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF FOUND THEN
    IF existing.actor_fingerprint <> p_actor_fingerprint
       OR existing.request_hash <> p_request_hash THEN
      RETURN QUERY SELECT 'conflict'::text, existing.id, existing.state,
        existing.object_key, existing.content_type, existing.file_name,
        existing.byte_count, existing.checksum, existing.record_count,
        existing.download_expires_at;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'replay'::text, existing.id, existing.state,
      existing.object_key, existing.content_type, existing.file_name,
      existing.byte_count, existing.checksum, existing.record_count,
      existing.download_expires_at;
    RETURN;
  END IF;

  IF (
    SELECT count(*)
    FROM app.marketplace_sample_download_authorizations AS recent
    WHERE recent.tenant_id = tenant
      AND recent.state IN ('reserved', 'authorized')
      AND recent.created_at >= clock_timestamp() - make_interval(secs => p_rate_window_seconds)
  ) >= p_rate_limit_max THEN
    RAISE EXCEPTION 'MARKETPLACE_SAMPLE_DOWNLOAD_RATE_LIMITED' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO app.marketplace_sample_download_authorizations (
    id, tenant_id, sample_version_id, actor_user_id, actor_api_key_id,
    actor_fingerprint, idempotency_key, request_hash, template_slug,
    template_version, sample_version, format, selected_fields,
    projection_fingerprint, record_limit, record_count, object_key,
    content_type, file_name, byte_count, checksum, state, request_id,
    ip_fingerprint
  ) VALUES (
    p_authorization_id, tenant, sample_id, p_actor_user_id, p_actor_api_key_id,
    p_actor_fingerprint, p_idempotency_key, p_request_hash, p_template_slug,
    manifest.template_version, manifest.sample_version, p_format,
    p_selected_fields, p_projection_fingerprint, p_record_limit,
    p_record_count, p_object_key, p_content_type, p_file_name, p_byte_count,
    p_checksum, 'reserved', NULL, NULL
  );

  RETURN QUERY SELECT 'created'::text, p_authorization_id, 'reserved'::text,
    p_object_key, p_content_type, p_file_name, p_byte_count, p_checksum,
    p_record_count, NULL::timestamptz;
END;
$$;

CREATE FUNCTION app.complete_marketplace_sample_download(
  p_authorization_id uuid,
  p_download_expires_at timestamptz,
  p_request_id uuid,
  p_ip_fingerprint bytea
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  tenant uuid := app.current_tenant_id();
  authorization_row app.marketplace_sample_download_authorizations%ROWTYPE;
BEGIN
  SELECT candidate.* INTO authorization_row
  FROM app.marketplace_sample_download_authorizations AS candidate
  WHERE candidate.tenant_id = tenant AND candidate.id = p_authorization_id
  FOR UPDATE;

  IF NOT FOUND OR authorization_row.state <> 'reserved'
     OR p_download_expires_at IS NULL OR p_download_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'MARKETPLACE_SAMPLE_DOWNLOAD_STALE' USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM app.resolve_marketplace_sample_preview(
      authorization_row.template_slug, statement_timestamp()
    ) AS preview
    WHERE preview.sample_version = authorization_row.sample_version
      AND preview.template_version = authorization_row.template_version
  ) THEN
    RAISE EXCEPTION 'MARKETPLACE_SAMPLE_DOWNLOAD_STALE' USING ERRCODE = '55000';
  END IF;

  UPDATE app.marketplace_sample_download_authorizations
  SET state = 'authorized', authorized_at = clock_timestamp(),
      download_expires_at = p_download_expires_at,
      request_id = p_request_id, ip_fingerprint = p_ip_fingerprint
  WHERE tenant_id = tenant AND id = p_authorization_id;

  INSERT INTO app.audit_events (
    tenant_id, actor_user_id, actor_api_key_id, action, target_type,
    target_id, outcome, request_id, ip_fingerprint, safe_diff
  ) VALUES (
    tenant, authorization_row.actor_user_id, authorization_row.actor_api_key_id,
    'marketplace.sample_download_authorize', 'marketplace_sample_download',
    authorization_row.id, 'authorized', p_request_id, p_ip_fingerprint,
    jsonb_build_object(
      'template_slug', authorization_row.template_slug,
      'template_version', authorization_row.template_version,
      'sample_version', authorization_row.sample_version,
      'format', authorization_row.format,
      'selected_fields', authorization_row.selected_fields,
      'record_limit', authorization_row.record_limit,
      'record_count', authorization_row.record_count,
      'byte_count', authorization_row.byte_count,
      'checksum', encode(authorization_row.checksum, 'hex'),
      'projection_fingerprint', encode(authorization_row.projection_fingerprint, 'hex'),
      'delivery_method', 'signed_object_url',
      'provider_calls', 0
    )
  );
END;
$$;

CREATE FUNCTION app.fail_marketplace_sample_download(p_authorization_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  UPDATE app.marketplace_sample_download_authorizations
  SET state = 'failed', failed_at = clock_timestamp()
  WHERE tenant_id = app.current_tenant_id()
    AND id = p_authorization_id
    AND state = 'reserved';
END;
$$;

REVOKE ALL ON FUNCTION app.reserve_marketplace_sample_download(
  uuid, uuid, uuid, bytea, text, bytea, text, integer, text, jsonb, bytea,
  integer, integer, text, text, text, bigint, bytea, integer, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.complete_marketplace_sample_download(
  uuid, timestamptz, uuid, bytea
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.fail_marketplace_sample_download(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.reserve_marketplace_sample_download(
  uuid, uuid, uuid, bytea, text, bytea, text, integer, text, jsonb, bytea,
  integer, integer, text, text, text, bigint, bytea, integer, integer
) TO dhumi_customer_api;
GRANT EXECUTE ON FUNCTION app.complete_marketplace_sample_download(
  uuid, timestamptz, uuid, bytea
) TO dhumi_customer_api;
GRANT EXECUTE ON FUNCTION app.fail_marketplace_sample_download(uuid)
  TO dhumi_customer_api;

CREATE FUNCTION app.get_platform_status_v2(p_environment text)
RETURNS TABLE (family text, state text, message text, updated_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  evaluated_at timestamptz := statement_timestamp();
BEGIN
  RETURN QUERY
  SELECT
    base.family,
    CASE
      WHEN base.family = 'marketplace_dataset' AND EXISTS (
        SELECT 1 FROM app.resolve_marketplace_sample_preview(NULL, evaluated_at)
      ) THEN 'operational'::text
      ELSE base.state
    END,
    CASE
      WHEN base.family = 'marketplace_dataset' AND EXISTS (
        SELECT 1 FROM app.resolve_marketplace_sample_preview(NULL, evaluated_at)
      ) THEN 'Preview only: governed stored-sample browsing, filtering and bounded download are available; purchase and full export are not enabled.'::text
      ELSE NULL::text
    END,
    base.updated_at
  FROM app.get_platform_status(p_environment) AS base;
END;
$$;

REVOKE ALL ON FUNCTION app.get_platform_status_v2(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.get_platform_status_v2(text) TO dhumi_customer_api;

RESET ROLE;
