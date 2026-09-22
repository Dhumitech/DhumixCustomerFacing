-- Preserve the authenticated-encryption identity of protected provider
-- resources when an immutable Provider Mapping is copied into a published
-- Template version. No role, LOGIN, public route or provider call is added.

SET ROLE dhumi_owner;

ALTER TABLE app.provider_mappings
  ADD COLUMN provider_resource_aad_mapping_id uuid;

-- Existing mappings were originally encrypted with their own immutable ID.
ALTER TABLE app.provider_mappings
  DISABLE TRIGGER provider_mappings_immutable;

UPDATE app.provider_mappings
SET provider_resource_aad_mapping_id = id;

-- Migration 0041 copied the accepted v2 mapping ciphertext into a new v3
-- release mapping. The bytes must continue to be opened with the accepted
-- mapping ID that authenticated them, not with the new release mapping ID.
WITH release_lineage AS (
  SELECT
    release_mapping.id AS release_mapping_id,
    accepted_mapping.provider_resource_aad_mapping_id AS aad_mapping_id,
    row_number() OVER (
      PARTITION BY release_mapping.id
      ORDER BY qualification.reviewed_at DESC NULLS LAST, accepted_mapping.id
    ) AS candidate_order
  FROM app.provider_mappings AS release_mapping
  JOIN app.service_template_versions AS release_version
    ON release_version.id = release_mapping.service_template_version_id
   AND release_version.version = 3
  JOIN app.provider_mappings AS accepted_mapping
    ON accepted_mapping.id <> release_mapping.id
   AND accepted_mapping.operation_code = release_mapping.operation_code
   AND accepted_mapping.environment = release_mapping.environment
   AND accepted_mapping.provider_credential_id = release_mapping.provider_credential_id
   AND accepted_mapping.provider_resource_ciphertext =
       release_mapping.provider_resource_ciphertext
   AND accepted_mapping.provider_resource_fingerprint =
       release_mapping.provider_resource_fingerprint
   AND accepted_mapping.config_version = release_mapping.config_version
  JOIN app.service_template_versions AS accepted_version
    ON accepted_version.id = accepted_mapping.service_template_version_id
   AND accepted_version.version = 2
  JOIN app.provider_qualification_attempts AS qualification
    ON qualification.provider_mapping_id = accepted_mapping.id
   AND qualification.operation_code = release_mapping.operation_code
   AND qualification.environment = release_mapping.environment
   AND qualification.state = 'succeeded'
   AND qualification.review_state = 'approved'
)
UPDATE app.provider_mappings AS mapping
SET provider_resource_aad_mapping_id = lineage.aad_mapping_id
FROM release_lineage AS lineage
WHERE mapping.id = lineage.release_mapping_id
  AND lineage.candidate_order = 1;

ALTER TABLE app.provider_mappings
  ENABLE TRIGGER provider_mappings_immutable;

ALTER TABLE app.provider_mappings
  ALTER COLUMN provider_resource_aad_mapping_id SET NOT NULL;

ALTER TABLE app.provider_mappings
  ADD CONSTRAINT provider_mappings_resource_aad_mapping_fk
  FOREIGN KEY (provider_resource_aad_mapping_id)
  REFERENCES app.provider_mappings(id)
  ON DELETE RESTRICT;

CREATE FUNCTION app.assign_provider_resource_aad_mapping_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
  inherited_lineages uuid[];
BEGIN
  IF NEW.provider_resource_aad_mapping_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT array_agg(DISTINCT source.provider_resource_aad_mapping_id)
  INTO inherited_lineages
  FROM app.provider_mappings AS source
  WHERE source.id <> NEW.id
    AND source.operation_code = NEW.operation_code
    AND source.environment = NEW.environment
    AND source.provider_credential_id = NEW.provider_credential_id
    AND source.provider_resource_ciphertext = NEW.provider_resource_ciphertext
    AND source.provider_resource_fingerprint = NEW.provider_resource_fingerprint
    AND source.config_version = NEW.config_version;

  IF inherited_lineages IS NULL OR cardinality(inherited_lineages) = 0 THEN
    NEW.provider_resource_aad_mapping_id := NEW.id;
  ELSIF cardinality(inherited_lineages) = 1 THEN
    NEW.provider_resource_aad_mapping_id := inherited_lineages[1];
  ELSE
    RAISE EXCEPTION 'PROVIDER_MAPPING_AAD_LINEAGE_AMBIGUOUS'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.assign_provider_resource_aad_mapping_id() FROM PUBLIC;

CREATE TRIGGER provider_mappings_assign_resource_aad_mapping_id
  BEFORE INSERT ON app.provider_mappings
  FOR EACH ROW EXECUTE FUNCTION app.assign_provider_resource_aad_mapping_id();

