-- Pattern 6: stage the complete Amazon operation registry as immutable draft
-- catalogue data. Real provider resources and activation evidence belong to
-- the separate qualification pattern and are deliberately absent here.

SET ROLE dhumi_owner;

CREATE TEMP TABLE pattern6_amazon_registry (
  operation_code text PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  public_name text NOT NULL,
  operation_group text NOT NULL,
  operation_name text NOT NULL,
  display_priority integer UNIQUE NOT NULL,
  input_schema jsonb NOT NULL
) ON COMMIT DROP;

INSERT INTO pattern6_amazon_registry (
  operation_code,
  slug,
  public_name,
  operation_group,
  operation_name,
  display_priority,
  input_schema
) VALUES
  (
    'amazon.products.collect_by_url',
    'amazon-products-collect-by-url',
    'Amazon products — Collect by URL',
    'Amazon products', 'Collect by URL', 100,
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"urn:dhumi:schema:amazon:products:collect-by-url:input:v1","type":"object","additionalProperties":false,"required":["targets"],"properties":{"targets":{"type":"array","minItems":1,"maxItems":20,"items":{"type":"object","additionalProperties":false,"required":["url"],"properties":{"url":{"type":"string","format":"uri"},"zipcode":{"type":"string"},"language":{"type":"string"},"all_variations":{"type":"boolean"}}}}}}'::jsonb
  ),
  (
    'amazon.products_global.collect_by_url',
    'amazon-products-global-collect-by-url',
    'Amazon products global — Collect by URL',
    'Amazon products global', 'Collect by URL', 200,
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"urn:dhumi:schema:amazon:products-global:collect-by-url:input:v1","type":"object","additionalProperties":false,"required":["targets"],"properties":{"targets":{"type":"array","minItems":1,"maxItems":20,"items":{"type":"object","additionalProperties":false,"required":["url"],"properties":{"url":{"type":"string","format":"uri"},"bought_past_month":{"type":"number"}}}}}}'::jsonb
  ),
  (
    'amazon.products_search.collect_by_url',
    'amazon-products-search-collect-by-url',
    'Amazon products search — Collect by URL',
    'Amazon products search', 'Collect by URL', 300,
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"urn:dhumi:schema:amazon:products-search:collect-by-url:input:v1","type":"object","additionalProperties":false,"required":["targets"],"properties":{"targets":{"type":"array","minItems":1,"maxItems":20,"items":{"type":"object","additionalProperties":false,"required":["keyword","url"],"properties":{"keyword":{"type":"string","minLength":1},"url":{"type":"string","format":"uri"},"pages_to_search":{"type":"number"}}}}}}'::jsonb
  ),
  (
    'amazon.reviews.collect_by_url',
    'amazon-reviews-collect-by-url',
    'Amazon reviews — Collect by URL',
    'Amazon reviews', 'Collect by URL', 400,
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"urn:dhumi:schema:amazon:reviews:collect-by-url:input:v1","type":"object","additionalProperties":false,"required":["targets"],"properties":{"targets":{"type":"array","minItems":1,"maxItems":20,"items":{"type":"object","additionalProperties":false,"required":["url"],"properties":{"url":{"type":"string","format":"uri"},"reviews_to_not_include":{"type":"array","items":{"type":"string"}}}}}}}'::jsonb
  ),
  (
    'amazon.sellers.collect_by_url',
    'amazon-sellers-info-collect-by-url',
    'Amazon sellers info — Collect by URL',
    'Amazon sellers info', 'Collect by URL', 500,
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"urn:dhumi:schema:amazon:sellers:collect-by-url:input:v1","type":"object","additionalProperties":false,"required":["targets"],"properties":{"targets":{"type":"array","minItems":1,"maxItems":20,"items":{"type":"object","additionalProperties":false,"required":["url"],"properties":{"url":{"type":"string","format":"uri"}}}}}}'::jsonb
  ),
  (
    'amazon.products_global.discover_by_category_url',
    'amazon-products-global-discover-by-category-url',
    'Amazon products global — Discover by category URL',
    'Amazon products global', 'Discover by category URL', 210,
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"urn:dhumi:schema:amazon:products-global:discover-by-category-url:input:v1","type":"object","additionalProperties":false,"required":["targets"],"properties":{"targets":{"type":"array","minItems":1,"maxItems":20,"items":{"type":"object","additionalProperties":false,"required":["category_url"],"properties":{"category_url":{"type":"string","format":"uri"},"num_of_products":{"type":"number"}}}}}}'::jsonb
  ),
  (
    'amazon.products.discover_by_category_url',
    'amazon-products-discover-by-category-url',
    'Amazon products — Discover by category URL',
    'Amazon products', 'Discover by category URL', 110,
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"urn:dhumi:schema:amazon:products:discover-by-category-url:input:v1","type":"object","additionalProperties":false,"required":["targets"],"properties":{"targets":{"type":"array","minItems":1,"maxItems":20,"items":{"type":"object","additionalProperties":false,"required":["url"],"properties":{"url":{"type":"string","format":"uri"}}}}}}'::jsonb
  ),
  (
    'amazon.products.discover_by_keyword',
    'amazon-products-discover-by-keyword',
    'Amazon products — Discover by keyword',
    'Amazon products', 'Discover by keyword', 120,
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"urn:dhumi:schema:amazon:products:discover-by-keyword:input:v1","type":"object","additionalProperties":false,"required":["targets"],"properties":{"targets":{"type":"array","minItems":1,"maxItems":20,"items":{"type":"object","additionalProperties":false,"required":["keyword"],"properties":{"keyword":{"type":"string","minLength":1},"zipcode":{"type":"string","minLength":1}}}}}}'::jsonb
  ),
  (
    'amazon.products.discover_by_upc',
    'amazon-products-discover-by-upc',
    'Amazon products — Discover by UPC',
    'Amazon products', 'Discover by UPC', 130,
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"urn:dhumi:schema:amazon:products:discover-by-upc:input:v1","type":"object","additionalProperties":false,"required":["targets"],"properties":{"targets":{"type":"array","minItems":1,"maxItems":20,"items":{"type":"object","additionalProperties":false,"required":["upc"],"properties":{"upc":{"type":"string","minLength":1}}}}}}'::jsonb
  ),
  (
    'amazon.products.discover_by_best_sellers_url',
    'amazon-products-discover-by-best-sellers-url',
    'Amazon products — Discover by best sellers URL',
    'Amazon products', 'Discover by best sellers URL', 140,
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"urn:dhumi:schema:amazon:products:discover-by-best-sellers-url:input:v1","type":"object","additionalProperties":false,"required":["targets"],"properties":{"targets":{"type":"array","minItems":1,"maxItems":20,"items":{"type":"object","additionalProperties":false,"required":["url"],"properties":{"url":{"type":"string","format":"uri"}}}}}}'::jsonb
  ),
  (
    'amazon.products_global.discover_by_brand',
    'amazon-products-global-discover-by-brand',
    'Amazon products global — Discover by brand',
    'Amazon products global', 'Discover by brand', 220,
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"urn:dhumi:schema:amazon:products-global:discover-by-brand:input:v1","type":"object","additionalProperties":false,"required":["targets"],"properties":{"targets":{"type":"array","minItems":1,"maxItems":20,"items":{"type":"object","additionalProperties":false,"required":["brand_url"],"properties":{"brand_url":{"type":"string","format":"uri"},"num_of_products":{"type":"number"}}}}}}'::jsonb
  ),
  (
    'amazon.products_global.discover_by_keyword',
    'amazon-products-global-discover-by-keyword',
    'Amazon products global — Discover by keyword',
    'Amazon products global', 'Discover by keyword', 230,
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"urn:dhumi:schema:amazon:products-global:discover-by-keyword:input:v1","type":"object","additionalProperties":false,"required":["targets"],"properties":{"targets":{"type":"array","minItems":1,"maxItems":20,"items":{"type":"object","additionalProperties":false,"required":["keyword","url"],"properties":{"keyword":{"type":"string","minLength":1},"url":{"type":"string","format":"uri"},"pages_to_search":{"type":"number"}}}}}}'::jsonb
  ),
  (
    'amazon.products_global.discover_by_seller',
    'amazon-products-global-discover-by-seller',
    'Amazon products global — Discover by seller',
    'Amazon products global', 'Discover by seller', 240,
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"urn:dhumi:schema:amazon:products-global:discover-by-seller:input:v1","type":"object","additionalProperties":false,"required":["targets"],"properties":{"targets":{"type":"array","minItems":1,"maxItems":20,"items":{"type":"object","additionalProperties":false,"required":["seller_url"],"properties":{"seller_url":{"type":"string","format":"uri"},"num_of_products":{"type":"number"}}}}}}'::jsonb
  );

