\set ON_ERROR_STOP on

-- Cluster-level role bootstrap. Role names are architecture constants, not
-- environment configuration. Existing roles are accepted only when their
-- security attributes are exact. The only permitted inbound memberships are
-- restricted, single-capability runtime LOGIN roles created by 0004/0005/0006.

BEGIN;

DO $roles$
DECLARE
    role_name text;
    existing_role record;
BEGIN
    IF current_database() <> 'postgres' THEN
        RAISE EXCEPTION
            'Connect to the postgres administrative database, not %',
            current_database();
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_roles
        WHERE rolname = current_user
          AND rolsuper
          AND rolcreaterole
    ) THEN
        RAISE EXCEPTION
            'Current role % cannot perform the cluster role bootstrap',
            current_user;
    END IF;

    FOREACH role_name IN ARRAY ARRAY[
        'dhumi_customer_api',
        'dhumi_identity',
        'dhumi_admission',
        'dhumi_job_manager',
        'dhumi_result_recorder',
        'dhumi_outbox_dispatcher',
        'dhumi_envelope_janitor',
        'dhumi_operator'
    ]
    LOOP
        SELECT *
          INTO existing_role
        FROM pg_roles
        WHERE rolname = role_name;

        IF FOUND THEN
            IF existing_role.rolcanlogin
               OR existing_role.rolsuper
               OR existing_role.rolcreatedb
               OR existing_role.rolcreaterole
               OR existing_role.rolreplication
               OR existing_role.rolbypassrls THEN
                RAISE EXCEPTION
                    'Existing role % has unsafe attributes; no automatic repair was attempted',
                    role_name;
            END IF;

            IF EXISTS (
                SELECT 1
                FROM pg_authid
                WHERE rolname = role_name
                  AND rolpassword IS NOT NULL
            ) THEN
                RAISE EXCEPTION
                    'Existing role % unexpectedly has a password; no automatic repair was attempted',
                    role_name;
            END IF;

            -- A capability role must never inherit or SET ROLE to another
            -- role. That would silently widen the module boundary.
            IF EXISTS (
                SELECT 1
                FROM pg_auth_members membership
                WHERE membership.member = existing_role.oid
            ) THEN
                RAISE EXCEPTION
                    'Existing role % has unexpected memberships; no automatic repair was attempted',
                    role_name;
            END IF;

            -- Runtime capabilities may be granted only to a safe NOINHERIT
            -- LOGIN role through the exact approved runtime bootstrap shape.
            -- All other capability roles still require zero inbound members.
            IF EXISTS (
                SELECT 1
                FROM pg_auth_members membership
                JOIN pg_authid member_role ON member_role.oid = membership.member
                WHERE membership.roleid = existing_role.oid
                  AND NOT (
                      role_name IN (
                          'dhumi_identity',
                          'dhumi_customer_api',
                          'dhumi_envelope_janitor',
                          'dhumi_admission',
                          'dhumi_operator',
                          'dhumi_result_recorder',
                          'dhumi_outbox_dispatcher',
                          'dhumi_job_manager'
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
                          (role_name = 'dhumi_identity'
                           AND member_role.rolname ~ '^dhumi_[a-z0-9_]+_identity_login$')
                          OR
                          (role_name = 'dhumi_customer_api'
                           AND member_role.rolname ~ '^dhumi_[a-z0-9_]+_customer_api_login$')
                          OR
                          (role_name = 'dhumi_envelope_janitor'
                           AND member_role.rolname ~ '^dhumi_[a-z0-9_]+_envelope_janitor_login$')
                          OR
                          (role_name = 'dhumi_admission'
                           AND member_role.rolname ~ '^dhumi_[a-z0-9_]+_admission_login$')
                          OR
                          (role_name = 'dhumi_operator'
                           AND member_role.rolname ~ '^dhumi_[a-z0-9_]+_operator_login$')
                          OR
                          (role_name = 'dhumi_result_recorder'
                           AND member_role.rolname ~ '^dhumi_[a-z0-9_]+_result_recorder_login$')
                          OR
                          (role_name = 'dhumi_outbox_dispatcher'
                           AND member_role.rolname ~ '^dhumi_[a-z0-9_]+_outbox_dispatcher_login$')
                          OR
                          (role_name = 'dhumi_job_manager'
                           AND member_role.rolname ~ '^dhumi_[a-z0-9_]+_job_manager_login$')
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
                    'Existing role % has an unsafe or unapproved runtime member; no automatic repair was attempted',
                    role_name;
            END IF;

            RAISE NOTICE 'Role % already exists with the approved state', role_name;
        ELSE
            EXECUTE format(
                'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
                role_name
            );
        END IF;
    END LOOP;
END
$roles$;

COMMIT;

SELECT
    rolname,
    rolcanlogin,
    rolsuper,
    rolcreatedb,
    rolcreaterole,
    rolreplication,
    rolbypassrls
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
