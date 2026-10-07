import type { DatabaseExecutor } from '../../types/database.js';
import type { ProviderEnvironment } from '../customerServices/createServiceRepository.js';
import { requireExecutableTemplateFacts, type TemplateExecutionDefinition, type TemplateEngine } from '../catalogue/templateExecutionDefinition.js';

export interface RunAdmissionEligibility {
  readonly service_id: string;
  readonly service_state: 'active' | 'disabled';
  readonly template_version_id: string;
  readonly template_state: string;
  readonly product_family: string;
  readonly input_schema: unknown;
  readonly template_version_available: boolean;
  readonly engine: TemplateEngine;
  readonly execution_definition: TemplateExecutionDefinition;
  readonly definition_sha256: Buffer;
  readonly dataset_bound: boolean;
  readonly publication_approved: boolean;
  readonly is_internal: boolean;
}

export async function selectRunAdmissionEligibility(database: DatabaseExecutor, tenantId: string, serviceId: string,
  _providerEnvironment: ProviderEnvironment): Promise<RunAdmissionEligibility | undefined> {
  const result = await database.query<RunAdmissionEligibility>(`
    SELECT service.id AS service_id,service.state AS service_state,version.id AS template_version_id,
      template.state AS template_state,template.product_family,version.input_schema,version.engine,
      version.execution_definition,version.definition_sha256,
      (version.provider_dataset_ciphertext IS NOT NULL AND version.provider_dataset_fingerprint IS NOT NULL) AS dataset_bound,
      (version.published_at IS NOT NULL AND version.published_at<=statement_timestamp() AND
       version.published_by IS NOT NULL AND version.evidence_ref IS NOT NULL) AS publication_approved,
      (version.availability_state='available' OR template.state='draft' AND organization.is_internal AND version.availability_state='coming_soon') AS template_version_available,organization.is_internal
    FROM app.services AS service
    JOIN app.service_template_versions version ON version.id=service.template_version_id
    JOIN app.service_templates template ON template.id=version.service_template_id
    JOIN app.organizations organization ON organization.id=service.organization_id
    WHERE service.organization_id=$1 AND service.id=$2 AND (template.access='all' OR EXISTS (
      SELECT 1 FROM app.organization_templates allowed WHERE allowed.organization_id=$1 AND allowed.service_template_id=template.id))
    FOR SHARE OF service,template`, [tenantId,serviceId]);
  return result.rows[0];
}

export function isRunAdmissionReleaseAvailable(row: RunAdmissionEligibility): boolean {
  if (row.service_state!=='active' || !row.template_version_available ||
    !(row.template_state==='published' && row.publication_approved || row.template_state==='draft' && row.is_internal)) return false;
  try { requireExecutableTemplateFacts({productFamily:row.product_family,engine:row.engine,definition:row.execution_definition,
    definitionSha256:row.definition_sha256,datasetBound:row.dataset_bound}); return true; }
  catch { return false; }
}
