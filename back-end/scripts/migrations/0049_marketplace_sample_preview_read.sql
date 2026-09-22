-- M4: authenticated, zero-provider-call LinkedIn Posts stored-sample preview.
--
-- This projection intentionally exposes only the governed synthetic Posts
-- sample and its two verified fields. It does not expose LinkedIn People,
-- provider Dataset IDs, evidence/object keys, downloads, purchase,
-- entitlement, Search, Filter, Services, Runs, or provider execution.

SET ROLE dhumi_owner;

CREATE FUNCTION app.resolve_marketplace_sample_preview(
  p_template_slug text,
  p_as_of timestamptz
)
RETURNS TABLE (
  template_id uuid,
  template_slug text,
  template_version integer,
  public_name text,
  public_description text,
  presentation_metadata jsonb,
  configuration_schema jsonb,
  input_schema jsonb,
  provider_record_count bigint,
  provider_record_count_as_of timestamptz,
  sample_version integer,
  sample_record_count integer,
  sample_byte_count bigint,
  sample_checksum_hex text,
  sample_object_key text,
  collected_at timestamptz,
  expires_at timestamptz,
  fields jsonb
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT
    template.id,
    template.slug,
    version.version,
    version.public_name,
    'Preview a governed synthetic LinkedIn Posts sample before purchase.'::text,
    version.presentation_metadata,
    version.configuration_schema,
    version.input_schema,
    candidate.provider_record_count,
    candidate.metadata_observed_at,
    sample.sample_version,
    sample.record_count,
    sample.byte_count,
    encode(sample.checksum, 'hex'),
    sample.object_key,
    sample.collected_at,
    sample.expires_at,
    jsonb_build_array(
      jsonb_build_object(
        'name', 'url',
        'type', 'url',
        'active', true,
        'required', true,
        'description', 'LinkedIn post URL',
        'sample_visibility', 'visible',
        'allowed_operators', jsonb_build_array(
          '=', '!=', 'in', 'not_in', 'includes', 'not_includes',
          'is_null', 'is_not_null'
        )
      ),
      jsonb_build_object(
        'name', 'text',
        'type', 'text',
        'active', true,
        'required', false,
        'description', 'LinkedIn post text',
        'sample_visibility', 'masked',
        'allowed_operators', jsonb_build_array(
          '=', '!=', 'in', 'not_in', 'includes', 'not_includes',
          'is_null', 'is_not_null'
        )
      )
    )
  FROM app.service_templates AS template
  JOIN app.service_template_versions AS version
    ON version.service_template_id = template.id
  JOIN app.catalog_candidates AS candidate
    ON candidate.service_template_version_id = version.id
  JOIN LATERAL (
    SELECT stored.*
    FROM app.marketplace_sample_versions AS stored
    WHERE stored.service_template_version_id = version.id
      AND stored.source_kind = 'synthetic_fixture'
      AND stored.state = 'validated_fixture'
      AND stored.rights_evidence_reference IS NULL
      AND stored.published_at IS NULL
      AND stored.source_metadata_checksum = candidate.metadata_checksum
      AND stored.masking_policy_version =
        'linkedin-posts-provider-mask-preservation-v1'
      AND stored.retention_policy_version = 'linkedin-posts-sample-30d-v1'
      AND stored.collected_at <= p_as_of
      AND stored.expires_at > p_as_of
      AND NOT EXISTS (
        SELECT 1
        FROM app.marketplace_sample_deletions AS deletion
        WHERE deletion.sample_version_id = stored.id
      )
    ORDER BY stored.sample_version DESC, stored.id ASC
    LIMIT 1
  ) AS sample ON true
  JOIN app.adapter_versions AS adapter
    ON adapter.id = version.adapter_version_id
  JOIN app.adapter_definitions AS definition
    ON definition.id = adapter.adapter_definition_id
  WHERE (p_template_slug IS NULL OR p_template_slug = 'linkedin-posts')
    AND p_as_of IS NOT NULL
    AND template.slug = 'linkedin-posts'
    AND template.product_family = 'marketplace_dataset'
    AND template.state = 'draft'
    AND template.current_public_version_id IS NULL
    AND version.version = 1
    AND version.availability_state = 'coming_soon'
    AND version.effective_at IS NULL
    AND version.published_at IS NULL
    AND candidate.resource_code = 'linkedin.posts'
    AND candidate.review_state = 'approved'
    AND candidate.metadata_checksum IS NOT NULL
    AND octet_length(candidate.metadata_checksum) = 32
    AND definition.code = 'bright_data.marketplace.catalogue'
    AND adapter.semantic_version = '1.0.0-m2'
    AND adapter.state = 'disabled'
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION app.resolve_marketplace_sample_preview(text, timestamptz)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_marketplace_sample_preview(text, timestamptz)
  TO dhumi_customer_api;

RESET ROLE;
