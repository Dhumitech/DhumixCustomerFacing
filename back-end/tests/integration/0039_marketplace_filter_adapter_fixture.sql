-- Privileged, rollback-only M7 Marketplace adapter structure proof.
--
-- This proof checks the customer-disabled database boundary only. It creates no
-- Service, Run, Attempt, outbox event, entitlement, login or provider request.
\set ON_ERROR_STOP on

BEGIN;

CREATE FUNCTION pg_temp.assert_true(value boolean, message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'assertion failed: %', message;
  END IF;
END;
$$;

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
    FROM app.adapter_versions AS adapter
    JOIN app.adapter_definitions AS definition
      ON definition.id = adapter.adapter_definition_id
    WHERE definition.code = 'bright_data.marketplace.filter'
      AND definition.product_family = 'marketplace_dataset'
      AND adapter.semantic_version = '1.0.0-m7-fixture'
      AND adapter.state = 'disabled'
      AND adapter.capability_metadata @> '{
        "transport":"fixture",
        "provider_http_enabled":false,
        "customer_visible":false,
        "can_purchase":false,
        "can_execute":false,
        "can_publish":false,
        "automatic_submission_retries":0
      }'::jsonb
      AND adapter.code_artifact_digest =
        decode('a5545e0016e38071abf59bf01a3520ebb529d7e1f14f367f10dde9b9e534e2ab', 'hex')
  ),
  'one exact disabled fixture adapter version must be registered'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 0
    FROM app.provider_mappings AS mapping
    JOIN app.adapter_versions AS adapter ON adapter.id = mapping.adapter_version_id
    JOIN app.adapter_definitions AS definition
      ON definition.id = adapter.adapter_definition_id
    WHERE definition.code = 'bright_data.marketplace.filter'
      AND adapter.semantic_version = '1.0.0-m7-fixture'
  ),
  'M7 must create no provider mapping'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 0
    FROM app.service_template_versions AS template_version
    JOIN app.adapter_versions AS adapter ON adapter.id = template_version.adapter_version_id
    JOIN app.adapter_definitions AS definition
      ON definition.id = adapter.adapter_definition_id
    WHERE definition.code = 'bright_data.marketplace.filter'
      AND adapter.semantic_version = '1.0.0-m7-fixture'
  ),
  'M7 must create no Template version or customer publication path'
);

SELECT pg_temp.assert_true(
  to_regprocedure('app.resolve_provider_executor_kind(uuid,uuid,uuid)') IS NOT NULL
  AND to_regprocedure('app.resolve_marketplace_execution_plan_fixture(uuid,uuid,uuid,boolean,uuid)') IS NOT NULL
  AND to_regprocedure('app.record_marketplace_snapshot_observation_fenced(uuid,uuid,uuid,uuid,text,bigint,bigint,bigint,text)') IS NOT NULL
  AND to_regprocedure('app.record_marketplace_known_submission_outcome_fenced(uuid,uuid,uuid,text)') IS NOT NULL,
  'all M7 protected functions must exist'
);

SELECT pg_temp.assert_true(
  has_function_privilege(
    'dhumi_job_manager',
    'app.resolve_marketplace_execution_plan_fixture(uuid,uuid,uuid,boolean,uuid)',
    'EXECUTE'
  )
  AND has_function_privilege(
    'dhumi_job_manager',
    'app.record_marketplace_snapshot_observation_fenced(uuid,uuid,uuid,uuid,text,bigint,bigint,bigint,text)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'dhumi_customer_api',
    'app.resolve_marketplace_execution_plan_fixture(uuid,uuid,uuid,boolean,uuid)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'dhumi_customer_api',
    'app.record_marketplace_snapshot_observation_fenced(uuid,uuid,uuid,uuid,text,bigint,bigint,bigint,text)',
    'EXECUTE'
  ),
  'only the Job Manager role may use the M7 execution functions'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 5
    FROM information_schema.columns
    WHERE table_schema = 'app'
      AND table_name = 'run_attempts'
      AND column_name IN (
        'provider_dataset_size',
        'provider_file_size',
        'provider_cost_micros',
        'provider_cost_currency',
        'provider_metadata_observed_at'
      )
  ),
  'the five durable provider-observation columns must exist'
);

SELECT
  adapter.semantic_version,
  adapter.state,
  adapter.capability_metadata->>'transport' AS transport,
  adapter.capability_metadata->>'provider_http_enabled' AS provider_http_enabled,
  encode(adapter.code_artifact_digest, 'hex') AS code_artifact_digest
FROM app.adapter_versions AS adapter
JOIN app.adapter_definitions AS definition
  ON definition.id = adapter.adapter_definition_id
WHERE definition.code = 'bright_data.marketplace.filter'
  AND adapter.semantic_version = '1.0.0-m7-fixture';

ROLLBACK;
