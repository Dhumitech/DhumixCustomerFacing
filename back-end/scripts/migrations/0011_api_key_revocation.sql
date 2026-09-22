-- Least-privilege write surface for DELETE /v1/keys/{key_id}.
--
-- This migration intentionally does not add a lifecycle state, change Tenant
-- row-level security, define cache-consumer delivery, grant verifier access,
-- or modify any prior API-key creation/list behavior.

SET ROLE dhumi_owner;

-- Revocation changes only authoritative lifecycle state. The existing trigger
-- derives updated_at, so the runtime role cannot write any other key metadata.
GRANT UPDATE (state, revoked_at)
  ON app.platform_api_keys TO dhumi_customer_api;

-- The request transaction records durable invalidation intent but cannot read,
-- claim, publish, retry or otherwise administer global outbox records.
GRANT INSERT (
  aggregate_type,
  aggregate_id,
  tenant_id,
  topic,
  ordering_key,
  payload
) ON app.outbox_events TO dhumi_customer_api;

RESET ROLE;
