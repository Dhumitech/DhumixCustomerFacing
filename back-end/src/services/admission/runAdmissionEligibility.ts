import type { DatabaseExecutor } from "../../types/database.js";
import type { ProviderEnvironment } from "../customerServices/createServiceRepository.js";

export interface RunAdmissionEligibility {
  readonly service_state: "active" | "disabled";
  readonly service_version_id: string | null;
  readonly service_template_version_id: string | null;
  readonly template_state: "draft" | "published" | "disabled" | "retired" | null;
  readonly product_family: "marketplace_dataset" | "scraper_library" | null;
  readonly input_schema: unknown;
  readonly template_version_available: boolean | null;
  readonly adapter_version_id: string | null;
  readonly adapter_enabled: boolean | null;
  readonly adapter_code: string | null;
  readonly adapter_semantic_version: string | null;
  readonly template_launch_evidence_id: string | null;
  readonly template_evidence_current: boolean | null;
  readonly provider_mapping_id: string | null;
  readonly commercial_config_version: string | null;
  readonly mapping_launch_evidence_id: string | null;
  readonly mapping_current: boolean | null;
  readonly mapping_evidence_current: boolean | null;
  readonly feature_flag_id: string | null;
  readonly feature_launch_evidence_id: string | null;
  readonly feature_current: boolean | null;
  readonly feature_evidence_current: boolean | null;
}

interface ServiceLockRow {
  readonly locked: boolean;
}

export async function selectRunAdmissionEligibility(
  database: DatabaseExecutor,
  tenantId: string,
  serviceId: string,
  providerEnvironment: ProviderEnvironment,
): Promise<RunAdmissionEligibility | undefined> {
  const lockResult = await database.query<ServiceLockRow>(
    "SELECT app.lock_service_for_run($1) AS locked",
    [serviceId],
  );
  if (lockResult.rows[0]?.locked !== true) return undefined;

  const result = await database.query<RunAdmissionEligibility>(
    `
      SELECT
        service.state AS service_state,
        service_version.id AS service_version_id,
        template_version.id AS service_template_version_id,
        template.state AS template_state,
        template.product_family,
        template_version.input_schema,
        (
          template_version.availability_state = 'available'
          AND template_version.published_at IS NOT NULL
          AND template_version.published_at <= statement_timestamp()
          AND template_version.effective_at IS NOT NULL
          AND template_version.effective_at <= statement_timestamp()
        ) AS template_version_available,
        template_version.adapter_version_id,
        (adapter_version.state = 'enabled') AS adapter_enabled,
        adapter_definition.code AS adapter_code,
        adapter_version.semantic_version AS adapter_semantic_version,
        template_version.launch_evidence_id AS template_launch_evidence_id,
        (
          template_evidence.state = 'approved'
          AND template_evidence.effective_at IS NOT NULL
          AND template_evidence.effective_at <= statement_timestamp()
          AND (
            template_evidence.expires_at IS NULL
            OR template_evidence.expires_at > statement_timestamp()
          )
        ) AS template_evidence_current,
        mapping.id AS provider_mapping_id,
        mapping.commercial_config_version,
        mapping.launch_evidence_id AS mapping_launch_evidence_id,
        (
          mapping.state = 'enabled'
          AND mapping.adapter_version_id = template_version.adapter_version_id
          AND mapping.service_template_version_id = template_version.id
        ) AS mapping_current,
        (
          mapping_evidence.state = 'approved'
          AND mapping_evidence.effective_at IS NOT NULL
          AND mapping_evidence.effective_at <= statement_timestamp()
          AND (
            mapping_evidence.expires_at IS NULL
            OR mapping_evidence.expires_at > statement_timestamp()
          )
        ) AS mapping_evidence_current,
        feature.id AS feature_flag_id,
        feature.launch_evidence_id AS feature_launch_evidence_id,
        (
          feature.state = 'enabled'
          AND (feature.expires_at IS NULL OR feature.expires_at > statement_timestamp())
        ) AS feature_current,
        (
          feature_evidence.state = 'approved'
          AND feature_evidence.effective_at IS NOT NULL
          AND feature_evidence.effective_at <= statement_timestamp()
          AND (
            feature_evidence.expires_at IS NULL
            OR feature_evidence.expires_at > statement_timestamp()
          )
        ) AS feature_evidence_current
      FROM app.services AS service
      LEFT JOIN app.service_versions AS service_version
        ON service_version.tenant_id = service.tenant_id
       AND service_version.service_id = service.id
       AND service_version.version = service.current_version
      LEFT JOIN app.service_template_versions AS template_version
        ON template_version.id = service_version.service_template_version_id
      LEFT JOIN app.service_templates AS template
        ON template.id = service.service_template_id
       AND template.id = template_version.service_template_id
      LEFT JOIN app.adapter_versions AS adapter_version
        ON adapter_version.id = template_version.adapter_version_id
      LEFT JOIN app.adapter_definitions AS adapter_definition
        ON adapter_definition.id = adapter_version.adapter_definition_id
      LEFT JOIN app.launch_evidence AS template_evidence
        ON template_evidence.id = template_version.launch_evidence_id
      LEFT JOIN app.provider_mappings AS mapping
        ON mapping.service_template_version_id = template_version.id
       AND mapping.adapter_version_id = template_version.adapter_version_id
       AND mapping.environment = $3
       AND mapping.state = 'enabled'
      LEFT JOIN app.launch_evidence AS mapping_evidence
        ON mapping_evidence.id = mapping.launch_evidence_id
      LEFT JOIN app.feature_flags AS feature
        ON feature.feature_code = template.product_family
       AND feature.environment = $3
      LEFT JOIN app.launch_evidence AS feature_evidence
        ON feature_evidence.id = feature.launch_evidence_id
      WHERE service.tenant_id = $1
        AND service.id = $2
    `,
    [tenantId, serviceId, providerEnvironment],
  );
  return result.rows[0];
}

export function isRunAdmissionReleaseAvailable(
  row: RunAdmissionEligibility,
): boolean {
  return (
    row.service_version_id !== null &&
    row.service_template_version_id !== null &&
    row.template_state === "published" &&
    row.product_family !== null &&
    row.input_schema !== null &&
    row.template_version_available === true &&
    row.adapter_version_id !== null &&
    row.adapter_enabled === true &&
    row.template_launch_evidence_id !== null &&
    row.template_evidence_current === true &&
    row.provider_mapping_id !== null &&
    row.commercial_config_version !== null &&
    row.mapping_launch_evidence_id !== null &&
    row.mapping_current === true &&
    row.mapping_evidence_current === true &&
    row.feature_flag_id !== null &&
    row.feature_launch_evidence_id !== null &&
    row.feature_current === true &&
    row.feature_evidence_current === true
  );
}
