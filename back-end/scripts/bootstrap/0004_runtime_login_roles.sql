\set ON_ERROR_STOP on

-- One-time local/runtime LOGIN-role bootstrap.
--
-- Required psql variables:
--   target_database         for example dhumi_dev
--   identity_login_role     for example dhumi_dev_identity_login
--   customer_api_login_role for example dhumi_dev_customer_api_login
--
-- PostgreSQL's supported \password command performs the hidden prompts and
-- sends only the encrypted verifier to the server. Existing roles are rejected
-- rather than silently changed.

BEGIN;

SELECT set_config('dhumi.bootstrap.target_database', :'target_database', false);
SELECT set_config('dhumi.bootstrap.identity_login_role', :'identity_login_role', false);
SELECT set_config('dhumi.bootstrap.customer_api_login_role', :'customer_api_login_role', false);

DO $preflight$
DECLARE
    target_database_name text := current_setting('dhumi.bootstrap.target_database');
    identity_login_name text := current_setting('dhumi.bootstrap.identity_login_role');
    customer_api_login_name text := current_setting('dhumi.bootstrap.customer_api_login_role');
BEGIN
    IF current_database() <> target_database_name THEN
        RAISE EXCEPTION 'Connected to %, expected %', current_database(), target_database_name;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_roles
        WHERE rolname = current_user AND rolsuper AND rolcreaterole
    ) THEN
        RAISE EXCEPTION 'Current role % cannot create runtime LOGIN roles', current_user;
    END IF;

    IF identity_login_name !~ '^dhumi_[a-z0-9_]+_identity_login$'
       OR customer_api_login_name !~ '^dhumi_[a-z0-9_]+_customer_api_login$' THEN
        RAISE EXCEPTION
            'Runtime LOGIN role names must follow the approved environment-specific patterns';
    END IF;

    IF identity_login_name IN ('postgres', 'dhumi_owner')
       OR customer_api_login_name IN ('postgres', 'dhumi_owner')
       OR identity_login_name = customer_api_login_name THEN
        RAISE EXCEPTION 'Runtime LOGIN role names are unsafe or not distinct';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dhumi_identity' AND NOT rolcanlogin)
       OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dhumi_customer_api' AND NOT rolcanlogin) THEN
        RAISE EXCEPTION 'Required capability roles are missing or can LOGIN';
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_roles
        WHERE rolname IN (identity_login_name, customer_api_login_name)
    ) THEN
        RAISE EXCEPTION 'A requested runtime LOGIN role already exists; no automatic alteration was attempted';
    END IF;
END
$preflight$;

SELECT format(
    'CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
    :'identity_login_role'
) \gexec

SELECT format(
    'CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
    :'customer_api_login_role'
) \gexec

\echo 'Set the Identity runtime password (input is hidden and confirmed):'
\password :identity_login_role
\echo 'Set the Customer API runtime password (input is hidden and confirmed):'
\password :customer_api_login_role

GRANT dhumi_identity TO :"identity_login_role" WITH INHERIT FALSE, SET TRUE;
GRANT dhumi_customer_api TO :"customer_api_login_role" WITH INHERIT FALSE, SET TRUE;

GRANT CONNECT ON DATABASE :"target_database" TO
    :"identity_login_role",
    :"customer_api_login_role";

SELECT format('ALTER ROLE %I SET search_path TO pg_catalog', :'identity_login_role') \gexec
SELECT format('ALTER ROLE %I SET search_path TO pg_catalog', :'customer_api_login_role') \gexec

COMMIT;

SELECT
    login.rolname,
    login.rolcanlogin,
    login.rolinherit,
    login.rolsuper,
    login.rolcreatedb,
    login.rolcreaterole,
    login.rolreplication,
    login.rolbypassrls,
    granted.rolname AS granted_capability
FROM pg_roles AS login
LEFT JOIN pg_auth_members AS membership ON membership.member = login.oid
LEFT JOIN pg_roles AS granted ON granted.oid = membership.roleid
WHERE login.rolname IN (:'identity_login_role', :'customer_api_login_role')
ORDER BY login.rolname, granted.rolname;
