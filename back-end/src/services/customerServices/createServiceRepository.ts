import { requireExecutableTemplateFacts, TemplateExecutionDefinitionError } from "../catalogue/templateExecutionDefinition.js";
import type { Pool } from "pg";
import type { DatabaseExecutor } from "../../types/database.js";
import { ApplicationError } from "../../utils/applicationError.js";
import { withAdmissionOrganizationTransaction } from "../database/transactions.js";
import type { Service } from "./listServicesService.js";
import type { ServiceProductFamily } from "./listServicesRepository.js";

export type ProviderEnvironment = "local" | "test" | "production";

export interface CreatedService extends Service {
  readonly configuration: Readonly<Record<string, unknown>>;
}

export interface ConfigurationValidationInput {
  readonly templateVersionId: string;
  readonly schema: unknown;
  readonly configuration: Readonly<Record<string, unknown>>;
}

export type ConfigurationValidationOutcome =
  | { readonly valid: true; readonly schemaHash: Buffer }
  | {
      readonly valid: false;
      readonly issues: readonly { readonly field: string; readonly message: string }[];
    };

export interface CreateServicePersistenceInput {
  readonly idempotencyRecordId: string;
  readonly serviceId: string;
  readonly tenantId: string;
  readonly actor: { readonly kind: "browser"; readonly userId: string };
  readonly idempotencyKey: string;
  readonly actorFingerprint: Buffer;
  readonly requestHash: Buffer;
  readonly templateSlug: string;
  readonly name: string;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly providerEnvironment: ProviderEnvironment;
  readonly requestId: string | null;
  readonly ipFingerprint: Buffer | null;
  readonly validateConfiguration: (
    input: ConfigurationValidationInput,
  ) => ConfigurationValidationOutcome;
}

export type CreateServicePersistenceOutcome =
  | { readonly kind: "created"; readonly service: CreatedService }
  | { readonly kind: "replay"; readonly service: CreatedService }
  | { readonly kind: "conflict" };

export interface CreateServiceRepository {
  persist(input: CreateServicePersistenceInput): Promise<CreateServicePersistenceOutcome>;
}

export class ServiceTemplateNotCreatableError extends Error {
  public constructor() {
    super("The selected Template is not creatable");
    this.name = "ServiceTemplateNotCreatableError";
  }
}

export class ServiceAdmissionUnavailableError extends Error {
  public constructor(cause?: unknown) {
    super("Service admission is unavailable", { cause });
    this.name = "ServiceAdmissionUnavailableError";
  }
}

export class ServiceConfigurationRejectedError extends Error {
  public readonly issues: readonly { readonly field: string; readonly message: string }[];

  public constructor(issues: readonly { readonly field: string; readonly message: string }[]) {
    super("The Service configuration was rejected");
    this.name = "ServiceConfigurationRejectedError";
    this.issues = issues;
  }
}

export class ServiceNameConflictError extends Error {
  public constructor(cause?: unknown) {
    super("The Service name already exists", { cause });
    this.name = "ServiceNameConflictError";
  }
}

interface ClaimRow {
  readonly id: string;
}

interface ExistingClaimRow {
  readonly actor_fingerprint: Buffer;
  readonly request_hash: Buffer;
  readonly state: "in_progress" | "completed" | "failed";
  readonly response_status: number | null;
  readonly resource_id: string | null;
  readonly response_body_reference: string | null;
  readonly response_body: unknown;
}

interface EligibilityRow {
  readonly template_id: string;
  readonly template_state: string;
  readonly product_family: ServiceProductFamily;
  readonly template_version_id: string | null;
  readonly template_version: number | null;
  readonly configuration_schema: unknown;
  readonly availability_state: string | null;
  readonly published_at: Date | null;
  readonly publication_approved: boolean;
  readonly published_by: string | null;
  readonly evidence_ref: string | null;
  readonly engine: string | null;
  readonly execution_definition: unknown;
  readonly definition_sha256: Buffer | null;
  readonly dataset_bound: boolean;
  readonly is_internal: boolean;
}

interface CreatedAtRow {
  readonly created_at: Date;
}

interface ResponseBodyRow {
  readonly response_body: unknown;
}

