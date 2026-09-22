-- Tenant-safe, integrity-backed read surface for saved Dhumi Services.
--
-- This migration intentionally does not create or backfill a Service, expose
-- stored configuration or provider data, publish catalogue content, call
-- Bright Data, or modify migrations 0001-0014.

SET ROLE dhumi_owner;

-- Public Service lifecycle vocabulary must match the accepted API instead of
-- preserving the superseded archived state from the initial schema draft.
ALTER TABLE app.services
  DROP CONSTRAINT services_state_check,
  ADD CONSTRAINT services_state_check
  CHECK (state IN ('active', 'disabled'));

-- The current pointer must resolve to a version belonging to the same Service
-- and Tenant, including during the deferred two-row creation transaction.
ALTER TABLE app.service_versions
  ADD CONSTRAINT service_versions_tenant_service_version_key
  UNIQUE (tenant_id, service_id, version);

ALTER TABLE app.services
  ADD CONSTRAINT services_current_version_fk
  FOREIGN KEY (tenant_id, id, current_version)
  REFERENCES app.service_versions (tenant_id, service_id, version)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

-- A version pin that belongs to another Template would corrupt the saved
-- Service even if its version number and Tenant were otherwise valid. This
-- check reuses the admission transaction's trusted Tenant RLS context.
CREATE FUNCTION app.validate_service_template_version_pin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, app
AS $$
DECLARE
  parent_template_id uuid;
  pinned_template_id uuid;
BEGIN
  SELECT service.service_template_id
    INTO parent_template_id
  FROM app.services AS service
  WHERE service.tenant_id = NEW.tenant_id
    AND service.id = NEW.service_id;

  SELECT template_version.service_template_id
    INTO pinned_template_id
  FROM app.service_template_versions AS template_version
  WHERE template_version.id = NEW.service_template_version_id;

  IF parent_template_id IS NULL
     OR pinned_template_id IS NULL
     OR parent_template_id IS DISTINCT FROM pinned_template_id THEN
    RAISE EXCEPTION 'SERVICE_TEMPLATE_VERSION_PIN_MISMATCH'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.validate_service_template_version_pin() FROM PUBLIC;

CREATE TRIGGER service_versions_validate_template_pin
  BEFORE INSERT ON app.service_versions
  FOR EACH ROW EXECUTE FUNCTION app.validate_service_template_version_pin();

-- Descending keyset scans need one immutable Tenant-leading access path and
-- must not depend on a mutable lifecycle field.
CREATE INDEX services_tenant_created_id_idx
  ON app.services (tenant_id, created_at DESC, id DESC);

-- A saved Service may outlive catalogue publication, but historical Template
-- identity is visible only through a Service already isolated to this Tenant.
DROP POLICY service_templates_customer_read ON app.service_templates;
CREATE POLICY service_templates_customer_read ON app.service_templates
  FOR SELECT TO dhumi_customer_api
  USING (
    app.current_tenant_id() IS NOT NULL
    AND (
      (
        state IN ('published', 'disabled')
        AND current_public_version_id IS NOT NULL
      )
      OR EXISTS (
        SELECT 1
        FROM app.services AS service
        WHERE service.tenant_id = app.current_tenant_id()
          AND service.service_template_id = service_templates.id
      )
    )
  );

-- Public catalogue versions retain the complete evidence gate from 0013.
-- Superseded versions gain only the narrower path through an owned Service
-- version whose parent Service pins the same Template identity.
DROP POLICY service_template_versions_customer_read
  ON app.service_template_versions;
CREATE POLICY service_template_versions_customer_read
  ON app.service_template_versions
  FOR SELECT TO dhumi_customer_api
  USING (
    app.current_tenant_id() IS NOT NULL
    AND (
      (
        published_at IS NOT NULL
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
      )
      OR EXISTS (
        SELECT 1
        FROM app.service_versions AS service_version
        INNER JOIN app.services AS service
          ON service.tenant_id = service_version.tenant_id
         AND service.id = service_version.service_id
        WHERE service_version.tenant_id = app.current_tenant_id()
          AND service_version.service_template_version_id =
            service_template_versions.id
          AND service.service_template_id =
            service_template_versions.service_template_id
      )
    )
  );

-- The customer runtime can assemble only public Service metadata. Stored
-- configuration, schema hashes, creator identity and internal timestamps stay
-- outside this operation's database capability.
REVOKE SELECT ON app.services FROM dhumi_customer_api;
REVOKE SELECT ON app.service_versions FROM dhumi_customer_api;

GRANT SELECT (
  id,
  tenant_id,
  service_template_id,
  name,
  state,
  current_version,
  created_at
) ON app.services TO dhumi_customer_api;

GRANT SELECT (
  tenant_id,
  service_id,
  version,
  service_template_version_id
) ON app.service_versions TO dhumi_customer_api;

RESET ROLE;
