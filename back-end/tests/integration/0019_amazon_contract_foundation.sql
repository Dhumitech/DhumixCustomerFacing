-- Privileged rollback-only proof for migrations 0026-0028.
-- Run only against dhumi_test at schema state 0025. Every DDL/DML statement
-- and trigger change is enclosed by this transaction and ends in ROLLBACK.
\set ON_ERROR_STOP on

BEGIN;

\ir ../../scripts/migrations/0026_template_presentation_and_configuration_schema.sql
\ir ../../scripts/migrations/0027_run_list_service_filter.sql
\ir ../../scripts/migrations/0028_run_result_read_surface.sql

DO $proof$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM app.service_template_versions
    WHERE configuration_schema IS NULL
       OR presentation_metadata IS NULL
       OR jsonb_typeof(configuration_schema) <> 'object'
       OR jsonb_typeof(presentation_metadata) <> 'object'
  ) THEN
    RAISE EXCEPTION 'Template schema/presentation backfill is incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'app.service_template_versions'::regclass
      AND tgname = 'service_template_versions_immutable'
      AND NOT tgisinternal
      AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'Template-version immutability trigger was not re-enabled';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_indexes
    WHERE schemaname = 'app'
      AND indexname IN (
        'service_versions_by_tenant_service_id_id_idx',
        'runs_by_tenant_service_version_created_id_idx',
        'artifacts_validated_result_read_idx'
      )
  ) <> 3 THEN
    RAISE EXCEPTION 'One or more Amazon contract/result indexes are missing';
  END IF;

  IF has_table_privilege('dhumi_customer_api', 'app.artifacts', 'SELECT') THEN
    RAISE EXCEPTION 'Customer API retained table-wide Artifact SELECT';
  END IF;

  IF NOT has_column_privilege(
    'dhumi_customer_api',
    'app.artifacts',
    'object_key',
    'SELECT'
  ) OR NOT has_column_privilege(
    'dhumi_customer_api',
    'app.artifacts',
    'checksum',
    'SELECT'
  ) OR has_column_privilege(
    'dhumi_customer_api',
    'app.artifacts',
    'attempt_id',
    'SELECT'
  ) OR has_column_privilege(
    'dhumi_customer_api',
    'app.artifacts',
    'deleted_at',
    'SELECT'
  ) THEN
    RAISE EXCEPTION 'Customer API Artifact column surface is incorrect';
  END IF;

  IF has_table_privilege('dhumi_customer_api', 'app.audit_events', 'INSERT') THEN
    RAISE EXCEPTION 'Customer API retained table-wide audit INSERT';
  END IF;

  IF NOT has_column_privilege(
    'dhumi_customer_api',
    'app.audit_events',
    'actor_api_key_id',
    'INSERT'
  ) OR NOT has_column_privilege(
    'dhumi_customer_api',
    'app.audit_events',
    'safe_diff',
    'INSERT'
  ) OR has_column_privilege(
    'dhumi_customer_api',
    'app.audit_events',
    'reason',
    'INSERT'
  ) THEN
    RAISE EXCEPTION 'Customer API audit column surface is incorrect';
  END IF;
END
$proof$;

ROLLBACK;
