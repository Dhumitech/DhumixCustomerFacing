\set ON_ERROR_STOP on

-- One-time Pattern 4 runtime LOGIN bootstrap for one environment.
--
-- Required psql variables:
--   target_database              for example dhumi_dev
--   outbox_dispatcher_login_role for example dhumi_dev_outbox_dispatcher_login
--   job_manager_login_role       for example dhumi_dev_job_manager_login
--
-- Run as a cluster administrator against target_database. Both hidden
-- \password prompts send only encrypted verifiers to PostgreSQL.

BEGIN;

SELECT set_config('dhumi.bootstrap.target_database', :'target_database', false);
SELECT set_config(
    'dhumi.bootstrap.outbox_dispatcher_login_role',
    :'outbox_dispatcher_login_role',
    false
);
SELECT set_config(
    'dhumi.bootstrap.job_manager_login_role',
    :'job_manager_login_role',
    false
);

DO $preflight$
DECLARE
    target_database_name text := current_setting('dhumi.bootstrap.target_database');
    dispatcher_login_name text := current_setting(
        'dhumi.bootstrap.outbox_dispatcher_login_role'
    );
    manager_login_name text := current_setting('dhumi.bootstrap.job_manager_login_role');
    requested record;
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

    IF dispatcher_login_name !~ '^dhumi_[a-z0-9_]+_outbox_dispatcher_login$'
       OR dispatcher_login_name IN ('postgres', 'dhumi_owner', 'dhumi_outbox_dispatcher') THEN
        RAISE EXCEPTION 'Outbox-dispatcher LOGIN role name is unsafe';
    END IF;

    IF manager_login_name !~ '^dhumi_[a-z0-9_]+_job_manager_login$'
       OR manager_login_name IN ('postgres', 'dhumi_owner', 'dhumi_job_manager') THEN
        RAISE EXCEPTION 'Job-manager LOGIN role name is unsafe';
    END IF;

    IF dispatcher_login_name = manager_login_name THEN
        RAISE EXCEPTION 'Pattern 4 runtime LOGIN roles must be different';
    END IF;

    FOR requested IN
        SELECT * FROM (VALUES
            ('dhumi_outbox_dispatcher'::text, dispatcher_login_name),
            ('dhumi_job_manager'::text, manager_login_name)
        ) AS roles(capability_name, login_name)
    LOOP
        SELECT * INTO capability
        FROM pg_authid
        WHERE rolname = requested.capability_name;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Required capability role % is missing', requested.capability_name;
        END IF;

        IF capability.rolcanlogin
           OR capability.rolsuper
           OR capability.rolcreatedb
           OR capability.rolcreaterole
           OR capability.rolreplication
           OR capability.rolbypassrls
           OR capability.rolpassword IS NOT NULL THEN
            RAISE EXCEPTION 'Capability role % is unsafe', requested.capability_name;
        END IF;

        IF EXISTS (
            SELECT 1
            FROM pg_auth_members membership
            WHERE membership.member = capability.oid
        ) THEN
            RAISE EXCEPTION 'Capability role % must not belong to another role',
                requested.capability_name;
        END IF;

        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = requested.login_name) THEN
            RAISE EXCEPTION 'Requested LOGIN role % already exists; no alteration attempted',
                requested.login_name;
        END IF;
    END LOOP;
END
$preflight$;

SELECT format(
    'CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
    :'outbox_dispatcher_login_role'
) \gexec

\echo 'Set the outbox-dispatcher runtime password (input is hidden and confirmed):'
\password :outbox_dispatcher_login_role

SELECT format(
    'CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
    :'job_manager_login_role'
) \gexec

\echo 'Set the Job Manager runtime password (input is hidden and confirmed):'
\password :job_manager_login_role

GRANT dhumi_outbox_dispatcher TO :"outbox_dispatcher_login_role"
  WITH INHERIT FALSE, SET TRUE;
GRANT dhumi_job_manager TO :"job_manager_login_role"
  WITH INHERIT FALSE, SET TRUE;

GRANT CONNECT ON DATABASE :"target_database" TO
    dhumi_outbox_dispatcher,
    dhumi_job_manager,
    :"outbox_dispatcher_login_role",
    :"job_manager_login_role";

SELECT format(
    'ALTER ROLE %I SET search_path TO pg_catalog',
    :'outbox_dispatcher_login_role'
) \gexec
SELECT format(
    'ALTER ROLE %I SET search_path TO pg_catalog',
    :'job_manager_login_role'
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
WHERE login.rolname IN (
    :'outbox_dispatcher_login_role',
    :'job_manager_login_role'
)
ORDER BY login.rolname;
