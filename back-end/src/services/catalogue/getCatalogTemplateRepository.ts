import { marketplacePreviewSource } from '../marketplacePreview/marketplacePreviewQuery.js';
import type { Pool } from "pg";
import { ApplicationError } from "../../utils/applicationError.js";
import { withBrowseTransaction } from "../database/transactions.js";
import type {
  CatalogTemplateAvailability,
  PublicCatalogTemplateRecord,
  PublicCatalogTemplateState,
  TemplatePresentation,
  MarketplaceTemplateMetadata,
} from "./catalogTemplate.js";

export interface GetCatalogTemplateRepositoryInput {
  readonly userId: string;
  readonly tenantId?: string;
  readonly slug: string;
}

export interface GetCatalogTemplateRepository {
  findBySlug(
    input: GetCatalogTemplateRepositoryInput,
  ): Promise<PublicCatalogTemplateRecord | undefined>;
}

interface GetCatalogTemplateRow {
  readonly id: string;
  readonly slug: string;
  readonly family: PublicCatalogTemplateRecord["family"];
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

export function createGetCatalogTemplateRepository(pool: Pool): GetCatalogTemplateRepository {
  return {
    async findBySlug(input): Promise<PublicCatalogTemplateRecord | undefined> {
      try {
        return await withBrowseTransaction(pool, input, async (database) => {
          const result = await database.query<GetCatalogTemplateRow>(
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
                WHERE template.slug = $1
                  AND template.state IN ('published', 'disabled')
                  AND version.published_at IS NOT NULL
                  AND version.published_at <= statement_timestamp()
                  AND jsonb_typeof(version.input_schema) = 'object'
                  AND jsonb_typeof(version.configuration_schema) = 'object'
                  AND jsonb_typeof(version.presentation_metadata) = 'object'
                  AND version.published_by IS NOT NULL
                  AND version.evidence_ref IS NOT NULL

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
                      FROM jsonb_to_recordset(COALESCE(preview.presentation_metadata->'contact_modes','[]'::jsonb)) AS contact(code text,display_order integer,customer_meaning text,preview_state text,fulfillment_state text)
                    ), '[]'::jsonb)
                  )
                FROM ${marketplacePreviewSource} WHERE preview.template_slug=$1
              )
              SELECT * FROM visible_templates
              LIMIT 1
            `,
            [input.slug],
          );

          const row = result.rows[0];
          return row === undefined
            ? undefined
            : {
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
              };
        });
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw internalFailure(error);
      }
    },
  };
}
