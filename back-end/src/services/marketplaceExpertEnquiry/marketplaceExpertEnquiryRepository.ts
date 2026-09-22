import type { Pool, QueryResultRow } from "pg";
import { ApplicationError } from "../../utils/applicationError.js";
import { withTenantTransaction } from "../database/transactions.js";

export type MarketplaceExpertEnquiryActor =
  | { readonly kind: "browser"; readonly userId: string }
  | { readonly kind: "api_key"; readonly apiKeyId: string };

export type MarketplaceExpertEnquiryState =
  | "received"
  | "in_review"
  | "contacted"
  | "closed";

export interface MarketplaceExpertEnquiryRecord {
  readonly enquiryId: string;
  readonly templateSlug: string;
  readonly templateVersion: number;
  readonly state: MarketplaceExpertEnquiryState;
  readonly submittedAt: Date;
}

export type CreateMarketplaceExpertEnquiryOutcome =
  | {
      readonly kind: "created" | "replay" | "existing";
      readonly record: MarketplaceExpertEnquiryRecord;
    }
  | { readonly kind: "conflict" };

export interface MarketplaceExpertEnquiryRepository {
  create(input: {
    readonly enquiryId: string;
    readonly tenantId: string;
    readonly actor: MarketplaceExpertEnquiryActor;
    readonly actorFingerprint: Buffer;
    readonly idempotencyKey: string;
    readonly requestHash: Buffer;
    readonly templateSlug: string;
    readonly expectedTemplateVersion: number;
    readonly requestId: string | null;
    readonly ipFingerprint: Buffer | null;
  }): Promise<CreateMarketplaceExpertEnquiryOutcome>;
}

export class MarketplaceExpertEnquiryNotFoundError extends Error {}
export class MarketplaceExpertEnquiryStaleError extends Error {}
export class MarketplaceExpertEnquiryPersistenceError extends Error {
  public constructor(cause?: unknown) {
    super("Marketplace expert-enquiry persistence failed", { cause });
  }
}

interface EnquiryRow extends QueryResultRow {
  readonly disposition: "created" | "replay" | "existing" | "conflict";
  readonly enquiry_id: string;
  readonly template_slug: string;
  readonly template_version: number;
  readonly enquiry_state: MarketplaceExpertEnquiryState;
  readonly submitted_at: Date;
}

function databaseMessage(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "message" in error &&
      typeof (error as { message?: unknown }).message === "string"
    ? (error as { message: string }).message
    : undefined;
}

function mapDatabaseError(error: unknown): Error {
  const message = databaseMessage(error);
  if (message?.includes("MARKETPLACE_EXPERT_ENQUIRY_NOT_FOUND")) {
    return new MarketplaceExpertEnquiryNotFoundError();
  }
  if (message?.includes("MARKETPLACE_EXPERT_ENQUIRY_STALE")) {
    return new MarketplaceExpertEnquiryStaleError();
  }
  return new MarketplaceExpertEnquiryPersistenceError(error);
}

function toRecord(row: EnquiryRow): MarketplaceExpertEnquiryRecord {
  if (!(row.submitted_at instanceof Date) || Number.isNaN(row.submitted_at.valueOf())) {
    throw new Error("Marketplace expert-enquiry timestamp was invalid");
  }
  return {
    enquiryId: row.enquiry_id,
    templateSlug: row.template_slug,
    templateVersion: row.template_version,
    state: row.enquiry_state,
    submittedAt: row.submitted_at,
  };
}

export function createMarketplaceExpertEnquiryRepository(
  pool: Pool,
): MarketplaceExpertEnquiryRepository {
  return Object.freeze({
    async create(
      input: Parameters<MarketplaceExpertEnquiryRepository["create"]>[0],
    ) {
      try {
        return await withTenantTransaction(pool, input.tenantId, async (database) => {
          const result = await database.query<EnquiryRow>(
            `SELECT * FROM app.create_marketplace_expert_enquiry(
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
            )`,
            [
              input.enquiryId,
              input.actor.kind === "browser" ? input.actor.userId : null,
              input.actor.kind === "api_key" ? input.actor.apiKeyId : null,
              input.actorFingerprint,
              input.idempotencyKey,
              input.requestHash,
              input.templateSlug,
              input.expectedTemplateVersion,
              input.requestId,
              input.ipFingerprint,
            ],
          );
          const row = result.rows[0];
          if (row === undefined) {
            throw new Error("Expert-enquiry creation returned no row");
          }
          if (row.disposition === "conflict") return { kind: "conflict" as const };
          return { kind: row.disposition, record: toRecord(row) };
        });
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw mapDatabaseError(error);
      }
    },
  });
}
