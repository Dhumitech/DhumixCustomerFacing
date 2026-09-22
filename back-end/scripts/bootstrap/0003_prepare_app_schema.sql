\set ON_ERROR_STOP on

-- Required psql variables:
--   target_database  Database currently connected to, for example dhumi_dev
--   owner_role       Must be dhumi_owner
--   app_schema       Must be app (the accepted architecture contract)
--
-- This file prepares only the empty application schema and default security.
-- It intentionally creates no extension, table, index, function or RLS policy.

SELECT set_config('dhumi.bootstrap.target_database', :'target_database', false);
SELECT set_config('dhumi.bootstrap.owner_role', :'owner_role', false);
SELECT set_config('dhumi.bootstrap.app_schema', :'app_schema', false);

DO $pre_schema$
DECLARE
    target_database_name text := current_setting('dhumi.bootstrap.target_database');
    owner_role_name text := current_setting('dhumi.bootstrap.owner_role');
    app_schema_name text := current_setting('dhumi.bootstrap.app_schema');
    existing_schema_owner text;
BEGIN
    IF current_database() <> target_database_name THEN
        RAISE EXCEPTION
            'Connected to %, expected %',
            current_database(),
            target_database_name;
    END IF;

    IF owner_role_name <> 'dhumi_owner' THEN
        RAISE EXCEPTION 'owner_role must be dhumi_owner';
    END IF;

    IF app_schema_name <> 'app' THEN
        RAISE EXCEPTION
            'app_schema must be app because the accepted migrations and RLS context use app';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_database
        WHERE datname = target_database_name
          AND pg_get_userbyid(datdba) = owner_role_name
          AND pg_encoding_to_char(encoding) = 'UTF8'
          AND datlocprovider = 'b'
          AND datlocale = 'PG_UNICODE_FAST'
          AND datallowconn
    ) THEN
        RAISE EXCEPTION
            'Database owner, encoding, locale provider, locale or connection state is not approved';
    END IF;

    SELECT schema_owner
      INTO existing_schema_owner
    FROM information_schema.schemata
    WHERE schema_name = app_schema_name;

    IF existing_schema_owner IS NOT NULL
       AND existing_schema_owner <> owner_role_name THEN
        RAISE EXCEPTION
            'Existing schema % is owned by %, expected %',
            app_schema_name,
            existing_schema_owner,
            owner_role_name;
    END IF;
END
$pre_schema$;

SET ROLE :"owner_role";

CREATE SCHEMA IF NOT EXISTS :"app_schema" AUTHORIZATION :"owner_role";

REVOKE ALL ON SCHEMA :"app_schema" FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

GRANT USAGE ON SCHEMA :"app_schema" TO
    dhumi_customer_api,
    dhumi_identity,
    dhumi_admission,
    dhumi_job_manager,
    dhumi_result_recorder,
    dhumi_outbox_dispatcher,
    dhumi_envelope_janitor,
    dhumi_operator;

ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA :"app_schema"
    REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA :"app_schema"
    REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA :"app_schema"
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA :"app_schema"
    REVOKE USAGE ON TYPES FROM PUBLIC;

SELECT format('ALTER DATABASE %I SET timezone TO %L', :'target_database', 'UTC') \gexec

RESET ROLE;

SELECT
    schema_name,
    schema_owner
FROM information_schema.schemata
WHERE schema_name = :'app_schema';

SELECT
    rolname,
    has_schema_privilege(rolname, :'app_schema', 'USAGE') AS can_use_schema,
    has_schema_privilege(rolname, :'app_schema', 'CREATE') AS can_create_objects
FROM pg_roles
WHERE rolname IN (
    'dhumi_customer_api',
    'dhumi_identity',
    'dhumi_admission',
    'dhumi_job_manager',
    'dhumi_result_recorder',
    'dhumi_outbox_dispatcher',
    'dhumi_envelope_janitor',
    'dhumi_operator'
)
ORDER BY rolname;

\echo 'STOP: the empty app schema is prepared. Do not run table migrations yet.'
