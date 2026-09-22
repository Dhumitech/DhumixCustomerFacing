-- Refresh-token rotation history and reuse detection.
--
-- auth_sessions remains the authoritative session/family row. This child table
-- retains only SHA-256 hashes of high-entropy refresh-token generations so an
-- already-rotated token can be recognized without storing a replayable secret.

SET ROLE dhumi_owner;

CREATE TABLE app.auth_refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES app.auth_sessions(id) ON DELETE RESTRICT,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  generation integer NOT NULL CHECK (generation > 0),
  state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'rotated', 'reused', 'revoked', 'expired')),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  rotated_at timestamptz,
  reused_at timestamptz,
  revoked_at timestamptz,
  expired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (session_id, generation),
  CHECK (
    (state = 'active'
      AND rotated_at IS NULL AND reused_at IS NULL
      AND revoked_at IS NULL AND expired_at IS NULL)
    OR
    (state = 'rotated'
      AND rotated_at IS NOT NULL AND reused_at IS NULL
      AND revoked_at IS NULL AND expired_at IS NULL)
    OR
    (state = 'reused'
      AND rotated_at IS NOT NULL AND reused_at IS NOT NULL
      AND revoked_at IS NULL AND expired_at IS NULL)
    OR
    (state = 'revoked'
      AND revoked_at IS NOT NULL AND reused_at IS NULL AND expired_at IS NULL)
    OR
    (state = 'expired'
      AND expired_at IS NOT NULL AND reused_at IS NULL AND revoked_at IS NULL)
  )
);

CREATE UNIQUE INDEX auth_refresh_tokens_one_active_per_session_idx
  ON app.auth_refresh_tokens (session_id)
  WHERE state = 'active';
CREATE INDEX auth_refresh_tokens_session_state_idx
  ON app.auth_refresh_tokens (session_id, state, generation DESC);

-- Existing rows were created when auth_sessions.token_family_hash was the only
-- stored hash. Preserve those live cookies as generation one during rollout.
UPDATE app.auth_sessions
SET state = 'expired',
    updated_at = clock_timestamp()
WHERE state = 'active'
  AND expires_at <= clock_timestamp();

INSERT INTO app.auth_refresh_tokens (
  session_id,
  token_hash,
  generation,
  state,
  issued_at,
  revoked_at,
  expired_at
)
SELECT
  id,
  token_family_hash,
  1,
  CASE state
    WHEN 'active' THEN 'active'
    WHEN 'revoked' THEN 'revoked'
    ELSE 'expired'
  END,
  issued_at,
  CASE WHEN state = 'revoked' THEN COALESCE(revoked_at, updated_at) END,
  CASE WHEN state = 'expired' THEN expires_at END
FROM app.auth_sessions;

REVOKE ALL ON app.auth_refresh_tokens FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON app.auth_refresh_tokens TO dhumi_identity;

RESET ROLE;
