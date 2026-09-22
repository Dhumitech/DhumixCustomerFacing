import type { Pool } from "pg";
import type { DatabaseExecutor } from "../../types/database.js";
import { ApplicationError } from "../../utils/applicationError.js";
import { withAdmissionTenantTransaction } from "../database/transactions.js";
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
  readonly serviceVersionId: string;
  readonly tenantId: string;
  readonly actor:
    | { readonly kind: "browser"; readonly userId: string }
    | { readonly kind: "api_key"; readonly apiKeyId: string };
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
  readonly template_state: "draft" | "published" | "disabled" | "retired";
  readonly current_public_version_id: string | null;
  readonly product_family: ServiceProductFamily;
  readonly template_version_id: string | null;
  readonly template_version: number | null;
  readonly configuration_schema: unknown;
  readonly availability_state:
    | "available"
    | "temporarily_unavailable"
    | "coming_soon"
    | null;
  readonly version_current: boolean | null;
  readonly template_evidence_current: boolean | null;
  readonly adapter_enabled: boolean | null;
  readonly mapping_id: string | null;
  readonly mapping_adapter_matches: boolean | null;
  readonly mapping_evidence_current: boolean | null;
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
        tenant_id,
        scope_kind,
        actor_fingerprint,
        operation_code,
        idempotency_key,
        request_hash,
        state,
        expires_at
      ) VALUES (
        $1, $2, 'tenant', $3, 'services.create', $4, $5, 'in_progress',
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
      WHERE tenant_id = $1
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
  const result = await database.query<EligibilityRow>(
    `
      SELECT
        template.id AS template_id,
        template.state AS template_state,
        template.current_public_version_id,
        template.product_family,
        template_version.id AS template_version_id,
        template_version.version AS template_version,
        template_version.configuration_schema,
        template_version.availability_state,
        (
          template_version.published_at IS NOT NULL
          AND template_version.published_at <= statement_timestamp()
          AND template_version.effective_at IS NOT NULL
          AND template_version.effective_at <= statement_timestamp()
        ) AS version_current,
        (
          template_evidence.state = 'approved'
          AND template_evidence.effective_at IS NOT NULL
          AND template_evidence.effective_at <= statement_timestamp()
          AND (
            template_evidence.expires_at IS NULL
            OR template_evidence.expires_at > statement_timestamp()
          )
        ) AS template_evidence_current,
        (adapter_version.state = 'enabled') AS adapter_enabled,
        mapping.id AS mapping_id,
        (mapping.adapter_version_id = template_version.adapter_version_id)
          AS mapping_adapter_matches,
        (
          mapping_evidence.state = 'approved'
          AND mapping_evidence.effective_at IS NOT NULL
          AND mapping_evidence.effective_at <= statement_timestamp()
          AND (
            mapping_evidence.expires_at IS NULL
            OR mapping_evidence.expires_at > statement_timestamp()
          )
        ) AS mapping_evidence_current
      FROM app.service_templates AS template
      LEFT JOIN app.service_template_versions AS template_version
        ON template_version.id = template.current_public_version_id
       AND template_version.service_template_id = template.id
      LEFT JOIN app.launch_evidence AS template_evidence
        ON template_evidence.id = template_version.launch_evidence_id
      LEFT JOIN app.adapter_versions AS adapter_version
        ON adapter_version.id = template_version.adapter_version_id
      LEFT JOIN app.provider_mappings AS mapping
        ON mapping.service_template_version_id = template_version.id
       AND mapping.environment = $2
       AND mapping.state = 'enabled'
      LEFT JOIN app.launch_evidence AS mapping_evidence
        ON mapping_evidence.id = mapping.launch_evidence_id
      WHERE template.slug = $1
    `,
    [input.templateSlug, input.providerEnvironment],
  );
  const row = result.rows[0];
  if (row === undefined || (row.template_state !== "published" && row.template_state !== "disabled")) {
    throw new ServiceTemplateNotCreatableError();
  }
  if (
    row.template_state !== "published" ||
    row.current_public_version_id === null ||
    row.template_version_id === null ||
    row.template_version === null ||
    row.configuration_schema === null ||
    row.availability_state !== "available" ||
    row.version_current !== true ||
    row.template_evidence_current !== true ||
    row.adapter_enabled !== true ||
    row.mapping_id === null ||
    row.mapping_adapter_matches !== true ||
    row.mapping_evidence_current !== true
  ) {
    throw new ServiceAdmissionUnavailableError();
  }
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
        id, tenant_id, service_template_id, name, state, current_version
      ) VALUES ($1, $2, $3, $4, 'active', 1)
      RETURNING created_at
    `,
    [input.serviceId, input.tenantId, eligible.template_id, input.name],
  );
  const createdAt = serviceInsert.rows[0]?.created_at;
  if (createdAt === undefined) {
    throw new Error("The Service insert returned no creation timestamp");
  }

  await database.query(
    `
      INSERT INTO app.service_versions (
        id,
        tenant_id,
        service_id,
        version,
        service_template_version_id,
        validated_configuration,
        schema_hash,
        created_by_user_id,
        created_by_api_key_id
      ) VALUES ($1, $2, $3, 1, $4, $5::jsonb, $6, $7, $8)
    `,
    [
      input.serviceVersionId,
      input.tenantId,
      input.serviceId,
      eligible.template_version_id,
      input.configuration,
      validation.schemaHash,
      input.actor.kind === "browser" ? input.actor.userId : null,
      input.actor.kind === "api_key" ? input.actor.apiKeyId : null,
    ],
  );

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
        tenant_id,
        actor_user_id,
        actor_api_key_id,
        action,
        target_type,
        target_id,
        outcome,
        request_id,
        ip_fingerprint,
        safe_diff
      ) VALUES (
        $1, $2, $3, 'services.create', 'service', $4, 'created', $5, $6,
        jsonb_build_object(
          'name', $7::text,
          'template_slug', $8::text,
          'template_version', $9::integer,
          'family', $10::text,
          'service_version', 1
        )
      )
    `,
    [
      input.tenantId,
      input.actor.kind === "browser" ? input.actor.userId : null,
      input.actor.kind === "api_key" ? input.actor.apiKeyId : null,
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
        completed_at = clock_timestamp(),
        updated_at = clock_timestamp()
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
        return await withAdmissionTenantTransaction(pool, input.tenantId, async (database) => {
          if (!(await insertClaim(database, input))) {
            return replayExistingClaim(database, input);
          }
          const service = await createAndComplete(database, input);
          return { kind: "created", service };
        });
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
