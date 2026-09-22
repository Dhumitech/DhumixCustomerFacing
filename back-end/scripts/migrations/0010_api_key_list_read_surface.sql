-- Stable pagination and least-privilege read surface for GET /v1/keys.
--
-- This migration intentionally does not freeze a customer-visible sort option,
-- add lifecycle-state transitions, change row-level-security policy, or grant
-- access to verifier hashes, creator identity, idempotency, or envelope data.

SET ROLE dhumi_owner;

-- List cursors use immutable creation time plus the primary key, so key state
-- and last-use changes cannot move rows between pages.
CREATE INDEX platform_api_keys_by_tenant_created_id_idx
  ON app.platform_api_keys (tenant_id, created_at DESC, id DESC);

-- Customer API code needs to create credentials and list their safe metadata,
-- but it must never be able to read the verifier hash or creator identity.
REVOKE SELECT ON app.platform_api_keys FROM dhumi_customer_api;
GRANT SELECT (
  id,
  tenant_id,
  name,
  key_prefix,
  scopes,
  state,
  created_at,
  last_used_at,
  expires_at,
  revoked_at
) ON app.platform_api_keys TO dhumi_customer_api;

RESET ROLE;
