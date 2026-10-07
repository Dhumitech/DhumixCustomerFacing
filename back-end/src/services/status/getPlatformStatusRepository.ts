import { marketplacePreviewSource } from '../marketplacePreview/marketplacePreviewQuery.js';
import type { Pool } from "pg";
import { ApplicationError } from "../../utils/applicationError.js";
import { withCustomerApiTransaction } from "../database/transactions.js";

export interface PlatformProductStatusRecord {
  readonly family: string;
  readonly state: string;
  readonly message?: string | null;
  readonly updatedAt: Date;
}

export interface GetPlatformStatusRepository {
  get(): Promise<readonly PlatformProductStatusRecord[]>;
}

interface PlatformStatusRow {
  readonly family: string;
  readonly state: string;
  readonly message: string | null;
  readonly updated_at: Date;
}

function internalFailure(cause: unknown): ApplicationError {
  return new ApplicationError({
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Internal server error",
    cause,
  });
}

export function createGetPlatformStatusRepository(
  pool: Pool,
  _providerEnvironment: "local" | "test" | "production",
): GetPlatformStatusRepository {
  return {
    async get(): Promise<readonly PlatformProductStatusRecord[]> {
      try {
        return await withCustomerApiTransaction(pool, async (database) => {
          const result = await database.query<PlatformStatusRow>(
            `
              WITH published AS (
                SELECT template.product_family,template.state,version.availability_state
                FROM app.service_templates template JOIN app.service_template_versions version
                  ON version.id=template.current_public_version_id AND version.service_template_id=template.id
                WHERE template.access='all' AND template.state IN ('published','disabled')
                  AND version.published_at IS NOT NULL AND version.published_at<=statement_timestamp()
                  AND version.published_by IS NOT NULL AND version.evidence_ref IS NOT NULL
              ), families AS (SELECT * FROM (VALUES ('scraper_library',1),('marketplace_dataset',2)) f(family,ordinal))
              SELECT f.family,CASE
                WHEN f.family='marketplace_dataset' AND EXISTS (SELECT 1 FROM ${marketplacePreviewSource}) THEN 'operational'
                WHEN count(p.product_family)=0 THEN 'not_enabled'
                WHEN bool_and(p.state='published' AND p.availability_state='available') THEN 'operational'
                WHEN bool_or(p.state='published' AND p.availability_state='available') THEN 'degraded'
                ELSE 'unavailable' END AS state,
                CASE WHEN f.family='marketplace_dataset' AND EXISTS (SELECT 1 FROM ${marketplacePreviewSource})
                  THEN 'Preview only: governed stored-sample browsing, filtering and bounded download are available; purchase and full export are not enabled.' ELSE NULL END message,
                statement_timestamp() updated_at
              FROM families f LEFT JOIN published p ON p.product_family=f.family GROUP BY f.family,f.ordinal ORDER BY f.ordinal
            `,
          );
          return result.rows.map((row) => ({
            family: row.family,
            state: row.state,
            message: row.message,
            updatedAt: row.updated_at,
          }));
        });
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw internalFailure(error);
      }
    },
  };
}
