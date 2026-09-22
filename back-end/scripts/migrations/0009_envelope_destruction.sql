-- Least-privilege database boundary for the response-envelope janitor.
--
-- This migration intentionally does not create cluster LOGIN/capability roles,
-- define deployment scheduling, alter the ten-minute recovery promise, or
-- grant access to request identity, actor fingerprints or idempotency keys.

DO $preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'dhumi_envelope_janitor'
      AND NOT rolcanlogin
      AND NOT rolsuper
      AND NOT rolcreatedb
      AND NOT rolcreaterole
      AND NOT rolreplication
      AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Required capability role dhumi_envelope_janitor is missing or unsafe';
  END IF;
END
$preflight$;

SET ROLE dhumi_owner;

-- The table owner is already a trusted migration principal. These policies
-- let its protected view transition exactly one envelope state while FORCE
-- ROW LEVEL SECURITY remains enabled on the base table.
GRANT USAGE ON SCHEMA app TO dhumi_envelope_janitor;
CREATE POLICY idempotency_records_envelope_owner_select
  ON app.idempotency_records
  FOR SELECT TO dhumi_owner
  USING (
    scope_kind = 'tenant'
    AND operation_code = 'api_keys.create'
    AND state = 'completed'
    AND response_status = 201
    AND response_envelope_recoverable_until IS NOT NULL
    AND response_envelope_recoverable_until <= clock_timestamp()
    AND (
      (
        response_envelope_ciphertext IS NOT NULL
        AND response_envelope_destroyed_at IS NULL
      )
      OR
      (
        response_envelope_ciphertext IS NULL
        AND response_envelope_key_reference IS NULL
        AND response_envelope_destroyed_at >= response_envelope_recoverable_until
      )
    )
  );

CREATE POLICY idempotency_records_envelope_owner_update
  ON app.idempotency_records
  FOR UPDATE TO dhumi_owner
  USING (
    scope_kind = 'tenant'
    AND operation_code = 'api_keys.create'
    AND state = 'completed'
    AND response_status = 201
    AND response_envelope_ciphertext IS NOT NULL
    AND response_envelope_recoverable_until IS NOT NULL
    AND response_envelope_recoverable_until <= clock_timestamp()
    AND response_envelope_destroyed_at IS NULL
  )
  WITH CHECK (
    scope_kind = 'tenant'
    AND operation_code = 'api_keys.create'
    AND state = 'completed'
    AND response_status = 201
    AND response_envelope_ciphertext IS NULL
    AND response_envelope_key_reference IS NULL
    AND response_envelope_recoverable_until IS NOT NULL
    AND response_envelope_destroyed_at >= response_envelope_recoverable_until
  );

-- PostgreSQL applies a SELECT policy as a new-row visibility check during an
-- UPDATE. A direct janitor table policy therefore cannot both hide destroyed
-- tombstones and transition a live row into that hidden state. The
-- owner-filtered view resolves that conflict: its base-table policy accepts
-- both transition states, while the view exposes only live due envelopes and
-- only the row identifier and four envelope columns needed for destruction.
CREATE VIEW app.due_response_envelopes
WITH (security_barrier = true, security_invoker = false)
AS
SELECT
  id,
  response_envelope_ciphertext,
  response_envelope_key_reference,
  response_envelope_recoverable_until,
  response_envelope_destroyed_at
FROM app.idempotency_records
WHERE scope_kind = 'tenant'
  AND operation_code = 'api_keys.create'
  AND state = 'completed'
  AND response_status = 201
  AND response_envelope_ciphertext IS NOT NULL
  AND response_envelope_recoverable_until IS NOT NULL
  AND response_envelope_recoverable_until <= clock_timestamp()
  AND response_envelope_destroyed_at IS NULL;

REVOKE ALL ON app.due_response_envelopes FROM PUBLIC;
GRANT SELECT (
  id,
  response_envelope_ciphertext,
  response_envelope_recoverable_until
) ON app.due_response_envelopes TO dhumi_envelope_janitor;
GRANT UPDATE (
  response_envelope_ciphertext,
  response_envelope_key_reference,
  response_envelope_destroyed_at
) ON app.due_response_envelopes TO dhumi_envelope_janitor;

-- Claim and destruction are one local transaction. Persisted claim metadata
-- would add a crash gap without protecting any external side effect.
CREATE FUNCTION app.destroy_due_response_envelopes(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, app, pg_temp
AS $function$
DECLARE
  destroyed_count integer;
BEGIN
  IF current_user <> 'dhumi_envelope_janitor' THEN
    RAISE EXCEPTION 'ONLY_ENVELOPE_JANITOR_MAY_DESTROY_ENVELOPES'
      USING ERRCODE = '42501';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'ENVELOPE_JANITOR_LIMIT_OUT_OF_RANGE'
      USING ERRCODE = '22023';
  END IF;

  WITH candidates AS MATERIALIZED (
    SELECT envelope.id
    FROM app.due_response_envelopes AS envelope
    ORDER BY envelope.response_envelope_recoverable_until, envelope.id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE app.due_response_envelopes AS envelope
  SET
    response_envelope_ciphertext = NULL,
    response_envelope_key_reference = NULL,
    response_envelope_destroyed_at = clock_timestamp()
  FROM candidates
  WHERE envelope.id = candidates.id;

  GET DIAGNOSTICS destroyed_count = ROW_COUNT;

  RETURN destroyed_count;
END;
$function$;

REVOKE ALL ON FUNCTION app.destroy_due_response_envelopes(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.destroy_due_response_envelopes(integer)
  TO dhumi_envelope_janitor;

RESET ROLE;
