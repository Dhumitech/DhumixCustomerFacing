import type { Pool, QueryResultRow } from "pg";
import { withOperatorTransaction } from "../database/transactions.js";

export interface PublishAmazonOperationInput {
  readonly expectedEnvironment: "local" | "test";
  readonly qualificationId: string;
  readonly restrictedReference: string;
  readonly evidenceHash: Buffer;
  readonly reviewer: string;
  readonly reason: string;
  readonly expiresAt: Date | null;
}

export type UpgradeAmazonProductsInputContract = Omit<
  PublishAmazonOperationInput,
  "qualificationId"
>;

export interface PublishedAmazonOperation {
  readonly operationCode: string;
  readonly templateSlug: string;
  readonly templateVersion: number;
  readonly environment: "local" | "test";
  readonly outcome: "published" | "replayed";
}

export interface AmazonOperationReleaseRepository {
  publish(input: PublishAmazonOperationInput): Promise<PublishedAmazonOperation>;
  upgradeProductsInputContract(
    input: UpgradeAmazonProductsInputContract,
  ): Promise<PublishedAmazonOperation>;
}

interface ReleaseRow extends QueryResultRow {
  readonly operation_code: string;
  readonly template_slug: string;
  readonly template_version: number;
  readonly environment: "local" | "test";
  readonly release_outcome: "published" | "replayed";
}

function publicRelease(row: ReleaseRow | undefined): PublishedAmazonOperation {
  if (row === undefined) throw new Error("Amazon operation release returned no result");
  return {
    operationCode: row.operation_code,
    templateSlug: row.template_slug,
    templateVersion: row.template_version,
    environment: row.environment,
    outcome: row.release_outcome,
  };
}

export function createAmazonOperationReleaseRepository(
  pool: Pool,
): AmazonOperationReleaseRepository {
  return {
    async publish(input): Promise<PublishedAmazonOperation> {
      const result = await withOperatorTransaction(pool, async (database) =>
        database.query<ReleaseRow>(
          `
            SELECT
              operation_code,
              template_slug,
              template_version,
              environment,
              release_outcome
            FROM app.publish_qualified_amazon_operation_v1(
              $1, $2, $3, $4, $5, $6, $7
            )
          `,
          [
            input.expectedEnvironment,
            input.qualificationId,
            input.restrictedReference,
            input.evidenceHash,
            input.reviewer,
            input.reason,
            input.expiresAt,
          ],
        ),
      );
      return publicRelease(result.rows[0]);
    },

    async upgradeProductsInputContract(
      input,
    ): Promise<PublishedAmazonOperation> {
      const result = await withOperatorTransaction(pool, async (database) =>
        database.query<ReleaseRow>(
          `
            SELECT
              operation_code,
              template_slug,
              template_version,
              environment,
              release_outcome
            FROM app.publish_amazon_products_input_contract_v4(
              $1, $2, $3, $4, $5, $6
            )
          `,
          [
            input.expectedEnvironment,
            input.restrictedReference,
            input.evidenceHash,
            input.reviewer,
            input.reason,
            input.expiresAt,
          ],
        ),
      );
      return publicRelease(result.rows[0]);
    },
  };
}
