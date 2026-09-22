-- Permit the Customer API revocation transaction to publish schema v2 events.
--
-- This migration intentionally does not change outbox discovery or delivery,
-- add a cache, authorize from cache state, alter RLS, or modify earlier events.

SET ROLE dhumi_owner;

-- Revocation owns the durable invalidation signal and must identify its
-- payload contract explicitly; every other outbox administration field stays
-- outside the Customer API capability.
GRANT INSERT (schema_version)
  ON app.outbox_events TO dhumi_customer_api;

RESET ROLE;