WITH definition AS (
  INSERT INTO app.adapter_definitions (code, product_family)
  VALUES ('bright_data.amazon.scraper_library', 'scraper_library')
  RETURNING id
)
INSERT INTO app.adapter_versions (
  adapter_definition_id,
  semantic_version,
  capability_metadata,
  request_schema,
  result_schema,
  error_schema,
  code_artifact_digest,
  state
)
SELECT
  definition.id,
  '1.0.0-pattern6',
  jsonb_build_object(
    'registry_version', 1,
    'operation_codes', (
      SELECT jsonb_agg(operation_code ORDER BY display_priority)
      FROM pattern6_amazon_registry
    ),
    'provider_endpoint', 'datasets-v3-scrape',
    'inline_result', true,
    'snapshot_fallback', true,
    'multipart', 'conditional',
    'cancel', 'conditional'
  ),
  '{"type":"object","additionalProperties":false,"required":["input"],"properties":{"input":{"type":"array","minItems":1,"maxItems":20,"items":{"type":"object"}},"limit_per_input":{"type":["integer","null"],"minimum":1}}}'::jsonb,
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"array","items":{"type":"object","additionalProperties":true}}'::jsonb,
  '{"type":"object","additionalProperties":true}'::jsonb,
  decode('afd0a29edcc08fdae2d26e1b3c9ca2281869b184e550717e834592c969336a62', 'hex'),
  'disabled'
