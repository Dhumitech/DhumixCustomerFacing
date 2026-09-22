-- Cross-cutting integrity constraints for identity, session, Tenant access,
-- and legal-evidence tables left intentionally outside operation-scoped 0007.
--
-- This migration intentionally does not freeze the password-hash format or
-- algorithm, email-verification or lockout timings, Tenant suspension-reason
-- taxonomy, legal-document taxonomy, or retention behavior. It performs no
-- data backfill and changes no grants or row-level-security policies.

SET ROLE dhumi_owner;

-- Authentication material and canonical identities must remain usable, while
-- lifecycle timestamps and lock state must retain coherent security evidence.
ALTER TABLE app.users
  ADD CONSTRAINT users_value_shape_check
  CHECK (
    octet_length(password_hash) > 0
    AND email_normalized = btrim(email_normalized)
    AND length(email_normalized) > 0
  ),
  ADD CONSTRAINT users_time_order_check
  CHECK (
    updated_at >= created_at
    AND (email_verified_at IS NULL OR email_verified_at >= created_at)
  ),
  ADD CONSTRAINT users_lock_state_check
  CHECK (state <> 'locked' OR last_failed_auth_at IS NOT NULL);

-- Session state must agree with its revocation evidence, and session activity
-- cannot predate issuance; user-scoped access must also avoid full-table scans.
ALTER TABLE app.auth_sessions
  ADD CONSTRAINT auth_sessions_revocation_state_check
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
  ADD CONSTRAINT auth_sessions_time_order_check
  CHECK (
    updated_at >= created_at
    AND (last_used_at IS NULL OR last_used_at >= issued_at)
    AND (revoked_at IS NULL OR revoked_at >= issued_at)
  );

CREATE INDEX auth_sessions_by_user_idx
  ON app.auth_sessions (user_id);

-- Canonical workspace names prevent invisible display drift, while suspension
-- metadata must not survive into lifecycle states where it has no meaning.
ALTER TABLE app.tenants
  ADD CONSTRAINT tenants_name_canonical_check
  CHECK (display_name = btrim(display_name)),
  ADD CONSTRAINT tenants_time_order_check
  CHECK (updated_at >= created_at),
  ADD CONSTRAINT tenants_suspension_state_check
  CHECK (
    state = 'suspended'
    OR (
      suspension_reason_code IS NULL
      AND suspension_reference IS NULL
    )
  );

-- Access-row update times are relied on as trustworthy Tenant-membership
-- lifecycle evidence and therefore cannot precede creation.
ALTER TABLE app.tenant_user_access
  ADD CONSTRAINT tenant_user_access_time_order_check
  CHECK (updated_at >= created_at);

-- Legal evidence must identify a real canonical document.
ALTER TABLE app.legal_acceptances
  ADD CONSTRAINT legal_acceptances_value_shape_check
  CHECK (
    octet_length(document_hash) > 0
    AND document_type = btrim(document_type)
    AND length(document_type) > 0
    AND document_version = btrim(document_version)
    AND length(document_version) > 0
  );

RESET ROLE;