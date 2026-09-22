-- Least-privilege read surface for GET /v1/runs/{run_id}/result.
--
-- The customer capability may authorize one Dhumi-stored normalized Artifact.
-- It cannot read Attempt identity, storage encoding, normalization schema or
-- deletion evidence. This migration does not add a storage signer, call Bright
-- Data, publish data, or modify migrations 0001-0027.

SET ROLE dhumi_owner;

REVOKE SELECT ON app.artifacts FROM dhumi_customer_api;

GRANT SELECT (
  id,
  tenant_id,
  run_id,
  kind,
  artifact_version,
  object_key,
  content_type,
  byte_count,
  checksum,
  state,
  created_at,
  expires_at
) ON app.artifacts TO dhumi_customer_api;

-- Successful signed-download authorization is a mandatory immutable audit
-- event. Keep the Customer API write surface to the exact non-secret fields
-- already used by customer-facing audit producers.
REVOKE INSERT ON app.audit_events FROM dhumi_customer_api;

GRANT INSERT (
  tenant_id,
  actor_user_id,
  actor_api_key_id,
  action,
  target_type,
  target_id,
  outcome,
  request_id,
  ip_fingerprint,
  safe_diff
) ON app.audit_events TO dhumi_customer_api;

CREATE INDEX artifacts_validated_result_read_idx
  ON app.artifacts (
    tenant_id,
    run_id,
    artifact_version DESC,
    created_at DESC,
    id DESC
  )
  WHERE kind = 'normalized' AND state = 'validated';

RESET ROLE;
