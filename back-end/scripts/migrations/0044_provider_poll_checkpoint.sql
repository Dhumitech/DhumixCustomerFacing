-- Durable provider read budget on the original submission Attempt. No provider
-- call, public route, Template change or new database identity.
SET ROLE dhumi_owner;

ALTER TABLE app.run_attempts
  ADD COLUMN provider_poll_deadline timestamptz,
  ADD COLUMN provider_next_poll_at timestamptz,
  ADD COLUMN provider_last_status text,
  ADD COLUMN provider_consecutive_failures integer NOT NULL DEFAULT 0
    CHECK (provider_consecutive_failures >= 0);

CREATE FUNCTION app.checkpoint_provider_poll_fenced(
  p_run_id uuid, p_attempt_id uuid, p_fence_token uuid, p_source_attempt_id uuid,
  p_max_elapsed_ms integer, p_status text DEFAULT NULL,
  p_failure boolean DEFAULT NULL, p_delay_ms bigint DEFAULT 0
)
RETURNS TABLE (remaining_ms bigint, wait_ms bigint, consecutive_failures integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  tenant uuid := app.require_tenant_context();
  owner_attempt app.run_attempts%ROWTYPE;
  source_attempt app.run_attempts%ROWTYPE;
  observed_at timestamptz := clock_timestamp();
BEGIN
  IF p_max_elapsed_ms IS NULL OR p_delay_ms IS NULL
    OR p_max_elapsed_ms NOT BETWEEN 1 AND 86400000 OR p_delay_ms < 0
    OR p_delay_ms > 9007199254740991
    OR (p_status IS NOT NULL AND p_status NOT IN (
      'starting', 'running', 'ready', 'failed', 'canceled',
      'not_ready', 'missing', 'unknown', 'read_failed', 'rate_limited'
    )) THEN
    RAISE EXCEPTION 'PROVIDER_POLL_CHECKPOINT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM app.runs WHERE id = p_run_id AND tenant_id = tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RUN_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO owner_attempt FROM app.run_attempts
    WHERE id = p_attempt_id AND tenant_id = tenant AND run_id = p_run_id FOR UPDATE;
  IF NOT FOUND OR owner_attempt.state <> 'claimed'
    OR p_fence_token IS NULL OR owner_attempt.fence_token <> p_fence_token
    OR owner_attempt.worker_lease_expires_at IS NULL
    OR owner_attempt.worker_lease_expires_at <= clock_timestamp()
    OR owner_attempt.kind NOT IN ('submission', 'reconciliation') THEN
    RAISE EXCEPTION 'RUN_ATTEMPT_FENCE_REJECTED' USING ERRCODE = '40001';
  END IF;
  SELECT * INTO source_attempt FROM app.run_attempts
    WHERE id = p_source_attempt_id AND tenant_id = tenant AND run_id = p_run_id
      AND kind = 'submission' FOR UPDATE;
  IF NOT FOUND OR source_attempt.provider_reference_ciphertext IS NULL
    OR source_attempt.provider_reference_fingerprint IS NULL
    OR (owner_attempt.kind = 'submission' AND source_attempt.id <> owner_attempt.id)
    OR (owner_attempt.kind = 'reconciliation' AND source_attempt.state <> 'ambiguous') THEN
    RAISE EXCEPTION 'PROVIDER_POLL_SOURCE_REJECTED' USING ERRCODE = '40001';
  END IF;
  UPDATE app.run_attempts AS source SET
    provider_poll_deadline = COALESCE(source.provider_poll_deadline,
      source.started_at + p_max_elapsed_ms * interval '1 millisecond'),
    provider_last_status = COALESCE(p_status, source.provider_last_status),
    provider_consecutive_failures = CASE
      WHEN p_failure IS TRUE THEN LEAST(source.provider_consecutive_failures + 1, 1000000)
      WHEN p_failure IS FALSE THEN 0 ELSE source.provider_consecutive_failures END,
    provider_next_poll_at = CASE WHEN p_status IS NULL THEN source.provider_next_poll_at
      ELSE observed_at + LEAST(p_delay_ms, 86400000) * interval '1 millisecond' END,
    updated_at = observed_at
    WHERE source.id = p_source_attempt_id AND source.tenant_id = tenant
    RETURNING * INTO source_attempt;
  RETURN QUERY SELECT
    floor(extract(epoch FROM (source_attempt.provider_poll_deadline - clock_timestamp())) * 1000)::bigint,
    GREATEST(0, ceil(extract(epoch FROM (COALESCE(source_attempt.provider_next_poll_at, observed_at) - clock_timestamp())) * 1000)::bigint),
    source_attempt.provider_consecutive_failures;
END;
$$;
REVOKE ALL ON FUNCTION app.checkpoint_provider_poll_fenced(uuid, uuid, uuid, uuid, integer, text, boolean, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.checkpoint_provider_poll_fenced(uuid, uuid, uuid, uuid, integer, text, boolean, bigint) TO dhumi_job_manager;
RESET ROLE;
