-- Least-privilege customer read surface for GET /v1/runs/{run_id}/events.
--
-- This migration intentionally does not create, update, delete, or backfill a
-- Run event; freeze internal event vocabulary; change event writers, RLS,
-- indexes, or transition functions; call Bright Data; provision a LOGIN role;
-- or modify migrations 0001-0024.

SET ROLE dhumi_owner;

-- Customer Run history needs ordering and public projection inputs, not
-- internal source, Attempt, idempotency, payload, evidence, or recording data.
REVOKE SELECT ON app.run_events FROM dhumi_customer_api;
REVOKE SELECT (
  id,
  tenant_id,
  run_id,
  sequence,
  event_type,
  source,
  attempt_id,
  event_idempotency_key,
  safe_payload,
  evidence_reference,
  occurred_at,
  recorded_at
) ON app.run_events FROM dhumi_customer_api;

GRANT SELECT (
  id,
  tenant_id,
  run_id,
  sequence,
  event_type,
  occurred_at
) ON app.run_events TO dhumi_customer_api;

RESET ROLE;
