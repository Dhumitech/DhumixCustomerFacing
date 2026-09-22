\set ON_ERROR_STOP on

-- Required psql variables:
--   target_database  Example: dhumi_dev
--   owner_role       Must be the approved architecture role: dhumi_owner
--
-- This file is read-only. pg_hba_file_rules reads the current HBA file; it does
-- not prove that a restart loaded the same file. Use the companion PowerShell
-- listener check and a fresh password-authenticated connection as runtime proof.

SELECT set_config('dhumi.bootstrap.target_database', :'target_database', false);
SELECT set_config('dhumi.bootstrap.owner_role', :'owner_role', false);

DO $preflight$
DECLARE
    target_database_name text := current_setting('dhumi.bootstrap.target_database');
    owner_role_name text := current_setting('dhumi.bootstrap.owner_role');
    capability_roles constant text[] := ARRAY[
        'dhumi_customer_api',
        'dhumi_identity',
        'dhumi_admission',
        'dhumi_job_manager',
        'dhumi_result_recorder',
        'dhumi_outbox_dispatcher',
        'dhumi_envelope_janitor',
        'dhumi_operator'
    ];
    active_hba_rows integer;
BEGIN
    IF target_database_name !~ '^[a-z][a-z0-9_]{0,62}$' THEN
        RAISE EXCEPTION 'Unsafe target_database value: %', target_database_name;
    END IF;

    IF owner_role_name <> 'dhumi_owner' THEN
        RAISE EXCEPTION
            'owner_role must be dhumi_owner for this architecture; received %',
            owner_role_name;
    END IF;

    IF current_database() <> 'postgres' THEN
        RAISE EXCEPTION
            'Connect to the postgres administrative database, not %',
            current_database();
    END IF;

    IF current_setting('server_version_num')::integer < 180000
       OR current_setting('server_version_num')::integer >= 190000 THEN
        RAISE EXCEPTION
            'This reviewed bootstrap requires PostgreSQL 18.x; found %',
            current_setting('server_version');
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_roles
        WHERE rolname = current_user
          AND rolsuper
          AND rolcreatedb
          AND rolcreaterole
    ) THEN
        RAISE EXCEPTION
            'Current role % lacks the required local bootstrap privileges',
            current_user;
    END IF;

    IF current_setting('listen_addresses') <> 'localhost' THEN
        RAISE EXCEPTION
            'listen_addresses is %, expected localhost',
            current_setting('listen_addresses');
    END IF;

    IF current_setting('password_encryption') <> 'scram-sha-256' THEN
        RAISE EXCEPTION
            'password_encryption is %, expected scram-sha-256',
            current_setting('password_encryption');
    END IF;

    IF current_setting('data_checksums') <> 'on' THEN
        RAISE EXCEPTION 'Data checksums are not enabled';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_hba_file_rules WHERE error IS NOT NULL) THEN
        RAISE EXCEPTION 'pg_hba.conf contains one or more parsing errors';
    END IF;

    SELECT count(*)
      INTO active_hba_rows
    FROM pg_hba_file_rules
    WHERE error IS NULL;

    IF active_hba_rows <> 3 THEN
        RAISE EXCEPTION
            'Expected exactly three active local-development HBA rules; found %',
            active_hba_rows;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_hba_file_rules
        WHERE error IS NULL
          AND NOT (
              (
                  type = 'local'
                  AND database = ARRAY['all']::text[]
                  AND user_name = ARRAY['all']::text[]
                  AND address IS NULL
                  AND netmask IS NULL
                  AND auth_method = 'scram-sha-256'
                  AND (options IS NULL OR cardinality(options) = 0)
              )
              OR
              (
                  type = 'host'
                  AND database = ARRAY['all']::text[]
                  AND user_name = ARRAY['all']::text[]
                  AND (
                      (address = '127.0.0.1' AND netmask = '255.255.255.255')
                      OR
                      (
                          address = '::1'
                          AND netmask = 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'
                      )
                  )
                  AND auth_method = 'scram-sha-256'
                  AND (options IS NULL OR cardinality(options) = 0)
              )
          )
    ) THEN
        RAISE EXCEPTION
            'HBA contains an active rule outside the approved local SCRAM set';
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
        RAISE EXCEPTION
            'The owner role % is missing or has unsafe attributes',
            owner_role_name;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_database
        WHERE datname = target_database_name
    ) THEN
        RAISE EXCEPTION
            'Target database % already exists; stop and inspect it',
            target_database_name;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_collation
        WHERE collprovider = 'b'
          AND colllocale = 'PG_UNICODE_FAST'
          AND pg_encoding_to_char(collencoding) = 'UTF8'
          AND collisdeterministic
    ) THEN
        RAISE EXCEPTION
            'Built-in deterministic PG_UNICODE_FAST UTF8 collation is unavailable';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_authid
        WHERE rolname = ANY (capability_roles)
          AND (
              rolcanlogin
              OR rolsuper
              OR rolcreatedb
              OR rolcreaterole
              OR rolreplication
              OR rolbypassrls
              OR rolpassword IS NOT NULL
          )
    ) THEN
        RAISE EXCEPTION
            'An existing Dhumi capability role has unsafe attributes';
    END IF;

    -- Capability roles may not themselves inherit or SET ROLE to anything.
    IF EXISTS (
        SELECT 1
        FROM pg_auth_members membership
        JOIN pg_roles member_role ON member_role.oid = membership.member
        WHERE member_role.rolname = ANY (capability_roles)
    ) THEN
        RAISE EXCEPTION
            'An existing Dhumi capability role has an unexpected membership';
    END IF;

    -- Permit only the exact restricted runtime LOGIN membership shape created
    -- by 0004. This keeps preflight usable when another local environment is
    -- prepared after test/dev LOGIN roles already exist in the cluster.
    IF EXISTS (
        SELECT 1
        FROM pg_auth_members membership
        JOIN pg_authid member_role ON member_role.oid = membership.member
        JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
        WHERE granted_role.rolname = ANY (capability_roles)
          AND NOT (
              granted_role.rolname IN (
                  'dhumi_identity',
                  'dhumi_customer_api',
                  'dhumi_envelope_janitor',
                  'dhumi_admission',
                  'dhumi_operator',
                  'dhumi_result_recorder'
              )
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
              AND (
                  (granted_role.rolname = 'dhumi_identity'
                   AND member_role.rolname ~ '^dhumi_[a-z0-9_]+_identity_login$')
                  OR
                  (granted_role.rolname = 'dhumi_customer_api'
                   AND member_role.rolname ~ '^dhumi_[a-z0-9_]+_customer_api_login$')
                  OR
                  (granted_role.rolname = 'dhumi_envelope_janitor'
                   AND member_role.rolname ~ '^dhumi_[a-z0-9_]+_envelope_janitor_login$')
                  OR
                  (granted_role.rolname = 'dhumi_admission'
                   AND member_role.rolname ~ '^dhumi_[a-z0-9_]+_admission_login$')
                  OR
                  (granted_role.rolname = 'dhumi_operator'
                   AND member_role.rolname ~ '^dhumi_[a-z0-9_]+_operator_login$')
                  OR
                  (granted_role.rolname = 'dhumi_result_recorder'
                   AND member_role.rolname ~ '^dhumi_[a-z0-9_]+_result_recorder_login$')
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM pg_auth_members other_membership
                  WHERE other_membership.member = member_role.oid
                    AND other_membership.oid <> membership.oid
              )
          )
    ) THEN
        RAISE EXCEPTION
            'An existing Dhumi capability role has an unsafe or unapproved runtime member';
    END IF;

    RAISE NOTICE
        'PASS: cluster preflight succeeded for database % and owner %',
        target_database_name,
        owner_role_name;
END
$preflight$;

SELECT
    current_setting('server_version') AS server_version,
    current_setting('listen_addresses') AS listen_addresses,
    current_setting('password_encryption') AS password_encryption,
    current_setting('data_checksums') AS data_checksums,
    current_database() AS administrative_database,
    current_user AS administrative_user;

SELECT
    rule_number,
    line_number,
    type,
    database,
    user_name,
    address,
    netmask,
    auth_method,
    options,
    error
FROM pg_hba_file_rules
ORDER BY line_number;
