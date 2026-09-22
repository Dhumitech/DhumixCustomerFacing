-- Current, evidence-aware, least-privilege read surface for the public Dhumi catalogue.
--
-- This migration intentionally does not publish or backfill a Template, define
-- the operator publication command, expose provider mappings or evidence
-- references, call Bright Data, or change migrations 0001-0012.

SET ROLE dhumi_owner;

-- Publication must move one explicit pointer instead of making every historic
-- timestamped version customer-visible.
ALTER TABLE app.service_templates
  ADD COLUMN current_public_version_id uuid;

-- The composite target proves that a Template can point only to one of its own
-- immutable versions, even when publication inserts and points in one transaction.
ALTER TABLE app.service_template_versions
  ADD CONSTRAINT service_template_versions_template_id_id_key
  UNIQUE (service_template_id, id);

ALTER TABLE app.service_templates
  ADD CONSTRAINT service_templates_current_public_version_fk
  FOREIGN KEY (id, current_public_version_id)
  REFERENCES app.service_template_versions (service_template_id, id)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

-- A customer-visible lifecycle state without a selected version is ambiguous
-- and must fail before a public read can observe it.
ALTER TABLE app.service_templates
  ADD CONSTRAINT service_templates_public_pointer_check
  CHECK (
    state NOT IN ('published', 'disabled')
    OR current_public_version_id IS NOT NULL
  );

-- Availability is public versioned state. Human availability copy remains a
-- separate internal field and is never reinterpreted as this enum.
ALTER TABLE app.service_template_versions
  ADD COLUMN availability_state text NOT NULL,
  ADD CONSTRAINT service_template_versions_availability_state_check
  CHECK (
    availability_state IN ('available', 'temporarily_unavailable', 'coming_soon')
  );

-- Public traversal is stable across version publication because the cursor is
-- anchored to immutable Template identity rather than mutable lifecycle fields.
CREATE INDEX service_templates_public_list_idx
  ON app.service_templates (product_family, slug, id)
  WHERE state IN ('published', 'disabled')
    AND current_public_version_id IS NOT NULL;

-- Template identity is readable only when its lifecycle has a selected public
-- version. The version policy below supplies the stronger publication and
-- evidence checks without creating mutually recursive RLS policies.
DROP POLICY service_templates_customer_read ON app.service_templates;
CREATE POLICY service_templates_customer_read ON app.service_templates
  FOR SELECT TO dhumi_customer_api
  USING (
    app.current_tenant_id() IS NOT NULL
    AND state IN ('published', 'disabled')
    AND current_public_version_id IS NOT NULL
  );

-- Historical, future and invalid-evidence versions fail closed. The parent
-- lookup is itself constrained by the simple Template policy above, so only
-- the selected version of a currently public lifecycle is readable.
DROP POLICY service_template_versions_customer_read ON app.service_template_versions;
CREATE POLICY service_template_versions_customer_read ON app.service_template_versions
  FOR SELECT TO dhumi_customer_api
  USING (
    app.current_tenant_id() IS NOT NULL
    AND published_at IS NOT NULL
    AND published_at <= statement_timestamp()
    AND effective_at IS NOT NULL
    AND effective_at <= statement_timestamp()
    AND EXISTS (
      SELECT 1
      FROM app.service_templates AS template
      WHERE template.id = service_template_versions.service_template_id
        AND template.current_public_version_id = service_template_versions.id
        AND template.state IN ('published', 'disabled')
    )
    AND EXISTS (
      SELECT 1
      FROM app.launch_evidence AS evidence
      WHERE evidence.id = service_template_versions.launch_evidence_id
        AND evidence.state = 'approved'
        AND evidence.effective_at IS NOT NULL
        AND evidence.effective_at <= statement_timestamp()
        AND (
          evidence.expires_at IS NULL
          OR evidence.expires_at > statement_timestamp()
        )
    )
  );

-- Customer code needs only the public projection and the minimum join/evidence
-- fields required to make the fail-closed policy evaluable. Adapter IDs,
-- output schemas, restricted evidence, hashes and approval identities stay out.
REVOKE SELECT ON app.service_templates FROM dhumi_customer_api;
REVOKE SELECT ON app.service_template_versions FROM dhumi_customer_api;
REVOKE SELECT ON app.launch_evidence FROM dhumi_customer_api;

GRANT SELECT (
  id,
  slug,
  product_family,
  state,
  current_public_version_id
) ON app.service_templates TO dhumi_customer_api;

GRANT SELECT (
  id,
  service_template_id,
  version,
  public_name,
  public_description,
  input_schema,
  availability_state,
  launch_evidence_id,
  effective_at,
  published_at
) ON app.service_template_versions TO dhumi_customer_api;

GRANT SELECT (
  id,
  state,
  effective_at,
  expires_at
) ON app.launch_evidence TO dhumi_customer_api;

RESET ROLE;
