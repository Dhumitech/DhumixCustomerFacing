-- M6: tenant-scoped Marketplace data-expert enquiries.
--
-- This migration records an authenticated commercial enquiry against the
-- exact Marketplace preview Template version. It intentionally creates no
-- payment, entitlement, Service, Run, Attempt, outbox event, usage event or
-- provider request. Purchase and full export remain fail-closed.

SET ROLE dhumi_owner;

CREATE TABLE app.marketplace_expert_enquiries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  service_template_version_id uuid NOT NULL
    REFERENCES app.service_template_versions(id) ON DELETE RESTRICT,
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
  state text NOT NULL DEFAULT 'received'
    CHECK (state IN ('received', 'in_review', 'contacted', 'closed')),
  request_id uuid,
  ip_fingerprint bytea CHECK (ip_fingerprint IS NULL OR octet_length(ip_fingerprint) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  contacted_at timestamptz,
  closed_at timestamptz,
  CONSTRAINT marketplace_expert_enquiry_actor_check CHECK (
    (actor_user_id IS NOT NULL)::integer +
    (actor_api_key_id IS NOT NULL)::integer = 1
  ),
  CONSTRAINT marketplace_expert_enquiry_actor_user_tenant_fk
    FOREIGN KEY (tenant_id, actor_user_id)
    REFERENCES app.tenant_user_access (tenant_id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT marketplace_expert_enquiry_actor_api_key_tenant_fk
    FOREIGN KEY (tenant_id, actor_api_key_id)
    REFERENCES app.platform_api_keys (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT marketplace_expert_enquiry_state_timestamps_check CHECK (
    (state IN ('received', 'in_review') AND contacted_at IS NULL AND closed_at IS NULL)
    OR (state = 'contacted' AND contacted_at IS NOT NULL AND closed_at IS NULL)
    OR (state = 'closed' AND closed_at IS NOT NULL)
  ),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE UNIQUE INDEX marketplace_expert_enquiry_one_open_per_template_idx
  ON app.marketplace_expert_enquiries (tenant_id, service_template_version_id)
  WHERE state IN ('received', 'in_review', 'contacted');

CREATE INDEX marketplace_expert_enquiry_tenant_created_idx
  ON app.marketplace_expert_enquiries (tenant_id, created_at DESC);

CREATE TRIGGER marketplace_expert_enquiries_touch_updated_at
  BEFORE UPDATE ON app.marketplace_expert_enquiries
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE app.marketplace_expert_enquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.marketplace_expert_enquiries FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.marketplace_expert_enquiries FROM PUBLIC;

CREATE POLICY marketplace_expert_enquiry_owner_access
  ON app.marketplace_expert_enquiries
  FOR ALL TO dhumi_owner
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY audit_events_marketplace_expert_enquiry_definer_insert
  ON app.audit_events
  FOR INSERT TO dhumi_owner
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND action = 'marketplace.expert_enquiry.create'
    AND target_type = 'marketplace_expert_enquiry'
    AND target_id IS NOT NULL
    AND outcome = 'received'
  );

CREATE POLICY audit_events_marketplace_expert_enquiry_transition_definer_insert
  ON app.audit_events
  FOR INSERT TO dhumi_owner
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND action = 'marketplace.expert_enquiry.transition'
    AND target_type = 'marketplace_expert_enquiry'
    AND target_id IS NOT NULL
    AND outcome IN ('in_review', 'contacted', 'closed')
  );

CREATE FUNCTION app.create_marketplace_expert_enquiry(
  p_enquiry_id uuid,
  p_actor_user_id uuid,
  p_actor_api_key_id uuid,
  p_actor_fingerprint bytea,
  p_idempotency_key text,
  p_request_hash bytea,
  p_template_slug text,
  p_expected_template_version integer,
  p_request_id uuid,
  p_ip_fingerprint bytea
)
RETURNS TABLE (
  disposition text,
  enquiry_id uuid,
  template_slug text,
  template_version integer,
  enquiry_state text,
  submitted_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  tenant uuid := app.current_tenant_id();
  preview record;
  resolved_template_version_id uuid;
  existing app.marketplace_expert_enquiries%ROWTYPE;
BEGIN
  IF tenant IS NULL
     OR p_enquiry_id IS NULL
     OR ((p_actor_user_id IS NOT NULL)::integer +
         (p_actor_api_key_id IS NOT NULL)::integer) <> 1
     OR p_actor_fingerprint IS NULL OR octet_length(p_actor_fingerprint) <> 32
     OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
     OR p_request_hash IS NULL OR octet_length(p_request_hash) <> 32
     OR p_template_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
     OR p_expected_template_version IS NULL OR p_expected_template_version < 1
     OR (p_ip_fingerprint IS NOT NULL AND octet_length(p_ip_fingerprint) <> 32) THEN
    RAISE EXCEPTION 'MARKETPLACE_EXPERT_ENQUIRY_INPUT_INVALID'
      USING ERRCODE = '22023';
  END IF;

  SELECT candidate.* INTO preview
  FROM app.resolve_marketplace_sample_preview(
    p_template_slug,
    statement_timestamp()
  ) AS candidate;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MARKETPLACE_EXPERT_ENQUIRY_NOT_FOUND'
      USING ERRCODE = 'P0002';
  END IF;

  IF preview.template_version <> p_expected_template_version THEN
    RAISE EXCEPTION 'MARKETPLACE_EXPERT_ENQUIRY_STALE'
      USING ERRCODE = '55000';
  END IF;

  SELECT version.id INTO resolved_template_version_id
  FROM app.service_template_versions AS version
  WHERE version.service_template_id = preview.template_id
    AND version.version = preview.template_version;

  IF resolved_template_version_id IS NULL THEN
    RAISE EXCEPTION 'MARKETPLACE_EXPERT_ENQUIRY_NOT_FOUND'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text, 0));

  SELECT candidate.* INTO existing
  FROM app.marketplace_expert_enquiries AS candidate
  WHERE candidate.tenant_id = tenant
    AND candidate.idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF FOUND THEN
    IF existing.actor_fingerprint <> p_actor_fingerprint
       OR existing.request_hash <> p_request_hash THEN
      RETURN QUERY SELECT
        'conflict'::text,
        existing.id,
        existing.template_slug,
        existing.template_version,
        existing.state,
        existing.created_at;
      RETURN;
    END IF;

    RETURN QUERY SELECT
      'replay'::text,
      existing.id,
      existing.template_slug,
      existing.template_version,
      existing.state,
      existing.created_at;
    RETURN;
  END IF;

  SELECT candidate.* INTO existing
  FROM app.marketplace_expert_enquiries AS candidate
  WHERE candidate.tenant_id = tenant
    AND candidate.service_template_version_id = resolved_template_version_id
    AND candidate.state IN ('received', 'in_review', 'contacted')
  FOR UPDATE;

  IF FOUND THEN
    RETURN QUERY SELECT
      'existing'::text,
      existing.id,
      existing.template_slug,
      existing.template_version,
      existing.state,
      existing.created_at;
    RETURN;
  END IF;

  INSERT INTO app.marketplace_expert_enquiries (
    id,
    tenant_id,
    service_template_version_id,
    actor_user_id,
    actor_api_key_id,
    actor_fingerprint,
    idempotency_key,
    request_hash,
    template_slug,
    template_version,
    state,
    request_id,
    ip_fingerprint
  ) VALUES (
    p_enquiry_id,
    tenant,
    resolved_template_version_id,
    p_actor_user_id,
    p_actor_api_key_id,
    p_actor_fingerprint,
    p_idempotency_key,
    p_request_hash,
    p_template_slug,
    preview.template_version,
    'received',
    p_request_id,
    p_ip_fingerprint
  )
  RETURNING * INTO existing;

  INSERT INTO app.audit_events (
    tenant_id,
    actor_user_id,
    actor_api_key_id,
    action,
    target_type,
    target_id,
    outcome,
    request_id,
    ip_fingerprint,
    safe_diff
  ) VALUES (
    tenant,
    p_actor_user_id,
    p_actor_api_key_id,
    'marketplace.expert_enquiry.create',
    'marketplace_expert_enquiry',
    p_enquiry_id,
    'received',
    p_request_id,
    p_ip_fingerprint,
    jsonb_build_object(
      'template_slug', p_template_slug,
      'template_version', preview.template_version,
      'provider_calls', 0,
      'payment_created', false,
      'entitlement_created', false,
      'service_created', false,
      'run_created', false,
      'outbox_event_created', false
    )
  );

  RETURN QUERY SELECT
    'created'::text,
    existing.id,
    existing.template_slug,
    existing.template_version,
    existing.state,
    existing.created_at;
