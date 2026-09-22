-- Privileged, rollback-only proof for GET /v1/runs/{run_id}.
-- Reuses the non-persistent Run-list fixture so detail and list prove the same
-- immutable Service-version pin and Tenant RLS boundary.
\set ON_ERROR_STOP on
\set run_detail_proof true
\ir 0012_run_list_read_surface.sql
