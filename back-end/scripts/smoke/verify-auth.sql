-- Manual database inspection for POST /v1/auth/signup.
--
-- Run against dhumi_test as a role that can read the app schema, for example
-- the migration principal. Supply the email you signed up with:
--
--   psql -X -W -h localhost -p 5432 -U <migration-principal> -d dhumi_test \
--        -v email='manual-check-1234@example.test' \
--        -f scripts/smoke/verify-signup.sql
--
-- Nothing here writes. Every statement is a SELECT.

\echo '=== 1. Identity, workspace and owner access ==='
SELECT
    u.email_normalized,
    u.state              AS user_state,
    u.failed_auth_count,
    t.display_name       AS workspace,
    t.state              AS workspace_state,
    a.access_role,
    a.state              AS access_state
FROM app.users u
JOIN app.tenant_user_access a ON a.user_id = u.id
JOIN app.tenants t           ON t.id = a.tenant_id
WHERE u.email_normalized = :'email';

\echo ''
\echo '=== 2. Password hash shape (never the hash itself) ==='
-- Confirms Argon2id and the parameters the hash was created with. Raising the
-- configured cost later must not invalidate this row; it is upgraded on the
-- next successful sign-in.
SELECT
    left(u.password_hash, 30) AS algorithm_and_parameters,
    length(u.password_hash)   AS encoded_length,
    u.password_hash LIKE '$argon2id$%' AS is_argon2id
FROM app.users u
WHERE u.email_normalized = :'email';

\echo ''
\echo '=== 3. Legal acceptance evidence ==='
-- document_hash is the decoded form of the document_hash_hex the service sent.
-- If this is ever NULL the contract-to-column mapping has regressed.
SELECT
    l.document_type,
    l.document_version,
    encode(l.document_hash, 'hex') AS document_hash_hex,
    l.disclosure_version,
    l.locale,
    l.acceptance_method,
    l.accepted_at
FROM app.legal_acceptances l
JOIN app.users u ON u.id = l.user_id
WHERE u.email_normalized = :'email'
ORDER BY l.document_type;

\echo ''
\echo '=== 4. Idempotency claim ==='
-- state must be completed and response_status 202. A row stuck at in_progress
-- would mean a transaction committed the claim without completing it, which
-- the current function cannot do.
SELECT
    i.operation_code,
    i.scope_kind,
    i.idempotency_key,
    i.state,
    i.response_status,
    i.resource_type,
    i.response_body_reference,
    i.created_at,
    i.completed_at,
    i.expires_at
FROM app.idempotency_records i
WHERE i.scope_kind = 'signup'
  AND i.operation_code = 'auth.signup'
  AND i.created_at > now() - interval '1 hour'
ORDER BY i.created_at DESC
LIMIT 5;

\echo ''
\echo '=== 5. Audit trail ==='
-- tenant.signup for a new identity; identity.signup_existing for a repeat.
-- Neither may contain a password or token.
SELECT
    e.action,
    e.target_type,
    e.outcome,
    e.request_id,
    e.occurred_at
FROM app.audit_events e
JOIN app.tenants t ON t.id = e.tenant_id
JOIN app.tenant_user_access a ON a.tenant_id = t.id
JOIN app.users u ON u.id = a.user_id
WHERE u.email_normalized = :'email'
ORDER BY e.occurred_at;

\echo ''
\echo '=== 6. Outbox, unpublished by design ==='
-- PostgreSQL records the row; a post-commit dispatcher publishes it. There is
-- no dispatcher yet, so published_at is expected to be NULL.
SELECT
    o.topic,
    o.aggregate_type,
    o.schema_version,
    o.published_at,
    o.delivery_attempts,
    o.created_at
FROM app.outbox_events o
JOIN app.tenants t ON t.id = o.tenant_id
JOIN app.tenant_user_access a ON a.tenant_id = t.id
JOIN app.users u ON u.id = a.user_id
WHERE u.email_normalized = :'email'
ORDER BY o.created_at;

\echo ''
\echo '=== 7. Nothing leaked into provider tables ==='
-- Signup must create no provider state whatsoever.
SELECT
    (SELECT count(*) FROM app.provider_credentials) AS provider_credentials,
    (SELECT count(*) FROM app.runs)                 AS runs,
    (SELECT count(*) FROM app.services)             AS services;

\echo ''
\echo '=== 8. Expected result ==='
\echo '  1 user, 1 tenant (active), 1 owner access (active)'
\echo '  1 legal acceptance with a non-null document_hash_hex'
\echo '  idempotency state=completed, response_status=202'
\echo '  1 audit event, 1 outbox row with published_at NULL'
\echo '  provider_credentials, runs and services all 0'

\echo ''
\echo '=== 9. Sessions created by sign-in ==='
-- token_family_hash must be 32 bytes of SHA-256. The plaintext refresh token is
-- never stored; it exists only in the customer's cookie.
SELECT
    s.state,
    length(s.token_family_hash)            AS family_hash_bytes,
    s.expires_at > s.issued_at             AS expiry_after_issue,
    s.device_metadata,
    s.security_metadata,
    s.last_used_at,
    s.revoked_at,
    s.issued_at
FROM app.auth_sessions s
JOIN app.users u ON u.id = s.user_id
WHERE u.email_normalized = :'email'
ORDER BY s.issued_at;

\echo ''
\echo '=== 10. Failed-authentication counters ==='
-- failed_auth_count increments on each rejection and resets to 0 on success.
-- state is locked only once the configured threshold is crossed, and a correct
-- password clears a lock whose window has elapsed.
SELECT
    u.state,
    u.failed_auth_count,
    u.last_failed_auth_at,
    u.email_verified_at,
    left(u.password_hash, 30) AS hash_algorithm_and_parameters
FROM app.users u
WHERE u.email_normalized = :'email';

\echo ''
\echo '=== 11. Sign-in audit trail ==='
-- accepted on success; denied, denied_state, denied_workspace or
-- denied_state_race on rejection. Never a password or token.
SELECT
    e.action,
    e.outcome,
    e.request_id,
    length(e.ip_fingerprint) AS ip_fingerprint_bytes,
    e.safe_diff,
    e.occurred_at
FROM app.audit_events e
JOIN app.users u ON u.id = e.actor_user_id
WHERE u.email_normalized = :'email'
  AND e.action = 'identity.sign_in'
ORDER BY e.occurred_at;

\echo ''
\echo '=== 12. Expected sign-in result ==='
\echo '  one active session per successful sign-in'
\echo '  family_hash_bytes = 32, expiry_after_issue = t'
\echo '  device_metadata holds a family token and a hash, never a raw user agent'
\echo '  security_metadata = {"issued_by": "sign_in"}'
\echo '  failed_auth_count = 0 after a success, state = active'
\echo '  password hash begins $argon2id$v=19$m=19456,t=2,p=1'
\echo '  one audit row per attempt, outcome accepted or denied*'
\echo '  ip_fingerprint is 32 bytes or null, never a readable address'
