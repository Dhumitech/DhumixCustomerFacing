-- Demo Production Phase 1 application-schema foundation.
--
-- Cluster roles, the database and the empty app schema are prepared manually
-- by scripts/bootstrap. This migration fails closed instead of creating or
-- repairing those security boundaries. PostgreSQL 18 provides
-- gen_random_uuid() in core, so no pgcrypto extension is required here.

DO $$
DECLARE
  role_name text;
BEGIN
  IF current_database() = 'postgres' THEN
    RAISE EXCEPTION 'Refusing to install the Dhumi schema in the postgres database';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_database
    WHERE datname = current_database()
      AND pg_get_userbyid(datdba) = 'dhumi_owner'
  ) THEN
    RAISE EXCEPTION 'Current database is not owned by dhumi_owner';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.schemata
    WHERE schema_name = 'app'
      AND schema_owner = 'dhumi_owner'
  ) THEN
    RAISE EXCEPTION 'Schema app is missing or is not owned by dhumi_owner';
  END IF;

  FOREACH role_name IN ARRAY ARRAY[
    'dhumi_customer_api',
    'dhumi_identity',
    'dhumi_admission',
    'dhumi_job_manager',
    'dhumi_result_recorder',
    'dhumi_outbox_dispatcher',
    'dhumi_operator'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_roles
      WHERE rolname = role_name
        AND NOT rolcanlogin
        AND NOT rolsuper
        AND NOT rolcreatedb
        AND NOT rolcreaterole
        AND NOT rolreplication
        AND NOT rolbypassrls
    ) THEN
      RAISE EXCEPTION 'Required capability role % is missing or unsafe', role_name;
    END IF;
  END LOOP;
END;
$$;

SET ROLE dhumi_owner;

CREATE TABLE IF NOT EXISTS app.schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  checksum text NOT NULL
);

-- The API resolves a tenant before opening a transaction, then calls
-- SET LOCAL app.tenant_id = '<uuid>'. An unset context deliberately resolves
-- to NULL, making every tenant RLS policy return zero rows.
CREATE OR REPLACE FUNCTION app.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION app.require_tenant_context()
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  tenant_id uuid;
BEGIN
  tenant_id := app.current_tenant_id();
  IF tenant_id IS NULL THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_REQUIRED'
      USING ERRCODE = '42501';
  END IF;
  RETURN tenant_id;
END;
$$;

CREATE OR REPLACE FUNCTION app.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.current_tenant_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.require_tenant_context() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.touch_updated_at() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.current_tenant_id() TO
  dhumi_customer_api,
  dhumi_identity,
  dhumi_admission,
  dhumi_job_manager,
  dhumi_result_recorder,
  dhumi_outbox_dispatcher,
  dhumi_operator;
GRANT EXECUTE ON FUNCTION app.require_tenant_context() TO
  dhumi_customer_api,
  dhumi_admission,
  dhumi_job_manager,
  dhumi_result_recorder;

RESET ROLE;
