import type { Pool } from "pg";
import type {
  CatalogProductFamily,
  CatalogTemplateListCursorPosition,
} from "../../helpers/catalogTemplateListCursor.js";
import { ApplicationError } from "../../utils/applicationError.js";
import { withTenantTransaction } from "../database/transactions.js";
import type {
  CatalogTemplateAvailability,
  PublicCatalogTemplateRecord,
  PublicCatalogTemplateState,
  TemplatePresentation,
  MarketplaceTemplateMetadata,
} from "./catalogTemplate.js";

export type ListCatalogTemplatesRecord = PublicCatalogTemplateRecord;

export interface ListCatalogTemplatesRepositoryInput {
  readonly tenantId: string;
  readonly family: CatalogProductFamily | undefined;
  readonly cursor: CatalogTemplateListCursorPosition | undefined;
  readonly fetchLimit: number;
}

export interface ListCatalogTemplatesRepository {
  list(
    input: ListCatalogTemplatesRepositoryInput,
  ): Promise<readonly ListCatalogTemplatesRecord[]>;
}

interface ListCatalogTemplatesRow {
  readonly id: string;
  readonly slug: string;
  readonly family: CatalogProductFamily;
  readonly template_state: PublicCatalogTemplateState;
  readonly version: number;
  readonly name: string;
  readonly description: string;
  readonly availability_state: CatalogTemplateAvailability;
  readonly presentation_metadata: TemplatePresentation;
  readonly configuration_schema: Readonly<Record<string, unknown>>;
  readonly input_schema: Readonly<Record<string, unknown>>;
  readonly marketplace_metadata: MarketplaceTemplateMetadata | null;
}

function internalFailure(cause: unknown): ApplicationError {
  return new ApplicationError({
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Internal server error",
    cause,
  });
}

export function createListCatalogTemplatesRepository(
  pool: Pool,
): ListCatalogTemplatesRepository {
  return {
    async list(input): Promise<readonly ListCatalogTemplatesRecord[]> {
      if (
        !Number.isInteger(input.fetchLimit) ||
        input.fetchLimit < 2 ||
        input.fetchLimit > 101
      ) {
        throw new TypeError("fetchLimit must be an integer between 2 and 101");
      }

      try {
        return await withTenantTransaction(pool, input.tenantId, async (database) => {
          const result = await database.query<ListCatalogTemplatesRow>(
            `
              WITH visible_templates AS (
                SELECT
                  template.id,
                  template.slug,
                  template.product_family AS family,
                  template.state::text AS template_state,
                  version.version,
                  version.public_name AS name,
                  version.public_description AS description,
                  version.availability_state,
                  version.presentation_metadata,
                  version.configuration_schema,
                  version.input_schema,
                  NULL::jsonb AS marketplace_metadata
                FROM app.service_templates AS template
                INNER JOIN app.service_template_versions AS version
                  ON version.service_template_id = template.id
                 AND version.id = template.current_public_version_id
                INNER JOIN app.launch_evidence AS evidence
                  ON evidence.id = version.launch_evidence_id
                WHERE template.state IN ('published', 'disabled')
                  AND version.published_at IS NOT NULL
                  AND version.published_at <= statement_timestamp()
                  AND version.effective_at IS NOT NULL
                  AND version.effective_at <= statement_timestamp()
                  AND jsonb_typeof(version.input_schema) = 'object'
                  AND jsonb_typeof(version.configuration_schema) = 'object'
                  AND jsonb_typeof(version.presentation_metadata) = 'object'
                  AND evidence.state = 'approved'
                  AND evidence.effective_at IS NOT NULL
                  AND evidence.effective_at <= statement_timestamp()
                  AND (evidence.expires_at IS NULL OR evidence.expires_at > statement_timestamp())

                UNION ALL

                SELECT
                  preview.template_id,
                  preview.template_slug,
                  'marketplace_dataset'::text,
                  'preview'::text,
                  preview.template_version,
                  preview.public_name,
                  preview.public_description,
                  'preview_available'::text,
                  preview.presentation_metadata,
                  preview.configuration_schema,
                  preview.input_schema,
                  jsonb_build_object(
                    'record_count', preview.provider_record_count,
                    'record_count_as_of', preview.provider_record_count_as_of,
                    'sample', jsonb_build_object(
                      'state', 'available',
                      'version', preview.sample_version,
                      'record_count', preview.sample_record_count,
                      'display_page_size', LEAST(preview.sample_record_count, 30),
                      'collected_at', preview.collected_at,
                      'expires_at', preview.expires_at,
                      'masking_notice',
                        'Values containing *** are masked. Counts describe only this stored sample, not the full dataset.'
                    ),
                    'capabilities', jsonb_build_object(
                      'sample_query', 'available',
                      'sample_download', 'available',
                      'full_export', 'not_enabled'
                    ),
                    'fields', preview.fields,
                    'contact_modes', COALESCE((
                      SELECT jsonb_agg(jsonb_build_object(
                        'code', contact.code,
                        'display_order', contact.display_order,
                        'customer_meaning', contact.customer_meaning,
                        'preview_state', contact.preview_state,
                        'fulfillment_state', contact.fulfillment_state
                      ) ORDER BY contact.display_order)
                      FROM app.resolve_marketplace_contact_modes(
                        preview.template_id,
                        preview.template_version
                      ) AS contact
                    ), '[]'::jsonb)
                  )
                FROM app.resolve_marketplace_sample_preview(NULL, statement_timestamp()) AS preview
              )
              SELECT *
              FROM visible_templates
              WHERE ($1::text IS NULL OR family = $1::text)
                AND ($2::text IS NULL OR (family, slug, id) > ($2::text, $3::text, $4::uuid))
              ORDER BY family ASC, slug ASC, id ASC
              LIMIT $5::integer
            `,
            [
              input.family ?? null,
              input.cursor?.family ?? null,
              input.cursor?.slug ?? null,
              input.cursor?.id ?? null,
              input.fetchLimit,
            ],
          );

          return result.rows.map((row) => ({
            id: row.id,
            slug: row.slug,
            family: row.family,
            templateState: row.template_state,
            version: row.version,
            name: row.name,
            description: row.description,
            availabilityState: row.availability_state,
            presentation: row.presentation_metadata,
            configurationSchema: row.configuration_schema,
            inputSchema: row.input_schema,
            ...(row.marketplace_metadata === null
              ? {}
              : { marketplaceMetadata: row.marketplace_metadata }),
          }));
        });
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw internalFailure(error);
      }
    },
  };
}
