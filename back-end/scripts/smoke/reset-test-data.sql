-- Remove accumulated test identities from dhumi_test.
--
-- Deletes only rows whose normalised email matches a known test prefix, and
-- refuses to run anywhere except dhumi_test. Deletion order follows the foreign
-- keys; auth_sessions.user_id is ON DELETE RESTRICT, so sessions must go first
-- once sign-in starts creating them.

\set ON_ERROR_STOP on

BEGIN;

DO $guard$
BEGIN
    IF current_database() <> 'dhumi_test' THEN
        RAISE EXCEPTION
            'Refusing to delete data from %; this script is for dhumi_test only',
            current_database();
    END IF;
END
$guard$;

CREATE TEMP TABLE doomed_users ON COMMIT DROP AS
SELECT id
FROM app.users
WHERE email_normalized LIKE 'signup-int-%'
   OR email_normalized LIKE 'manual-check-%'
   OR email_normalized LIKE 'live-check-%';

CREATE TEMP TABLE doomed_tenants ON COMMIT DROP AS
SELECT DISTINCT a.tenant_id AS id
FROM app.tenant_user_access a
JOIN doomed_users d ON d.id = a.user_id;

\echo 'About to remove:'
SELECT
    (SELECT count(*) FROM doomed_users)   AS users,
    (SELECT count(*) FROM doomed_tenants) AS tenants;

-- Sessions first: auth_sessions.user_id is ON DELETE RESTRICT.
DELETE FROM app.auth_sessions   WHERE user_id  IN (SELECT id FROM doomed_users);
DELETE FROM app.outbox_events   WHERE tenant_id IN (SELECT id FROM doomed_tenants);
DELETE FROM app.audit_events    WHERE tenant_id IN (SELECT id FROM doomed_tenants);
DELETE FROM app.legal_acceptances WHERE user_id IN (SELECT id FROM doomed_users);
DELETE FROM app.tenant_user_access WHERE user_id IN (SELECT id FROM doomed_users);
DELETE FROM app.tenants         WHERE id       IN (SELECT id FROM doomed_tenants);
DELETE FROM app.users           WHERE id       IN (SELECT id FROM doomed_users);

-- Idempotency records are scoped by an actor fingerprint, not a user id, so
-- they are cleared by age instead. Signup claims expire after 24 hours anyway.
DELETE FROM app.idempotency_records
WHERE scope_kind = 'signup'
  AND idempotency_key LIKE ANY (ARRAY['signup-int-%', 'manual-check-%', 'live-check-%']);

COMMIT;

\echo ''
\echo 'Remaining in dhumi_test:'
SELECT
    (SELECT count(*) FROM app.users)   AS users,
    (SELECT count(*) FROM app.tenants) AS tenants,
    (SELECT count(*) FROM app.idempotency_records) AS idempotency_records,
    (SELECT count(*) FROM app.audit_events) AS audit_events,
    (SELECT count(*) FROM app.outbox_events) AS outbox_events;

\echo ''
\echo 'Expected: 2 users and 2 tenants, the runtime-tenant-* fixtures which'
\echo 'replay through their deterministic idempotency keys.'
