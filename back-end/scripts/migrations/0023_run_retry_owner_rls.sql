-- Complete the forced-RLS owner path required by retry lineage validation.
--
-- This migration intentionally does not change retry semantics, grant direct
-- source-input or Attempt reads, weaken Tenant isolation, bypass RLS, modify
-- migrations 0001-0022, provision roles, backfill data, or call a provider.

SET ROLE dhumi_owner;

-- Retry security-definer functions resolve a Run's logical Service through
-- service_versions. FORCE RLS must therefore admit their NOLOGIN owner only
-- under the same required transaction-local Tenant context as runtime roles.
DROP POLICY service_versions_tenant_isolation ON app.service_versions;
CREATE POLICY service_versions_tenant_isolation ON app.service_versions
  FOR ALL TO dhumi_customer_api, dhumi_admission, dhumi_job_manager,
    dhumi_result_recorder, dhumi_owner
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

RESET ROLE;
