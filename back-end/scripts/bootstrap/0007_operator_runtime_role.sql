\set ON_ERROR_STOP on

-- One-time Operator capability/login bootstrap for one environment.
--
-- Required psql variables:
--   target_database      for example dhumi_test
--   operator_login_role  for example dhumi_test_operator_login
--
-- Run as a cluster administrator against target_database. The hidden
-- \password prompt sends only the encrypted verifier to PostgreSQL.
--
-- dhumi_operator is a broad read/write/update tooling identity (for example
-- an MCP client) meant to be used directly rather than assumed per
-- transaction by application request code. It never gets DELETE, TRUNCATE,
-- DDL or BYPASSRLS. Table grants and the permissive RLS policies
-- dhumi_operator needs live in narrow forward migrations such as Pattern 4
-- migration 0030; this script only creates the LOGIN identity and membership.

BEGIN;

SELECT set_config('dhumi.bootstrap.target_database', :'target_database', false);
SELECT set_config('dhumi.bootstrap.operator_login_role', :'operator_login_role', false);

DO $preflight$
DECLARE
    target_database_name text := current_setting('dhumi.bootstrap.target_database');
    operator_login_name text := current_setting('dhumi.bootstrap.operator_login_role');
    capability record;
BEGIN
    IF current_database() <> target_database_name THEN
        RAISE EXCEPTION 'Connected to %, expected %', current_database(), target_database_name;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_roles
        WHERE rolname = current_user AND rolsuper AND rolcreaterole
    ) THEN
        RAISE EXCEPTION 'Current role % cannot create runtime roles', current_user;
    END IF;

    IF operator_login_name !~ '^dhumi_[a-z0-9_]+_operator_login$'
       OR operator_login_name IN ('postgres', 'dhumi_owner', 'dhumi_operator') THEN
        RAISE EXCEPTION 'Operator LOGIN role name is unsafe or does not match the approved pattern';
    END IF;

    SELECT * INTO capability
    FROM pg_authid
    WHERE rolname = 'dhumi_operator';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Required dhumi_operator capability role is missing';
    END IF;

    IF capability.rolcanlogin
       OR capability.rolsuper
       OR capability.rolcreatedb
       OR capability.rolcreaterole
       OR capability.rolreplication
       OR capability.rolbypassrls
       OR capability.rolpassword IS NOT NULL THEN
        RAISE EXCEPTION 'Existing dhumi_operator capability role is unsafe';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_auth_members membership
        WHERE membership.member = capability.oid
    ) THEN
        RAISE EXCEPTION 'dhumi_operator must not belong to another role';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_auth_members membership
        JOIN pg_authid member_role ON member_role.oid = membership.member
        WHERE membership.roleid = capability.oid
          AND NOT (
              member_role.rolname ~ '^dhumi_[a-z0-9_]+_operator_login$'
              AND member_role.rolcanlogin
              AND NOT member_role.rolinherit
              AND NOT member_role.rolsuper
              AND NOT member_role.rolcreatedb
              AND NOT member_role.rolcreaterole
              AND NOT member_role.rolreplication
              AND NOT member_role.rolbypassrls
              AND member_role.rolpassword IS NOT NULL
              AND NOT membership.admin_option
              AND NOT membership.inherit_option
              AND membership.set_option
              AND NOT EXISTS (
                  SELECT 1
                  FROM pg_auth_members other_membership
                  WHERE other_membership.member = member_role.oid
                    AND other_membership.oid <> membership.oid
              )
          )
    ) THEN
        RAISE EXCEPTION 'dhumi_operator has an unsafe runtime member';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = operator_login_name) THEN
        RAISE EXCEPTION 'Requested operator LOGIN role already exists; no automatic alteration was attempted';
    END IF;
END
$preflight$;

SELECT format(
    'CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
    :'operator_login_role'
) \gexec

\echo 'Set the operator runtime password (input is hidden and confirmed):'
\password :operator_login_role

GRANT dhumi_operator TO :"operator_login_role"
  WITH INHERIT FALSE, SET TRUE;

GRANT CONNECT ON DATABASE :"target_database" TO
    dhumi_operator,
    :"operator_login_role";

SELECT format(
    'ALTER ROLE %I SET search_path TO pg_catalog',
    :'operator_login_role'
) \gexec

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
    granted.rolname AS granted_capability,
    membership.inherit_option,
    membership.set_option,
    membership.admin_option
FROM pg_roles AS login
LEFT JOIN pg_auth_members AS membership ON membership.member = login.oid
LEFT JOIN pg_roles AS granted ON granted.oid = membership.roleid
WHERE login.rolname = :'operator_login_role';
