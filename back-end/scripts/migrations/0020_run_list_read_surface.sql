-- Least-privilege read surface and exact keyset path for GET /v1/runs.
--
-- This migration intentionally does not create or update a Run, expose
-- validated input or internal/provider state, change Run transitions, call
-- Bright Data, seed data, provision a LOGIN role, or modify migrations
-- 0001-0019.

SET ROLE dhumi_owner;

-- A public Run contains the owning Service ID, but the immutable Run pin is a
-- Service-version ID. The customer capability needs only that RLS-protected
-- join key in addition to the already-readable service_id.
GRANT SELECT (id)
  ON app.service_versions TO dhumi_customer_api;

-- Status-filtered pages need the same immutable ID tie-breaker as unfiltered
-- pages so equal creation timestamps remain deterministic without an offset.
CREATE INDEX runs_by_tenant_status_created_id_idx
  ON app.runs (tenant_id, public_status, created_at DESC, id DESC);

RESET ROLE;