FROM definition;

INSERT INTO app.launch_evidence (
  evidence_code,
  scope_type,
  scope_key,
  state,
  restricted_reference
)
SELECT
  'amazon.template.' || operation_code || '.v1',
  'service_template_version',
  operation_code || ':1',
  'pending',
  'checkpoint://amazon/pattern6/' || operation_code
FROM pattern6_amazon_registry;

-- These catalogue tables use FORCE ROW LEVEL SECURITY and intentionally expose
-- no write policy to any runtime capability. The migration owner temporarily
-- disables RLS only inside this single-transaction migration, stages the draft
-- rows, and restores the accepted forced-RLS posture before continuing.
ALTER TABLE app.service_templates DISABLE ROW LEVEL SECURITY;
ALTER TABLE app.service_template_versions DISABLE ROW LEVEL SECURITY;

INSERT INTO app.service_templates (slug, product_family, state)
SELECT slug, 'scraper_library', 'draft'
FROM pattern6_amazon_registry;

INSERT INTO app.service_template_versions (
  service_template_id,
  version,
  public_name,
  public_description,
  input_schema,
  configuration_schema,
  output_schema,
  presentation_metadata,
  availability_copy,
  availability_state,
  adapter_version_id,
  launch_evidence_id,
  effective_at,
  published_at
)
SELECT
  template.id,
  1,
  registry.public_name,
  registry.public_name || ' through Dhumi. Qualification is pending.',
  registry.input_schema,
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"urn:dhumi:schema:amazon:configuration:v1","type":"object","additionalProperties":false,"properties":{}}'::jsonb,
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"array","items":{"type":"object","additionalProperties":true}}'::jsonb,
  jsonb_build_object(
    'domain_slug', 'amazon-com',
    'domain_name', 'amazon.com',
    'category', 'e-commerce',
    'icon_key', 'amazon',
    'operation_group', registry.operation_group,
    'operation_name', registry.operation_name,
    'display_priority', registry.display_priority
  ),
  'Qualification pending',
  'coming_soon',
  adapter.id,
  evidence.id,
  NULL,
  NULL
