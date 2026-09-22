-- Privileged, rollback-only proof for GET /v1/runs/{run_id}/events.
-- Reuses the non-persistent Run-list fixture and applies migration 0025 only
-- inside its transaction so the proof cannot change database state.
\set ON_ERROR_STOP on
\set run_event_list_proof true
\ir 0012_run_list_read_surface.sql
