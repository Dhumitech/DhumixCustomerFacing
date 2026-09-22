-- Schema and least-privilege foundation for POST /v1/keys.
--
-- This migration intentionally does not freeze the serialized key format,
-- hash algorithm/length, KMS adapter, tombstone-retention duration, or the
-- envelope-destruction worker role. Those decisions remain launch gates.

SET ROLE dhumi_owner;

-- The public Idempotency-Key contract is shared by every mutating endpoint.
-- Keeping the database weaker (8 characters and no alphabet restriction)
-- allowed non-replayable internal state that no conforming client could send.
ALTER TABLE app.idempotency_records
  DROP CONSTRAINT idempotency_records_idempotency_key_check;

ALTER TABLE app.idempotency_records
  ADD CONSTRAINT idempotency_records_idempotency_key_contract_check
  CHECK (
    length(idempotency_key) BETWEEN 16 AND 128
    AND idempotency_key ~ '^[A-Za-z0-9._:-]+$'
  ),
  ADD CONSTRAINT idempotency_records_value_shape_check
  CHECK (
    octet_length(actor_fingerprint) > 0
    AND octet_length(request_hash) > 0
    AND operation_code = btrim(operation_code)
    AND length(operation_code) > 0
    AND (resource_type IS NULL OR (
      resource_type = btrim(resource_type) AND length(resource_type) > 0
    ))
    AND (response_body_reference IS NULL OR (
      response_body_reference = btrim(response_body_reference)
      AND length(response_body_reference) > 0
    ))
    AND (response_status IS NULL OR response_status BETWEEN 100 AND 599)
  ),
  ADD CONSTRAINT idempotency_records_time_order_check
  CHECK (
    expires_at > created_at
    AND updated_at >= created_at
    AND (completed_at IS NULL OR completed_at >= created_at)
  ),
  ADD CONSTRAINT idempotency_response_envelope_semantics_check
  CHECK (
    response_envelope_recoverable_until IS NULL
    OR (
      scope_kind = 'tenant'
      AND state = 'completed'
      AND response_status = 201
      AND completed_at IS NOT NULL
      AND response_envelope_recoverable_until > completed_at
      AND response_envelope_recoverable_until <= expires_at
      AND (
        (
          response_envelope_ciphertext IS NOT NULL
          AND octet_length(response_envelope_ciphertext) > 0
          AND response_envelope_key_reference IS NOT NULL
          AND response_envelope_key_reference = btrim(response_envelope_key_reference)
          AND length(response_envelope_key_reference) > 0
          AND response_envelope_destroyed_at IS NULL
        )
        OR
        (
          response_envelope_ciphertext IS NULL
          AND response_envelope_key_reference IS NULL
          AND response_envelope_destroyed_at
            >= response_envelope_recoverable_until
        )
      )
    )
  ),
  ADD CONSTRAINT idempotency_records_tenant_id_id_key
  UNIQUE (tenant_id, id);

-- The future destruction worker needs a bounded indexable due-envelope scan.
-- Its execution role and scheduling model are intentionally not granted here.
CREATE INDEX idempotency_records_live_envelope_deadline_idx
  ON app.idempotency_records (response_envelope_recoverable_until, id)
  WHERE response_envelope_ciphertext IS NOT NULL;

-- The input contract treats scopes as a non-empty set. The original array
-- check enforced the allowlist but admitted duplicates. Because the Demo
-- allowlist is closed, the number of present allowlisted values must equal the
-- number of stored array elements.
ALTER TABLE app.platform_api_keys
  ADD CONSTRAINT platform_api_keys_name_canonical_check
  CHECK (name = btrim(name)),
  ADD CONSTRAINT platform_api_keys_material_nonempty_check
  CHECK (
    key_prefix = btrim(key_prefix)
    AND length(key_prefix) > 0
    AND octet_length(key_hash) > 0
  ),
  ADD CONSTRAINT platform_api_keys_scopes_unique_check
  CHECK (
    array_ndims(scopes) = 1
    AND array_lower(scopes, 1) = 1
    AND cardinality(scopes) =
      (CASE WHEN scopes @> ARRAY['catalog:read']::text[] THEN 1 ELSE 0 END) +
      (CASE WHEN scopes @> ARRAY['services:read']::text[] THEN 1 ELSE 0 END) +
      (CASE WHEN scopes @> ARRAY['services:write']::text[] THEN 1 ELSE 0 END) +
      (CASE WHEN scopes @> ARRAY['runs:read']::text[] THEN 1 ELSE 0 END) +
      (CASE WHEN scopes @> ARRAY['runs:write']::text[] THEN 1 ELSE 0 END) +
      (CASE WHEN scopes @> ARRAY['results:read']::text[] THEN 1 ELSE 0 END) +
      (CASE WHEN scopes @> ARRAY['usage:read']::text[] THEN 1 ELSE 0 END)
  ),
  ADD CONSTRAINT platform_api_keys_time_order_check
  CHECK (
    updated_at >= created_at
    AND (last_used_at IS NULL OR last_used_at >= created_at)
    AND (expires_at IS NULL OR expires_at > created_at)
    AND (revoked_at IS NULL OR revoked_at >= created_at)
  ),
  ADD CONSTRAINT platform_api_keys_revocation_state_check
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
  ADD CONSTRAINT platform_api_keys_tenant_id_id_key
  UNIQUE (tenant_id, id);

-- Audit fields must remain useful evidence rather than empty labels or an
-- arbitrary JSON scalar. The existing immutable trigger remains authoritative.
ALTER TABLE app.audit_events
  ADD CONSTRAINT audit_events_value_shape_check
  CHECK (
    action = btrim(action) AND length(action) > 0
    AND target_type = btrim(target_type) AND length(target_type) > 0
    AND outcome = btrim(outcome) AND length(outcome) > 0
    AND (reason IS NULL OR (reason = btrim(reason) AND length(reason) > 0))
    AND jsonb_typeof(safe_diff) = 'object'
  ),
  ADD CONSTRAINT audit_events_tenant_id_id_key
  UNIQUE (tenant_id, id);

-- Creation/list/replay requires these exact Customer API capabilities. UPDATE
-- remains column-scoped so claim identity and request hashes cannot be rewritten.
GRANT SELECT, INSERT ON app.platform_api_keys TO dhumi_customer_api;
GRANT SELECT, INSERT ON app.idempotency_records TO dhumi_customer_api;
GRANT UPDATE (
  state,
  response_status,
  resource_type,
  resource_id,
  related_resource_id,
  response_body_reference,
  response_envelope_ciphertext,
  response_envelope_key_reference,
  response_envelope_recoverable_until,
  response_envelope_destroyed_at,
  completed_at,
  updated_at
) ON app.idempotency_records TO dhumi_customer_api;
GRANT INSERT ON app.audit_events TO dhumi_customer_api;

CREATE POLICY audit_events_customer_insert ON app.audit_events
  FOR INSERT TO dhumi_customer_api
  WITH CHECK (tenant_id = app.current_tenant_id());

RESET ROLE;