function databaseErrorField(error: unknown, field: "code" | "constraint"): string | undefined {
  if (typeof error !== "object" || error === null || !(field in error)) return undefined;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function internalFailure(cause: unknown): ApplicationError {
  return new ApplicationError({
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Internal server error",
    cause,
  });
}

function isCreatedService(value: unknown): value is CreatedService {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const service = value as Record<string, unknown>;
  return (
    typeof service.id === "string" &&
    typeof service.name === "string" &&
    typeof service.template_slug === "string" &&
    typeof service.template_version === "number" &&
    typeof service.version === "number" &&
    (service.family === "marketplace_dataset" || service.family === "scraper_library") &&
    (service.state === "active" || service.state === "disabled") &&
    typeof service.configuration === "object" &&
    service.configuration !== null &&
    !Array.isArray(service.configuration) &&
    typeof service.created_at === "string"
  );
}

async function insertClaim(
  database: DatabaseExecutor,
  input: CreateServicePersistenceInput,
): Promise<boolean> {
  const result = await database.query<ClaimRow>(
    `
      INSERT INTO app.idempotency_records (
        id,
        organization_id,
        actor_fingerprint,
        operation_code,
        idempotency_key,
        request_hash,
        state,
        expires_at
      ) VALUES (
        $1, $2, $3, 'services.create', $4, $5, 'in_progress',
        clock_timestamp() + interval '24 hours'
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `,
    [
      input.idempotencyRecordId,
      input.tenantId,
      input.actorFingerprint,
      input.idempotencyKey,
      input.requestHash,
    ],
  );
  return result.rows[0] !== undefined;
}

async function replayExistingClaim(
  database: DatabaseExecutor,
  input: CreateServicePersistenceInput,
): Promise<CreateServicePersistenceOutcome> {
  const result = await database.query<ExistingClaimRow>(
    `
      SELECT
        actor_fingerprint,
        request_hash,
        state,
        response_status,
        resource_id,
        response_body_reference,
        response_body
      FROM app.idempotency_records
      WHERE organization_id = $1
        AND operation_code = 'services.create'
        AND idempotency_key = $2
      FOR UPDATE
    `,
    [input.tenantId, input.idempotencyKey],
  );
  const existing = result.rows[0];
  if (existing === undefined) {
    throw new ServiceAdmissionUnavailableError(
      new Error("A conflicting Service idempotency claim was not visible"),
    );
  }
  if (
    !existing.actor_fingerprint.equals(input.actorFingerprint) ||
    !existing.request_hash.equals(input.requestHash)
  ) {
    return { kind: "conflict" };
  }
  if (
    existing.state !== "completed" ||
    existing.response_status !== 201 ||
    existing.resource_id === null ||
    existing.response_body_reference !== "inline_json_v1" ||
    !isCreatedService(existing.response_body) ||
    existing.response_body.id !== existing.resource_id
  ) {
    throw new ServiceAdmissionUnavailableError(
      new Error("The Service idempotency claim is not replayable"),
    );
  }
  return { kind: "replay", service: existing.response_body };
}

async function selectEligibleTemplate(
  database: DatabaseExecutor,
  input: CreateServicePersistenceInput,
): Promise<EligibilityRow> {
  const result = await database.query<EligibilityRow>(`
    SELECT template.id AS template_id, template.state AS template_state,template.product_family,
      version.id AS template_version_id,version.version AS template_version,version.configuration_schema,
      version.availability_state,version.published_at,version.published_by,version.evidence_ref,
      (version.published_at IS NOT NULL AND version.published_at<=statement_timestamp() AND version.published_by IS NOT NULL AND version.evidence_ref IS NOT NULL) publication_approved,
      version.engine,version.execution_definition,version.definition_sha256,
      (version.provider_dataset_ciphertext IS NOT NULL AND version.provider_dataset_fingerprint IS NOT NULL) AS dataset_bound,
      organization.is_internal
    FROM app.service_templates template
    JOIN app.organizations organization ON organization.id=app.current_organization_id()
    LEFT JOIN LATERAL(SELECT draft.id,draft.version,draft.configuration_schema,draft.availability_state,draft.published_at,draft.published_by,draft.evidence_ref,
      draft.engine,draft.execution_definition,draft.definition_sha256,draft.provider_dataset_ciphertext,draft.provider_dataset_fingerprint
      FROM app.service_template_versions draft WHERE draft.service_template_id=template.id
      AND (draft.id=template.current_public_version_id OR template.state='draft' AND organization.is_internal)
      ORDER BY draft.version DESC LIMIT 1) version ON true
    WHERE template.slug=$1 AND (template.access='all' OR EXISTS (
      SELECT 1 FROM app.organization_templates allowed WHERE allowed.organization_id=app.current_organization_id() AND allowed.service_template_id=template.id))
    FOR SHARE OF template`, [input.templateSlug]);
  const row=result.rows[0];
  if (!row || !['published','disabled','draft'].includes(row.template_state) || row.template_state==='draft'&&!row.is_internal) throw new ServiceTemplateNotCreatableError();
  const internalDraft=row.template_state==='draft'&&row.is_internal;
  if ((!internalDraft&&row.template_state !== 'published') || row.template_version_id === null || row.template_version === null ||
    row.configuration_schema === null || (!internalDraft&&row.availability_state !== 'available') ||
    (!internalDraft&&!row.publication_approved)) throw new ServiceAdmissionUnavailableError();
  try { requireExecutableTemplateFacts({productFamily:row.product_family,engine:row.engine,definition:row.execution_definition,
    definitionSha256:row.definition_sha256,datasetBound:row.dataset_bound}); }
  catch (error) { if(error instanceof TemplateExecutionDefinitionError)throw new ServiceAdmissionUnavailableError(error);throw error; }
  return row;
}

async function createAndComplete(
  database: DatabaseExecutor,
  input: CreateServicePersistenceInput,
): Promise<CreatedService> {
  const eligible = await selectEligibleTemplate(database, input);
  const validation = input.validateConfiguration({
    templateVersionId: eligible.template_version_id as string,
    schema: eligible.configuration_schema,
    configuration: input.configuration,
  });
  if (!validation.valid) throw new ServiceConfigurationRejectedError(validation.issues);

  const serviceInsert = await database.query<CreatedAtRow>(
    `
      INSERT INTO app.services (
        id, organization_id, template_version_id, name, state, configuration, created_by_user_id
      ) VALUES ($1, $2, $3, $4, 'active', $5::jsonb, $6)
      RETURNING created_at
    `,
    [input.serviceId, input.tenantId, eligible.template_version_id, input.name, input.configuration, input.actor.userId],
  );
  const createdAt = serviceInsert.rows[0]?.created_at;
  if (createdAt === undefined) {
    throw new Error("The Service insert returned no creation timestamp");
  }

  const response: CreatedService = {
    id: input.serviceId,
    name: input.name,
    template_slug: input.templateSlug,
    template_version: eligible.template_version as number,
    version: 1,
    family: eligible.product_family,
    state: "active",
    configuration: input.configuration,
    created_at: createdAt.toISOString(),
  };

  await database.query(
    `
      INSERT INTO app.audit_events (
        organization_id,
        actor_user_id,
        action,
        target_type,
        target_id,
        outcome,
        trace_id,
        ip_fingerprint,
        safe_diff
      ) VALUES (
        $1, $2, 'services.create', 'service', $3, 'created', $4::uuid, $5,
        jsonb_build_object(
          'name', $6::text,
          'template_slug', $7::text,
          'template_version', $8::integer,
          'family', $9::text,
          'service_version', 1
        )
      )
    `,
    [
      input.tenantId,
      input.actor.userId,
      input.serviceId,
      input.requestId,
      input.ipFingerprint,
      input.name,
      input.templateSlug,
      eligible.template_version,
      eligible.product_family,
    ],
  );

  const completion = await database.query<ResponseBodyRow>(
    `
      UPDATE app.idempotency_records
      SET
        state = 'completed',
        response_status = 201,
        resource_type = 'service',
        resource_id = $2,
        response_body_reference = 'inline_json_v1',
        response_body = $3::jsonb,
        completed_at = clock_timestamp()
      WHERE id = $1
      RETURNING response_body
    `,
    [input.idempotencyRecordId, input.serviceId, response],
  );
  const stored = completion.rows[0]?.response_body;
  if (!isCreatedService(stored) || stored.id !== input.serviceId) {
    throw new Error("The Service replay body could not be completed");
  }
  return stored;
}

export function createServiceRepository(pool: Pool): CreateServiceRepository {
  return {
    async persist(input): Promise<CreateServicePersistenceOutcome> {
      try {
        return await withAdmissionOrganizationTransaction(
          pool,
          { tenantId: input.tenantId, userId: input.actor.userId },
          async (database) => {
            if (!(await insertClaim(database, input))) {
              return replayExistingClaim(database, input);
            }
            const service = await createAndComplete(database, input);
            return { kind: "created", service };
          },
        );
      } catch (error) {
        if (
          error instanceof ApplicationError ||
          error instanceof ServiceTemplateNotCreatableError ||
          error instanceof ServiceAdmissionUnavailableError ||
          error instanceof ServiceConfigurationRejectedError
        ) {
          throw error;
        }
        if (
          databaseErrorField(error, "code") === "23505" &&
          databaseErrorField(error, "constraint") === "services_tenant_id_name_key"
        ) {
          throw new ServiceNameConflictError(error);
        }
        throw internalFailure(error);
      }
    },
  };
}
