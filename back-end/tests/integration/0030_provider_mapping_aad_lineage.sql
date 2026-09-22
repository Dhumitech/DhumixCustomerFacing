-- Privileged, rollback-only proof for migration 0042.
\set ON_ERROR_STOP on
\pset pager off

BEGIN;

CREATE FUNCTION pg_temp.assert_true(value boolean, message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'assertion failed: %', message;
  END IF;
END;
$$;

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM app.provider_mappings AS mapping
    LEFT JOIN app.provider_mappings AS aad_mapping
      ON aad_mapping.id = mapping.provider_resource_aad_mapping_id
     AND aad_mapping.operation_code = mapping.operation_code
     AND aad_mapping.environment = mapping.environment
     AND aad_mapping.provider_credential_id = mapping.provider_credential_id
     AND aad_mapping.provider_resource_ciphertext = mapping.provider_resource_ciphertext
     AND aad_mapping.provider_resource_fingerprint = mapping.provider_resource_fingerprint
     AND aad_mapping.config_version = mapping.config_version
    WHERE aad_mapping.id IS NULL
  ),
  'every protected provider resource must resolve to one exact authenticated lineage mapping'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM app.provider_mappings AS release_mapping
    JOIN app.service_template_versions AS release_version
      ON release_version.id = release_mapping.service_template_version_id
     AND release_version.version = 3
    WHERE release_mapping.operation_code LIKE 'amazon.%'
      AND release_mapping.state = 'enabled'
      AND NOT EXISTS (
        SELECT 1
        FROM app.provider_mappings AS accepted_mapping
        JOIN app.service_template_versions AS accepted_version
          ON accepted_version.id = accepted_mapping.service_template_version_id
         AND accepted_version.version = 2
        JOIN app.provider_qualification_attempts AS qualification
          ON qualification.provider_mapping_id = accepted_mapping.id
         AND qualification.state = 'succeeded'
         AND qualification.review_state = 'approved'
        WHERE accepted_mapping.id = release_mapping.provider_resource_aad_mapping_id
          AND accepted_mapping.operation_code = release_mapping.operation_code
          AND accepted_mapping.environment = release_mapping.environment
          AND accepted_mapping.provider_resource_ciphertext =
              release_mapping.provider_resource_ciphertext
          AND accepted_mapping.provider_resource_fingerprint =
              release_mapping.provider_resource_fingerprint
      )
  ),
  'each enabled Amazon v3 release mapping must retain its accepted v2 qualification lineage'
);

SELECT pg_temp.assert_true(
  has_function_privilege(
    'dhumi_job_manager',
    'app.resolve_provider_execution_plan_v2(uuid,uuid,uuid)',
    'EXECUTE'
  )
  AND has_function_privilege(
    'dhumi_job_manager',
    'app.resolve_provider_reconciliation_plan_v2(uuid,uuid,uuid)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'dhumi_job_manager',
    'app.resolve_provider_execution_plan(uuid,uuid,uuid)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'dhumi_job_manager',
    'app.resolve_provider_reconciliation_plan(uuid,uuid,uuid)',
    'EXECUTE'
  ),
  'Job Manager must execute only the lineage-aware provider plan functions'
);

ROLLBACK;
