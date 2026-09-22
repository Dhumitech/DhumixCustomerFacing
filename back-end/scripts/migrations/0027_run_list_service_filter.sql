-- Query support for GET /v1/runs?service_id=... without changing Run state.
--
-- This migration does not expose validated input, provider identifiers or
-- internal lifecycle fields, and does not modify migrations 0001-0026.

SET ROLE dhumi_owner;

CREATE INDEX service_versions_by_tenant_service_id_id_idx
  ON app.service_versions (tenant_id, service_id, id);

CREATE INDEX runs_by_tenant_service_version_created_id_idx
  ON app.runs (tenant_id, service_version_id, created_at DESC, id DESC);

RESET ROLE;

