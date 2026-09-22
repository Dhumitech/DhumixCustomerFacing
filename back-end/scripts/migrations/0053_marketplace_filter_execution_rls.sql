-- Permit the Marketplace execution SECURITY DEFINER to resolve only the
-- customer-disabled LinkedIn Posts fixture route introduced by migration 0052.
--
-- FORCE RLS applies to both catalogue tables. Without these policies the
-- function owner cannot follow the immutable Run -> Template-version pin,
-- even though the adapter, mapping and credential are all disabled/offline.
-- This migration creates no public Template, mapping, Service, Run, LOGIN,
-- entitlement or provider request capability.

SET ROLE dhumi_owner;

CREATE POLICY service_templates_marketplace_filter_fixture_definer_select
  ON app.service_templates
  FOR SELECT
  TO dhumi_owner
  USING (
    product_family = 'marketplace_dataset'
    AND slug = 'linkedin-posts'
    AND state = 'draft'
    AND current_public_version_id IS NULL
  );

CREATE POLICY service_template_versions_m8_fixture_owner_select
  ON app.service_template_versions
  FOR SELECT
  TO dhumi_owner
  USING (
    availability_state = 'coming_soon'
    AND effective_at IS NOT NULL
    AND effective_at <= statement_timestamp()
    AND published_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM app.launch_evidence AS evidence
      WHERE evidence.id = launch_evidence_id
        AND evidence.state = 'approved'
        AND evidence.effective_at IS NOT NULL
        AND evidence.effective_at <= statement_timestamp()
        AND evidence.approved_at IS NOT NULL
    )
    AND EXISTS (
      SELECT 1
      FROM app.service_templates AS template
      WHERE template.id = service_template_id
        AND template.product_family = 'marketplace_dataset'
        AND template.slug = 'linkedin-posts'
        AND template.state = 'draft'
        AND template.current_public_version_id IS NULL
    )
    AND EXISTS (
      SELECT 1
      FROM app.adapter_versions AS adapter
      JOIN app.adapter_definitions AS definition
        ON definition.id = adapter.adapter_definition_id
      WHERE adapter.id = adapter_version_id
        AND adapter.semantic_version = '1.0.0-m7-fixture'
        AND adapter.state = 'disabled'
        AND adapter.capability_metadata @> '{
          "transport":"fixture",
          "provider_http_enabled":false,
          "customer_visible":false,
          "can_execute":false
        }'::jsonb
        AND definition.code = 'bright_data.marketplace.filter'
        AND definition.product_family = 'marketplace_dataset'
    )
  );

-- The observation functions run as the NOLOGIN owner. Admit only the current
-- Tenant's Marketplace cost holds; the runtime role still has no direct
-- mutation capability because migration 0052 grants EXECUTE only.
CREATE POLICY provider_cost_holds_marketplace_execution_definer
  ON app.provider_cost_holds
  FOR ALL
  TO dhumi_owner
  USING (
    tenant_id = app.current_tenant_id()
    AND provider_code = 'bright_data'
    AND product_family = 'marketplace_dataset'
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND provider_code = 'bright_data'
    AND product_family = 'marketplace_dataset'
  );

CREATE POLICY audit_events_marketplace_execution_definer_insert
  ON app.audit_events
  FOR INSERT
  TO dhumi_owner
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND target_type = 'run_attempt'
    AND target_id IS NOT NULL
    AND (
      (
        action = 'provider.marketplace_snapshot.observe'
        AND outcome IN ('ready', 'failed')
      )
      OR
      (
        action = 'provider.marketplace_filter.reject'
        AND outcome = 'rejected'
      )
    )
  );

RESET ROLE;
