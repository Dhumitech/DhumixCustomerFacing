-- Integrity, replay and least-privilege foundation for POST /v1/services.
--
-- This migration intentionally does not create or publish catalogue content,
-- backfill a Service, call Bright Data, expose provider resources, provision a
-- runtime LOGIN role, or modify migrations 0001-0015.

SET ROLE dhumi_owner;

-- The database must enforce the public name contract without silently
-- rewriting the exact customer-supplied value used by idempotency.
ALTER TABLE app.services
  DROP CONSTRAINT services_name_check,
  ADD CONSTRAINT services_name_check
  CHECK (
    char_length(name) BETWEEN 1 AND 120
    AND name ~ '[^[:space:]]'
  );

-- A saved version is valid only when it contains an object validated against
-- one exact schema digest and attributes one same-Tenant customer actor.
ALTER TABLE app.service_versions
  ADD COLUMN created_by_api_key_id uuid,
  ADD CONSTRAINT service_versions_configuration_object_check
  CHECK (jsonb_typeof(validated_configuration) = 'object'),
  ADD CONSTRAINT service_versions_schema_hash_length_check
  CHECK (octet_length(schema_hash) = 32),
  ADD CONSTRAINT service_versions_creator_user_tenant_fk
  FOREIGN KEY (tenant_id, created_by_user_id)
  REFERENCES app.tenant_user_access (tenant_id, user_id)
  ON DELETE RESTRICT,
  ADD CONSTRAINT service_versions_creator_api_key_tenant_fk
  FOREIGN KEY (tenant_id, created_by_api_key_id)
  REFERENCES app.platform_api_keys (tenant_id, id)
  ON DELETE RESTRICT,
  ADD CONSTRAINT service_versions_exactly_one_creator_check
  CHECK (
    (created_by_user_id IS NOT NULL AND created_by_api_key_id IS NULL)
    OR
    (created_by_user_id IS NULL AND created_by_api_key_id IS NOT NULL)
  );

-- Audit rows may be system-authored, but customer-authored evidence must never
-- identify two actors or an actor belonging to another Tenant.
ALTER TABLE app.audit_events
  ADD COLUMN actor_api_key_id uuid,
  ADD CONSTRAINT audit_events_actor_user_tenant_fk
  FOREIGN KEY (tenant_id, actor_user_id)
  REFERENCES app.tenant_user_access (tenant_id, user_id)
  ON DELETE RESTRICT,
  ADD CONSTRAINT audit_events_actor_api_key_tenant_fk
  FOREIGN KEY (tenant_id, actor_api_key_id)
  REFERENCES app.platform_api_keys (tenant_id, id)
  ON DELETE RESTRICT,
  ADD CONSTRAINT audit_events_at_most_one_actor_check
  CHECK (actor_user_id IS NULL OR actor_api_key_id IS NULL);

-- Service creation needs an immutable, non-secret replay body. API-key
-- creation keeps its encrypted envelope and every other operation remains
-- unaffected by these operation-specific completion rules.
ALTER TABLE app.idempotency_records
  ADD COLUMN response_body jsonb,
  ADD CONSTRAINT idempotency_records_response_body_object_check
  CHECK (response_body IS NULL OR jsonb_typeof(response_body) = 'object'),
  ADD CONSTRAINT idempotency_records_service_create_semantics_check
  CHECK (
    operation_code <> 'services.create'
    OR
    (
      scope_kind = 'tenant'
      AND
      (
        (
          state = 'in_progress'
          AND response_status IS NULL
          AND resource_type IS NULL
          AND resource_id IS NULL
          AND related_resource_id IS NULL
          AND response_body_reference IS NULL
          AND response_body IS NULL
          AND response_envelope_ciphertext IS NULL
          AND response_envelope_key_reference IS NULL
          AND response_envelope_recoverable_until IS NULL
          AND response_envelope_destroyed_at IS NULL
          AND completed_at IS NULL
        )
        OR
        (
          state = 'completed'
          AND response_status = 201
          AND resource_type = 'service'
          AND resource_id IS NOT NULL
          AND related_resource_id IS NULL
          AND response_body_reference = 'inline_json_v1'
          AND response_body IS NOT NULL
          AND response_body ? 'id'
          AND response_body ->> 'id' = resource_id::text
          AND response_envelope_ciphertext IS NULL
          AND response_envelope_key_reference IS NULL
          AND response_envelope_recoverable_until IS NULL
          AND response_envelope_destroyed_at IS NULL
          AND completed_at IS NOT NULL
        )
      )
    )
  );

-- Admission reads only readiness and linkage metadata. Provider credentials,
-- resource ciphertext/fingerprints and private adapter schemas stay denied.
REVOKE SELECT ON app.adapter_versions FROM dhumi_admission;
REVOKE SELECT ON app.provider_mappings FROM dhumi_admission;
REVOKE SELECT ON app.launch_evidence FROM dhumi_admission;

GRANT SELECT (id, state) ON app.adapter_versions TO dhumi_admission;
GRANT SELECT (
  id,
  service_template_version_id,
  adapter_version_id,
  environment,
  launch_evidence_id,
  state
) ON app.provider_mappings TO dhumi_admission;
GRANT SELECT (id, state, effective_at, expires_at)
  ON app.launch_evidence TO dhumi_admission;

-- Claim identity is readable only by the admission module that owns this
-- operation. Completion updates cannot rewrite Tenant, key, actor or request.
REVOKE SELECT ON app.idempotency_records FROM dhumi_admission;
REVOKE INSERT ON app.idempotency_records FROM dhumi_admission;
REVOKE UPDATE ON app.idempotency_records FROM dhumi_admission;

GRANT INSERT (
  id,
  tenant_id,
  scope_kind,
  actor_fingerprint,
  operation_code,
  idempotency_key,
  request_hash,
  state,
  expires_at
) ON app.idempotency_records TO dhumi_admission;

GRANT SELECT (
  id,
  tenant_id,
  actor_fingerprint,
  operation_code,
  idempotency_key,
  request_hash,
  state,
  response_status,
  resource_type,
  resource_id,
  response_body_reference,
  response_body,
  expires_at,
  completed_at
) ON app.idempotency_records TO dhumi_admission;

GRANT UPDATE (
  state,
  response_status,
  resource_type,
  resource_id,
  response_body_reference,
  response_body,
  completed_at,
  updated_at
) ON app.idempotency_records TO dhumi_admission;

-- Column-scoped insert capabilities keep optional future fields outside the
-- customer admission surface while forced RLS remains authoritative.
REVOKE INSERT ON app.services FROM dhumi_admission;
REVOKE INSERT ON app.service_versions FROM dhumi_admission;
REVOKE INSERT ON app.audit_events FROM dhumi_admission;

GRANT INSERT (
  id,
  tenant_id,
  service_template_id,
  name,
  state,
  current_version
) ON app.services TO dhumi_admission;

GRANT INSERT (
  id,
  tenant_id,
  service_id,
  version,
  service_template_version_id,
  validated_configuration,
  schema_hash,
  created_by_user_id,
  created_by_api_key_id
) ON app.service_versions TO dhumi_admission;

GRANT INSERT (
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
) ON app.audit_events TO dhumi_admission;

RESET ROLE;