END;
$$;

REVOKE ALL ON FUNCTION app.create_marketplace_expert_enquiry(
  uuid, uuid, uuid, bytea, text, bytea, text, integer, uuid, bytea
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.create_marketplace_expert_enquiry(
  uuid, uuid, uuid, bytea, text, bytea, text, integer, uuid, bytea
) TO dhumi_customer_api;

-- Internal lifecycle transition. No public route is exposed. The privileged
-- operator must establish app.tenant_id transaction-locally before calling it.
CREATE FUNCTION app.transition_marketplace_expert_enquiry(
  p_enquiry_id uuid,
  p_expected_state text,
  p_target_state text,
  p_actor text
)
RETURNS TABLE (
  enquiry_id uuid,
  enquiry_state text,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  tenant uuid := app.current_tenant_id();
  current_enquiry app.marketplace_expert_enquiries%ROWTYPE;
BEGIN
  IF tenant IS NULL
     OR p_enquiry_id IS NULL
     OR p_expected_state NOT IN ('received', 'in_review', 'contacted')
     OR p_target_state NOT IN ('in_review', 'contacted', 'closed')
     OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9_.@:-]{2,127}$' THEN
    RAISE EXCEPTION 'MARKETPLACE_EXPERT_ENQUIRY_TRANSITION_INPUT_INVALID'
      USING ERRCODE = '22023';
  END IF;

  IF NOT (
    (p_expected_state = 'received' AND p_target_state = 'in_review')
    OR (p_expected_state = 'in_review' AND p_target_state = 'contacted')
    OR (p_expected_state = 'contacted' AND p_target_state = 'closed')
  ) THEN
    RAISE EXCEPTION 'MARKETPLACE_EXPERT_ENQUIRY_TRANSITION_INVALID'
      USING ERRCODE = '55000';
  END IF;

  SELECT candidate.* INTO current_enquiry
  FROM app.marketplace_expert_enquiries AS candidate
  WHERE candidate.tenant_id = tenant
    AND candidate.id = p_enquiry_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MARKETPLACE_EXPERT_ENQUIRY_NOT_FOUND'
      USING ERRCODE = 'P0002';
  END IF;

  IF current_enquiry.state <> p_expected_state THEN
    RAISE EXCEPTION 'MARKETPLACE_EXPERT_ENQUIRY_TRANSITION_CONFLICT'
      USING ERRCODE = '55000';
  END IF;

  UPDATE app.marketplace_expert_enquiries AS enquiry
  SET state = p_target_state,
      contacted_at = CASE
        WHEN p_target_state = 'contacted' THEN clock_timestamp()
        ELSE enquiry.contacted_at
      END,
      closed_at = CASE
        WHEN p_target_state = 'closed' THEN clock_timestamp()
        ELSE enquiry.closed_at
      END
  WHERE enquiry.tenant_id = tenant
    AND enquiry.id = p_enquiry_id
  RETURNING enquiry.* INTO current_enquiry;

  INSERT INTO app.audit_events (
    tenant_id,
    action,
    target_type,
    target_id,
    outcome,
    safe_diff
  ) VALUES (
    tenant,
    'marketplace.expert_enquiry.transition',
    'marketplace_expert_enquiry',
    p_enquiry_id,
    p_target_state,
    jsonb_build_object(
      'actor', p_actor,
      'from', p_expected_state,
      'to', p_target_state,
      'provider_calls', 0
    )
  );

  RETURN QUERY SELECT
    current_enquiry.id,
    current_enquiry.state,
    current_enquiry.updated_at;
END;
$$;

REVOKE ALL ON FUNCTION app.transition_marketplace_expert_enquiry(
  uuid, text, text, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.transition_marketplace_expert_enquiry(
  uuid, text, text, text
) TO dhumi_operator;

RESET ROLE;
