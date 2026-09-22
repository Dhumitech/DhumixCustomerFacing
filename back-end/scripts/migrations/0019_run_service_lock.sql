-- Least-privilege Service row locking for POST /v1/services/{id}/runs.
--
-- This migration intentionally does not widen Admission UPDATE privileges,
-- alter Run evidence, call Bright Data, seed data, provision a LOGIN role, or
-- modify the already-ledgered migrations 0001-0018.

SET ROLE dhumi_owner;

-- The NOLOGIN owner executes only reviewed security-definer database
-- boundaries. FORCE RLS therefore admits it solely when a trusted transaction-
-- local Tenant context is present, matching the corrected Run policies.
DROP POLICY services_tenant_isolation ON app.services;
CREATE POLICY services_tenant_isolation ON app.services
  FOR ALL TO dhumi_customer_api, dhumi_admission, dhumi_job_manager,
    dhumi_result_recorder, dhumi_owner
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- Admission needs a row lock so Service disable/version changes cannot race a
-- Run snapshot, but it must not receive UPDATE on any Service column. The
-- function reveals only whether the owned row was locked.
CREATE FUNCTION app.lock_service_for_run(p_service_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  resolved_tenant_id uuid;
BEGIN
  resolved_tenant_id := app.require_tenant_context();

  PERFORM 1
  FROM app.services AS service
  WHERE service.tenant_id = resolved_tenant_id
    AND service.id = p_service_id
  FOR UPDATE;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION app.lock_service_for_run(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_service_for_run(uuid) TO dhumi_admission;

RESET ROLE;
