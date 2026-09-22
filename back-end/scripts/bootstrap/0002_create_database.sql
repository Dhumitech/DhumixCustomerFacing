\set ON_ERROR_STOP on

-- Required psql variables:
--   target_database  Example: dhumi_dev
--   owner_role       Must be dhumi_owner
--
-- CREATE DATABASE cannot run inside a transaction. This script creates the
-- database with connections disabled, removes PUBLIC access, grants only the
-- approved CONNECT privileges, then enables connections. If a later command
-- fails, stop and inspect the disabled/partially prepared database manually.

SELECT set_config('dhumi.bootstrap.target_database', :'target_database', false);
SELECT set_config('dhumi.bootstrap.owner_role', :'owner_role', false);

DO $pre_create$
DECLARE
    target_database_name text := current_setting('dhumi.bootstrap.target_database');
    owner_role_name text := current_setting('dhumi.bootstrap.owner_role');
    required_roles constant text[] := ARRAY[
        'dhumi_customer_api',
        'dhumi_identity',
        'dhumi_admission',
        'dhumi_job_manager',
        'dhumi_result_recorder',
        'dhumi_outbox_dispatcher',
        'dhumi_envelope_janitor',
        'dhumi_operator'
    ];
BEGIN
    IF target_database_name !~ '^[a-z][a-z0-9_]{0,62}$' THEN
        RAISE EXCEPTION 'Unsafe target_database value: %', target_database_name;
    END IF;

    IF owner_role_name <> 'dhumi_owner' THEN
        RAISE EXCEPTION 'owner_role must be dhumi_owner';
    END IF;

    IF current_database() <> 'postgres' THEN
        RAISE EXCEPTION 'Connect to postgres before creating a database';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_roles
        WHERE rolname = current_user
          AND rolsuper
          AND rolcreatedb
    ) THEN
        RAISE EXCEPTION
            'Current role % cannot create the approved development database',
            current_user;
    END IF;

    IF current_setting('listen_addresses') <> 'localhost'
       OR current_setting('password_encryption') <> 'scram-sha-256'
       OR current_setting('data_checksums') <> 'on' THEN
        RAISE EXCEPTION
            'PostgreSQL hardening settings no longer match the approved local baseline';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_database WHERE datname = target_database_name) THEN
        RAISE EXCEPTION
            'Database % already exists; no automatic alteration is allowed',
            target_database_name;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_roles
        WHERE rolname = owner_role_name
          AND NOT rolcanlogin
          AND NOT rolsuper
          AND NOT rolcreatedb
          AND NOT rolcreaterole
          AND NOT rolreplication
          AND NOT rolbypassrls
    ) THEN
        RAISE EXCEPTION 'Owner role % is missing or unsafe', owner_role_name;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_collation
        WHERE collprovider = 'b'
          AND colllocale = 'PG_UNICODE_FAST'
          AND pg_encoding_to_char(collencoding) = 'UTF8'
          AND collisdeterministic
    ) THEN
        RAISE EXCEPTION 'PG_UNICODE_FAST is unavailable';
    END IF;

    IF (
        SELECT count(*)
        FROM pg_roles
        WHERE rolname = ANY (required_roles)
          AND NOT rolcanlogin
          AND NOT rolsuper
          AND NOT rolcreatedb
          AND NOT rolcreaterole
          AND NOT rolreplication
          AND NOT rolbypassrls
    ) <> cardinality(required_roles) THEN
        RAISE EXCEPTION 'One or more approved capability roles are missing or unsafe';
    END IF;
END
$pre_create$;

SELECT format(
    'CREATE DATABASE %I WITH OWNER = %I TEMPLATE = template0 ENCODING = %L LOCALE_PROVIDER = builtin BUILTIN_LOCALE = %L ALLOW_CONNECTIONS = false',
    :'target_database',
    :'owner_role',
    'UTF8',
    'PG_UNICODE_FAST'
) \gexec

SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'target_database') \gexec

SELECT format(
    'GRANT CONNECT ON DATABASE %I TO dhumi_customer_api, dhumi_identity, dhumi_admission, dhumi_job_manager, dhumi_result_recorder, dhumi_outbox_dispatcher, dhumi_envelope_janitor, dhumi_operator',
    :'target_database'
) \gexec

SELECT format(
    'COMMENT ON DATABASE %I IS %L',
    :'target_database',
    'Dhumi local development database. Cluster bootstrap is separate from application migrations.'
) \gexec

SELECT format('ALTER DATABASE %I ALLOW_CONNECTIONS true', :'target_database') \gexec

SELECT
    datname,
    pg_get_userbyid(datdba) AS owner,
    pg_encoding_to_char(encoding) AS encoding,
    CASE datlocprovider
        WHEN 'b' THEN 'builtin'
        WHEN 'c' THEN 'libc'
        WHEN 'i' THEN 'icu'
        ELSE datlocprovider::text
    END AS locale_provider,
    datlocale,
    datallowconn
FROM pg_database
WHERE datname = :'target_database';

SELECT
    rolname,
    has_database_privilege(rolname, :'target_database', 'CONNECT') AS can_connect
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
