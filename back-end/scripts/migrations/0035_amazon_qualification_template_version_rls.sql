-- Pattern 7 draft Template-version RLS correction.
--
-- The qualification resolver is SECURITY DEFINER-owned by dhumi_owner, while
-- service_template_versions uses FORCE ROW LEVEL SECURITY. Permit that owner
-- to see only the pending Amazon v1 definitions staged on the disabled Pattern
-- 6 adapter. Runtime operator roles receive no direct table SELECT grant.

SET ROLE dhumi_owner;

CREATE POLICY service_template_versions_amazon_qualification_definer_select
  ON app.service_template_versions
  FOR SELECT
  TO dhumi_owner
  USING (
    version = 1
    AND effective_at IS NULL
    AND published_at IS NULL
    AND availability_state = 'coming_soon'
    AND EXISTS (
      SELECT 1
      FROM app.launch_evidence AS evidence
      WHERE evidence.id = launch_evidence_id
        AND evidence.scope_type = 'service_template_version'
        AND evidence.scope_key ~ '^amazon\.[a-z0-9_.]{3,120}:1$'
        AND evidence.state = 'pending'
    )
    AND EXISTS (
      SELECT 1
      FROM app.adapter_versions AS adapter
      JOIN app.adapter_definitions AS definition
        ON definition.id = adapter.adapter_definition_id
      WHERE adapter.id = adapter_version_id
        AND definition.code = 'bright_data.amazon.scraper_library'
        AND adapter.semantic_version = '1.0.0-pattern6'
        AND adapter.state = 'disabled'
    )
  );

RESET ROLE;