FROM pattern6_amazon_registry AS registry
JOIN app.service_templates AS template
  ON template.slug = registry.slug
JOIN app.launch_evidence AS evidence
  ON evidence.evidence_code = 'amazon.template.' || registry.operation_code || '.v1'
 AND evidence.scope_type = 'service_template_version'
 AND evidence.scope_key = registry.operation_code || ':1'
CROSS JOIN LATERAL (
  SELECT version.id
  FROM app.adapter_versions AS version
  JOIN app.adapter_definitions AS definition
    ON definition.id = version.adapter_definition_id
  WHERE definition.code = 'bright_data.amazon.scraper_library'
    AND version.semantic_version = '1.0.0-pattern6'
) AS adapter;

-- The catalogue's deferrable publication-pointer constraint queues trigger
-- events even for the NULL draft pointer. Flush those events before restoring
-- RLS; PostgreSQL does not allow ALTER TABLE while they remain pending.
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE app.service_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.service_template_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.service_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.service_templates FORCE ROW LEVEL SECURITY;

CREATE FUNCTION app.resolve_provider_normalization_plan(
  p_run_id uuid,
  p_attempt_id uuid,
  p_fence_token uuid,
  p_source_attempt_id uuid
)
RETURNS TABLE (
  operation_code text,
  output_policy jsonb
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  resolved_tenant_id uuid;
BEGIN
  resolved_tenant_id := app.require_tenant_context();

  RETURN QUERY
  SELECT mapping.operation_code, mapping.output_policy
  FROM app.runs AS run
  JOIN app.run_attempts AS current_attempt
    ON current_attempt.tenant_id = run.tenant_id
   AND current_attempt.run_id = run.id
  JOIN app.run_attempts AS source_attempt
    ON source_attempt.tenant_id = run.tenant_id
   AND source_attempt.run_id = run.id
  JOIN app.provider_mappings AS mapping
    ON mapping.id = run.provider_mapping_id
   AND mapping.id = current_attempt.provider_mapping_id
   AND mapping.id = source_attempt.provider_mapping_id
   AND mapping.adapter_version_id = run.adapter_version_id
   AND mapping.adapter_version_id = current_attempt.adapter_version_id
   AND mapping.adapter_version_id = source_attempt.adapter_version_id
   AND mapping.service_template_version_id = run.service_template_version_id
   AND mapping.commercial_config_version = run.commercial_config_version
  WHERE run.tenant_id = resolved_tenant_id
    AND run.id = p_run_id
    AND run.internal_status = 'PROCESSING'
    AND current_attempt.id = p_attempt_id
    AND current_attempt.state = 'claimed'
    AND current_attempt.fence_token = p_fence_token
    AND current_attempt.worker_lease_expires_at > clock_timestamp()
    AND source_attempt.id = p_source_attempt_id
    AND source_attempt.kind = 'submission'
    AND EXISTS (
      SELECT 1
      FROM app.artifacts AS artifact
      WHERE artifact.tenant_id = run.tenant_id
        AND artifact.run_id = run.id
        AND artifact.attempt_id = source_attempt.id
        AND artifact.kind = 'raw'
        AND artifact.state = 'durable'
    );

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RUN_PROVIDER_NORMALIZATION_PLAN_NOT_AVAILABLE'
      USING ERRCODE = 'P0002';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION app.resolve_provider_normalization_plan(uuid, uuid, uuid, uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_provider_normalization_plan(uuid, uuid, uuid, uuid)
  TO dhumi_job_manager;

RESET ROLE;
