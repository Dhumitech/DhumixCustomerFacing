\set ON_ERROR_STOP on

-- One-time result-recorder capability/login bootstrap for one environment.
--
-- Required psql variables:
--   target_database            for example dhumi_dev
--   result_recorder_login_role for example dhumi_dev_result_recorder_login
--
-- Run as a cluster administrator against target_database. The hidden
-- \password prompt sends only the encrypted verifier to PostgreSQL.

BEGIN;

SELECT set_config('dhumi.bootstrap.target_database', :'target_database', false);
SELECT set_config(
    'dhumi.bootstrap.result_recorder_login_role',
    :'result_recorder_login_role',
    false
);

DO $preflight$
DECLARE
    target_database_name text := current_setting('dhumi.bootstrap.target_database');
    result_recorder_login_name text := current_setting(
        'dhumi.bootstrap.result_recorder_login_role'
    );
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

    IF result_recorder_login_name !~ '^dhumi_[a-z0-9_]+_result_recorder_login$'
       OR result_recorder_login_name IN ('postgres', 'dhumi_owner', 'dhumi_result_recorder') THEN
        RAISE EXCEPTION 'Result-recorder LOGIN role name is unsafe or does not match the approved pattern';
    END IF;

    SELECT * INTO capability
    FROM pg_authid
    WHERE rolname = 'dhumi_result_recorder';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Required dhumi_result_recorder capability role is missing';
    END IF;

    IF capability.rolcanlogin
       OR capability.rolsuper
       OR capability.rolcreatedb
       OR capability.rolcreaterole
       OR capability.rolreplication
       OR capability.rolbypassrls
       OR capability.rolpassword IS NOT NULL THEN
        RAISE EXCEPTION 'Existing dhumi_result_recorder capability role is unsafe';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_auth_members membership
        WHERE membership.member = capability.oid
    ) THEN
        RAISE EXCEPTION 'dhumi_result_recorder must not belong to another role';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_auth_members membership
        JOIN pg_authid member_role ON member_role.oid = membership.member
        WHERE membership.roleid = capability.oid
          AND NOT (
              member_role.rolname ~ '^dhumi_[a-z0-9_]+_result_recorder_login$'
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
        RAISE EXCEPTION 'dhumi_result_recorder has an unsafe runtime member';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = result_recorder_login_name) THEN
        RAISE EXCEPTION 'Requested result-recorder LOGIN role already exists; no automatic alteration was attempted';
    END IF;
END
$preflight$;

SELECT format(
    'CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
    :'result_recorder_login_role'
) \gexec

\echo 'Set the result-recorder runtime password (input is hidden and confirmed):'
\password :result_recorder_login_role

GRANT dhumi_result_recorder TO :"result_recorder_login_role"
  WITH INHERIT FALSE, SET TRUE;

GRANT CONNECT ON DATABASE :"target_database" TO
    dhumi_result_recorder,
    :"result_recorder_login_role";

SELECT format(
    'ALTER ROLE %I SET search_path TO pg_catalog',
    :'result_recorder_login_role'
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
WHERE login.rolname = :'result_recorder_login_role';
