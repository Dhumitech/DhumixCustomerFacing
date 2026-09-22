\set ON_ERROR_STOP on

\echo 'Run'
SELECT
  id,
  tenant_id,
  public_status,
  internal_status,
  state_version,
  retryable,
  accepted_at,
  started_at,
  completed_at
FROM app.runs
WHERE id = :'run_id'::uuid;

\echo 'Attempts'
SELECT
  id,
  attempt_number,
  kind,
  state,
  outcome_class,
  worker_lease_expires_at,
  started_at,
  finished_at
FROM app.run_attempts
WHERE run_id = :'run_id'::uuid
ORDER BY attempt_number, kind;

\echo 'Safe lifecycle events'
SELECT sequence, event_type, source, occurred_at
FROM app.run_events
WHERE run_id = :'run_id'::uuid
ORDER BY sequence;

\echo 'Durable outbox evidence'
SELECT topic, published_at, delivery_attempts, last_safe_error_code
FROM app.outbox_events
WHERE aggregate_type = 'run'
  AND aggregate_id = :'run_id'::uuid
ORDER BY created_at;

\echo 'Run admission actor trace'
SELECT
  tenant_id,
  actor_user_id,
  actor_api_key_id,
  action,
  outcome,
  request_id,
  occurred_at
FROM app.audit_events
WHERE target_type = 'run'
  AND target_id = :'run_id'::uuid
  AND action = 'run.create'
ORDER BY occurred_at;

\echo 'Artifact metadata (bytes stay in Azurite)'
SELECT
  id,
  kind,
  artifact_version,
  state,
  content_type,
  byte_count,
  encode(checksum, 'hex') AS checksum_sha256,
  object_key
FROM app.artifacts
WHERE run_id = :'run_id'::uuid
ORDER BY kind, artifact_version;

\echo 'Usage attributed to this Run'
SELECT
  id,
  tenant_id,
  run_id,
  attempt_id,
  meter_code,
  quantity,
  unit,
  outcome,
  source,
  reconciliation_state,
  observed_at
FROM app.usage_events
WHERE run_id = :'run_id'::uuid
ORDER BY observed_at, id;

\echo 'Result-download authorization audit'
SELECT action, outcome, reason, occurred_at
FROM app.audit_events
WHERE target_type = 'artifact'
  AND action = 'artifacts.download_authorize'
  AND safe_diff ->> 'run_id' = :'run_id'
ORDER BY occurred_at;
