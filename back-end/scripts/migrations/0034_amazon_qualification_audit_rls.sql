-- Pattern 7 audit RLS correction.
--
-- Migration 0033's SECURITY DEFINER functions are owned by dhumi_owner. The
-- audit table uses FORCE ROW LEVEL SECURITY, so its owner still requires an
-- explicit policy. Keep that policy tenantless and limited to the exact
-- provider-qualification actions/targets emitted by those functions. This
-- grants no runtime role direct INSERT access and creates no role or LOGIN.

SET ROLE dhumi_owner;

CREATE POLICY audit_events_amazon_qualification_definer_insert
  ON app.audit_events
  FOR INSERT
  TO dhumi_owner
  WITH CHECK (
    tenant_id IS NULL
    AND actor_user_id IS NULL
    AND actor_api_key_id IS NULL
    AND request_id IS NULL
    AND ip_fingerprint IS NULL
    AND target_id IS NOT NULL
    AND (
      (
        action IN (
          'provider.catalog_import.begin',
          'provider.catalog_import.complete',
          'provider.catalog_import.fail'
        )
        AND target_type = 'catalog_import'
      )
      OR (
        action = 'provider.catalog_candidate.review'
        AND target_type = 'catalog_candidate'
      )
      OR (
        action IN (
          'provider.qualification.begin',
          'provider.qualification.complete',
          'provider.qualification.accept',
          'provider.qualification.reject'
        )
        AND target_type = 'provider_qualification'
      )
    )
  );

RESET ROLE;
