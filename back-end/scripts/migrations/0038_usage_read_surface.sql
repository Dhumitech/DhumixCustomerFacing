-- Pattern 8B: tenant-scoped informational usage read surface.
--
-- Customer API code receives only public usage fields through two restricted
-- SECURITY DEFINER functions. Direct usage_events reads are removed from the
-- customer capability so provider evidence, Attempt identifiers and internal
-- version identifiers cannot cross the public boundary by accident.

SET ROLE dhumi_owner;

CREATE INDEX usage_events_by_tenant_observed_id_idx
  ON app.usage_events (tenant_id, observed_at DESC, id DESC);

CREATE FUNCTION app.get_usage_summary(
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE (
  meter_code text,
  quantity numeric,
  unit text,
  updated_at timestamptz,
  reconciliation_state text
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  resolved_tenant_id uuid;
  evaluated_at timestamptz;
BEGIN
  resolved_tenant_id := app.require_tenant_context();

  IF p_from IS NULL
     OR p_to IS NULL
     OR NOT isfinite(p_from)
     OR NOT isfinite(p_to)
     OR p_from >= p_to THEN
    RAISE EXCEPTION 'USAGE_TIME_RANGE_INVALID'
      USING ERRCODE = '22023';
  END IF;

  evaluated_at := transaction_timestamp();

  RETURN QUERY
  WITH totals AS MATERIALIZED (
    SELECT
      usage.meter_code,
      SUM(usage.quantity)::numeric AS quantity,
      usage.unit
    FROM app.usage_events AS usage
    WHERE usage.tenant_id = resolved_tenant_id
      AND usage.observed_at >= p_from
      AND usage.observed_at < p_to
      AND usage.source = 'artifact'
      AND usage.outcome = 'succeeded'
    GROUP BY usage.meter_code, usage.unit
  )
  SELECT
    totals.meter_code,
    totals.quantity,
    totals.unit,
    evaluated_at,
    'observed'::text
  FROM totals
  UNION ALL
  SELECT
    NULL::text,
    NULL::numeric,
    NULL::text,
    evaluated_at,
    'observed'::text
  WHERE NOT EXISTS (SELECT 1 FROM totals)
  ORDER BY 1 NULLS LAST, 3 NULLS LAST;
END;
$$;

CREATE FUNCTION app.list_usage_events(
  p_from timestamptz,
  p_to timestamptz,
  p_before_observed_at timestamptz,
  p_before_id uuid,
  p_fetch_limit integer
)
RETURNS TABLE (
  id uuid,
  run_id uuid,
  product_family text,
  meter_code text,
  quantity numeric,
  unit text,
  outcome text,
  observed_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  resolved_tenant_id uuid;
BEGIN
  resolved_tenant_id := app.require_tenant_context();

  IF p_from IS NULL
     OR p_to IS NULL
     OR NOT isfinite(p_from)
     OR NOT isfinite(p_to)
     OR p_from >= p_to THEN
    RAISE EXCEPTION 'USAGE_TIME_RANGE_INVALID'
      USING ERRCODE = '22023';
  END IF;

  IF (p_before_observed_at IS NULL) <> (p_before_id IS NULL)
     OR (p_before_observed_at IS NOT NULL AND NOT isfinite(p_before_observed_at)) THEN
    RAISE EXCEPTION 'USAGE_CURSOR_INVALID'
      USING ERRCODE = '22023';
  END IF;

  IF p_fetch_limit IS NULL OR p_fetch_limit < 2 OR p_fetch_limit > 101 THEN
    RAISE EXCEPTION 'USAGE_FETCH_LIMIT_INVALID'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT
    usage.id,
    usage.run_id,
    definition.product_family,
    usage.meter_code,
    usage.quantity::numeric,
    usage.unit,
    usage.outcome,
    usage.observed_at
  FROM app.usage_events AS usage
  JOIN app.adapter_versions AS version
    ON version.id = usage.adapter_version_id
  JOIN app.adapter_definitions AS definition
    ON definition.id = version.adapter_definition_id
  WHERE usage.tenant_id = resolved_tenant_id
    AND usage.observed_at >= p_from
    AND usage.observed_at < p_to
    AND (
      p_before_observed_at IS NULL
      OR (usage.observed_at, usage.id) < (p_before_observed_at, p_before_id)
    )
  ORDER BY usage.observed_at DESC, usage.id DESC
  LIMIT p_fetch_limit;
END;
$$;

REVOKE SELECT ON app.usage_events FROM dhumi_customer_api;

REVOKE ALL ON FUNCTION app.get_usage_summary(timestamptz, timestamptz)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app.list_usage_events(
  timestamptz, timestamptz, timestamptz, uuid, integer
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.get_usage_summary(timestamptz, timestamptz),
  app.list_usage_events(timestamptz, timestamptz, timestamptz, uuid, integer)
  TO dhumi_customer_api;

RESET ROLE;
