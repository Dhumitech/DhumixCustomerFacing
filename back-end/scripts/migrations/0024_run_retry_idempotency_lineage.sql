-- Authorize retry idempotency lineage replay and completion.
--
-- This migration intentionally does not grant table-wide SELECT or UPDATE,
-- alter claim identity, weaken operation-specific CHECK constraints, change
-- Run lineage, modify migrations 0001-0023, or call a provider.

SET ROLE dhumi_owner;

-- Retry is the first Admission operation whose completed claim uses
-- related_resource_id (source Run). Existing operation constraints continue
-- to require NULL where lineage is not part of the operation contract.
GRANT SELECT (related_resource_id)
  ON app.idempotency_records TO dhumi_admission;
GRANT UPDATE (related_resource_id)
  ON app.idempotency_records TO dhumi_admission;

RESET ROLE;
