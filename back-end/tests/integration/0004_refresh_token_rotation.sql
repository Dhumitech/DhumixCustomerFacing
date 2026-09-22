-- Refresh rotation/reuse regression tests for 0006_refresh_token_rotation.sql.
-- The complete file is rolled back and must run only on dhumi_test.

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(p_condition boolean, p_message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_condition IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'assertion failed: %', p_message;
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.assert_true(boolean, text) TO PUBLIC;

SELECT pg_temp.assert_true(
  to_regclass('app.auth_refresh_tokens') IS NOT NULL,
  'refresh-token generation history table must exist'
);
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL aclexplode(
      COALESCE(relation.relacl, acldefault('r', relation.relowner))
    ) AS privilege
    WHERE namespace.nspname = 'app'
      AND relation.relname = 'auth_refresh_tokens'
      AND privilege.grantee = 0
      AND privilege.privilege_type = 'SELECT'
  ),
  'PUBLIC must not read refresh-token hashes'
);
SELECT pg_temp.assert_true(
  has_table_privilege('dhumi_identity', 'app.auth_refresh_tokens', 'SELECT,INSERT,UPDATE'),
  'Identity must own the refresh-token lifecycle'
);
SELECT pg_temp.assert_true(
  NOT has_table_privilege('dhumi_customer_api', 'app.auth_refresh_tokens', 'SELECT'),
  'customer API role must not read refresh-token hashes'
);

SET LOCAL ROLE dhumi_identity;

INSERT INTO app.users (id, email_normalized, password_hash)
VALUES (
  '00000000-0000-4000-8000-000000000601',
  'refresh-migration@example.test',
  '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$ZmFrZWhhc2g'
);
INSERT INTO app.auth_sessions (
  id,
  user_id,
  token_family_hash,
  expires_at
) VALUES (
  '00000000-0000-4000-8000-000000000602',
  '00000000-0000-4000-8000-000000000601',
  decode(repeat('aa', 32), 'hex'),
  clock_timestamp() + interval '1 hour'
);
INSERT INTO app.auth_refresh_tokens (
  session_id,
  token_hash,
  generation,
  state
) VALUES (
  '00000000-0000-4000-8000-000000000602',
  decode(repeat('aa', 32), 'hex'),
  1,
  'active'
);

DO $$
DECLARE
  v_second_active_rejected boolean := false;
  v_duplicate_generation_rejected boolean := false;
BEGIN
  BEGIN
    INSERT INTO app.auth_refresh_tokens (session_id, token_hash, generation, state)
    VALUES (
      '00000000-0000-4000-8000-000000000602',
      decode(repeat('bb', 32), 'hex'),
      2,
      'active'
    );
  EXCEPTION WHEN unique_violation THEN
    v_second_active_rejected := true;
  END;

  UPDATE app.auth_refresh_tokens
  SET state = 'rotated', rotated_at = clock_timestamp()
  WHERE session_id = '00000000-0000-4000-8000-000000000602'
    AND generation = 1;

  INSERT INTO app.auth_refresh_tokens (session_id, token_hash, generation, state)
  VALUES (
    '00000000-0000-4000-8000-000000000602',
    decode(repeat('bb', 32), 'hex'),
    2,
    'active'
  );

  BEGIN
    INSERT INTO app.auth_refresh_tokens (
      session_id, token_hash, generation, state, revoked_at
    )
    VALUES (
      '00000000-0000-4000-8000-000000000602',
      decode(repeat('cc', 32), 'hex'),
      2,
      'revoked',
      clock_timestamp()
    );
  EXCEPTION WHEN unique_violation THEN
    v_duplicate_generation_rejected := true;
  END;

  PERFORM pg_temp.assert_true(
    v_second_active_rejected,
    'one session must never have two active generations'
  );
  PERFORM pg_temp.assert_true(
    v_duplicate_generation_rejected,
    'generation numbers must be unique inside one session family'
  );
END;
$$;

SELECT pg_temp.assert_true(
  (
    SELECT array_agg(state ORDER BY generation) = ARRAY['rotated', 'active']::text[]
    FROM app.auth_refresh_tokens
    WHERE session_id = '00000000-0000-4000-8000-000000000602'
  ),
  'a legal rotation must retain the spent generation and one active successor'
);

RESET ROLE;
ROLLBACK;