CREATE FUNCTION app.resolve_provider_execution_plan_v2(
  p_run_id uuid,
  p_attempt_id uuid,
  p_fence_token uuid
)
RETURNS TABLE (
  mapping_id uuid,
  provider_resource_aad_mapping_id uuid,
  validated_input jsonb,
  operation_code text,
  provider_resource_ciphertext bytea,
  provider_resource_fingerprint bytea,
  output_policy jsonb,
  mapping_config_version text,
  provider_code text,
  provider_environment text,
  vault_secret_reference text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT
    legacy.mapping_id,
    mapping.provider_resource_aad_mapping_id,
    legacy.validated_input,
    legacy.operation_code,
    legacy.provider_resource_ciphertext,
    legacy.provider_resource_fingerprint,
    legacy.output_policy,
    legacy.mapping_config_version,
    legacy.provider_code,
    legacy.provider_environment,
    legacy.vault_secret_reference
  FROM app.resolve_provider_execution_plan(
    p_run_id, p_attempt_id, p_fence_token
  ) AS legacy
  JOIN app.provider_mappings AS mapping
    ON mapping.id = legacy.mapping_id
  JOIN app.provider_mappings AS aad_mapping
    ON aad_mapping.id = mapping.provider_resource_aad_mapping_id
   AND aad_mapping.operation_code = mapping.operation_code
   AND aad_mapping.environment = mapping.environment
   AND aad_mapping.provider_credential_id = mapping.provider_credential_id
   AND aad_mapping.provider_resource_ciphertext =
       mapping.provider_resource_ciphertext
   AND aad_mapping.provider_resource_fingerprint =
       mapping.provider_resource_fingerprint
   AND aad_mapping.config_version = mapping.config_version;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RUN_PROVIDER_EXECUTION_PLAN_NOT_AVAILABLE'
      USING ERRCODE = 'P0002';
  END IF;
END;
$$;

CREATE FUNCTION app.resolve_provider_reconciliation_plan_v2(
  p_run_id uuid,
  p_reconciliation_attempt_id uuid,
  p_reconciliation_fence_token uuid
)
RETURNS TABLE (
  source_attempt_id uuid,
  mapping_id uuid,
  provider_resource_aad_mapping_id uuid,
  source_provider_reference_ciphertext bytea,
  source_provider_reference_fingerprint bytea,
  validated_input jsonb,
  operation_code text,
  provider_resource_ciphertext bytea,
  provider_resource_fingerprint bytea,
  output_policy jsonb,
  mapping_config_version text,
  provider_code text,
  provider_environment text,
  vault_secret_reference text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT
    legacy.source_attempt_id,
    legacy.mapping_id,
    mapping.provider_resource_aad_mapping_id,
    legacy.source_provider_reference_ciphertext,
    legacy.source_provider_reference_fingerprint,
    legacy.validated_input,
    legacy.operation_code,
    legacy.provider_resource_ciphertext,
    legacy.provider_resource_fingerprint,
    legacy.output_policy,
    legacy.mapping_config_version,
    legacy.provider_code,
    legacy.provider_environment,
    legacy.vault_secret_reference
  FROM app.resolve_provider_reconciliation_plan(
    p_run_id, p_reconciliation_attempt_id, p_reconciliation_fence_token
  ) AS legacy
  JOIN app.provider_mappings AS mapping
    ON mapping.id = legacy.mapping_id
  JOIN app.provider_mappings AS aad_mapping
    ON aad_mapping.id = mapping.provider_resource_aad_mapping_id
   AND aad_mapping.operation_code = mapping.operation_code
   AND aad_mapping.environment = mapping.environment
   AND aad_mapping.provider_credential_id = mapping.provider_credential_id
   AND aad_mapping.provider_resource_ciphertext =
       mapping.provider_resource_ciphertext
   AND aad_mapping.provider_resource_fingerprint =
       mapping.provider_resource_fingerprint
   AND aad_mapping.config_version = mapping.config_version;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RUN_PROVIDER_RECONCILIATION_PLAN_NOT_AVAILABLE'
      USING ERRCODE = 'P0002';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION app.resolve_provider_execution_plan_v2(uuid, uuid, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_provider_reconciliation_plan_v2(uuid, uuid, uuid)
  FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION app.resolve_provider_execution_plan(uuid, uuid, uuid)
  FROM dhumi_job_manager;
REVOKE EXECUTE ON FUNCTION app.resolve_provider_reconciliation_plan(uuid, uuid, uuid)
  FROM dhumi_job_manager;

GRANT EXECUTE ON FUNCTION app.resolve_provider_execution_plan_v2(uuid, uuid, uuid),
  app.resolve_provider_reconciliation_plan_v2(uuid, uuid, uuid)
  TO dhumi_job_manager;

RESET ROLE;
