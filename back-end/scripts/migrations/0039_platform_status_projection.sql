-- Pattern 8 Priority 3: anonymous customer-safe platform/product status.
--
-- The public read is a stored release projection. It does not probe Bright
-- Data or any queue, lease, storage, Vault or worker dependency. The existing
-- customer API capability receives only the three safe output columns.

SET ROLE dhumi_owner;

-- These two catalogue tables use FORCE ROW LEVEL SECURITY. The definer may
-- inspect only a selected public lifecycle and its selected version; draft,
-- retired and historical versions remain invisible to this function owner.
CREATE POLICY service_templates_platform_status_definer_select
  ON app.service_templates
  FOR SELECT
  TO dhumi_owner
  USING (
    state IN ('published', 'disabled')
    AND current_public_version_id IS NOT NULL
  );

CREATE POLICY service_template_versions_platform_status_definer_select
  ON app.service_template_versions
  FOR SELECT
  TO dhumi_owner
  USING (
    EXISTS (
      SELECT 1
      FROM app.service_templates AS template
      WHERE template.id = service_template_id
        AND template.current_public_version_id = service_template_versions.id
        AND template.state IN ('published', 'disabled')
    )
  );

CREATE FUNCTION app.get_platform_status(p_environment text)
RETURNS TABLE (
  family text,
  state text,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  evaluated_at timestamptz := statement_timestamp();
BEGIN
  IF p_environment IS NULL
     OR p_environment NOT IN ('local', 'test', 'staging', 'production') THEN
    RAISE EXCEPTION 'PLATFORM_STATUS_ENVIRONMENT_INVALID'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH product_families(ordinal, product_family) AS (
    VALUES
      (1, 'scraper_library'::text),
      (2, 'marketplace_dataset'::text)
  ), release_counts AS (
    SELECT
      product.product_family,
      COUNT(template.id)::bigint AS selected_count,
      COUNT(template.id) FILTER (
        WHERE template.state = 'published'
          AND version.availability_state = 'available'
          AND version.published_at IS NOT NULL
          AND version.published_at <= evaluated_at
          AND version.effective_at IS NOT NULL
          AND version.effective_at <= evaluated_at
          AND EXISTS (
            SELECT 1
            FROM app.launch_evidence AS template_evidence
            WHERE template_evidence.id = version.launch_evidence_id
              AND template_evidence.state = 'approved'
              AND template_evidence.effective_at IS NOT NULL
              AND template_evidence.effective_at <= evaluated_at
              AND (
                template_evidence.expires_at IS NULL
                OR template_evidence.expires_at > evaluated_at
              )
          )
          AND EXISTS (
            SELECT 1
            FROM app.adapter_versions AS adapter
            WHERE adapter.id = version.adapter_version_id
              AND adapter.state = 'enabled'
          )
          AND EXISTS (
            SELECT 1
            FROM app.provider_mappings AS mapping
            JOIN app.provider_credentials AS credential
              ON credential.id = mapping.provider_credential_id
             AND credential.environment = mapping.environment
            JOIN app.launch_evidence AS mapping_evidence
              ON mapping_evidence.id = mapping.launch_evidence_id
            WHERE mapping.service_template_version_id = version.id
              AND mapping.adapter_version_id = version.adapter_version_id
              AND mapping.environment = p_environment
              AND mapping.state = 'enabled'
              AND mapping_evidence.state = 'approved'
              AND mapping_evidence.effective_at IS NOT NULL
              AND mapping_evidence.effective_at <= evaluated_at
              AND (
                mapping_evidence.expires_at IS NULL
                OR mapping_evidence.expires_at > evaluated_at
              )
              AND credential.state = 'active'
              AND credential.activated_at IS NOT NULL
              AND credential.activated_at <= evaluated_at
              AND (
                credential.expires_at IS NULL
                OR credential.expires_at > evaluated_at
              )
              AND credential.retired_at IS NULL
          )
      )::bigint AS executable_count
    FROM product_families AS product
    LEFT JOIN app.service_templates AS template
      ON template.product_family = product.product_family
     AND template.state IN ('published', 'disabled')
     AND template.current_public_version_id IS NOT NULL
    LEFT JOIN app.service_template_versions AS version
      ON version.id = template.current_public_version_id
     AND version.service_template_id = template.id
    GROUP BY product.product_family
  ), evaluated_products AS (
    SELECT
      product.ordinal,
      product.product_family,
      CASE
        WHEN NOT EXISTS (
          SELECT 1
          FROM app.feature_flags AS feature
          JOIN app.launch_evidence AS feature_evidence
            ON feature_evidence.id = feature.launch_evidence_id
          WHERE feature.feature_code = product.product_family
            AND feature.environment = p_environment
            AND feature.state = 'enabled'
            AND (feature.expires_at IS NULL OR feature.expires_at > evaluated_at)
            AND feature_evidence.state = 'approved'
            AND feature_evidence.effective_at IS NOT NULL
            AND feature_evidence.effective_at <= evaluated_at
            AND (
              feature_evidence.expires_at IS NULL
              OR feature_evidence.expires_at > evaluated_at
            )
        ) THEN 'not_enabled'
        WHEN counts.selected_count = 0 OR counts.executable_count = 0
          THEN 'unavailable'
        WHEN counts.executable_count < counts.selected_count
          THEN 'degraded'
        ELSE 'operational'
      END AS product_state
    FROM product_families AS product
    JOIN release_counts AS counts
      ON counts.product_family = product.product_family
  )
  SELECT
    product.product_family,
    product.product_state,
    evaluated_at
  FROM evaluated_products AS product
  ORDER BY product.ordinal;
END;
$$;

REVOKE ALL ON FUNCTION app.get_platform_status(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.get_platform_status(text) TO dhumi_customer_api;

RESET ROLE;
