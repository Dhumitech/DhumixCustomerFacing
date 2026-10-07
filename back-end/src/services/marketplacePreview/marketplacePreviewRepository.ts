import { marketplacePreviewSource } from './marketplacePreviewQuery.js';
import type { Pool, QueryResultRow } from "pg";
import { ApplicationError } from "../../utils/applicationError.js";
import { withBrowseTransaction } from "../database/transactions.js";

export type MarketplaceFieldType =
  | "text"
  | "url"
  | "date"
  | "number"
  | "array"
  | "object"
  | "boolean";
export type MarketplaceSampleVisibility = "visible" | "masked" | "suppressed";
export type MarketplaceFilterOperator =
  | "="
  | "!="
  | "in"
  | "not_in"
  | "includes"
  | "not_includes"
  | "is_null"
  | "is_not_null";

export interface MarketplacePreviewField {
  readonly name: string;
  readonly type: MarketplaceFieldType;
  readonly active: boolean;
  readonly required: boolean;
  readonly description: string;
  readonly sampleVisibility: MarketplaceSampleVisibility;
  readonly allowedOperators: readonly MarketplaceFilterOperator[];
}

export interface MarketplacePreviewManifest {
  readonly templateSlug: string;
  readonly templateVersion: number;
  readonly sampleVersion: number;
  readonly sampleRecordCount: number;
  readonly sampleByteCount: number;
  readonly sampleChecksumHex: string;
  readonly sampleObjectKey: string;
  readonly collectedAt: Date;
  readonly expiresAt: Date;
  readonly fields: readonly MarketplacePreviewField[];
}

export interface MarketplacePreviewRepository {
  resolve(input: {
    readonly userId: string;
    readonly tenantId?: string;
    readonly templateSlug: string;
  }): Promise<MarketplacePreviewManifest | undefined>;
}

interface ManifestRow extends QueryResultRow {
  readonly template_slug: string;
  readonly template_version: number;
  readonly sample_version: number;
  readonly sample_record_count: number;
  readonly sample_byte_count: string | number;
  readonly sample_checksum_hex: string;
  readonly sample_object_key: string;
  readonly collected_at: Date;
  readonly expires_at: Date;
  readonly fields: unknown;
}

function internalFailure(cause: unknown): ApplicationError {
  return new ApplicationError({
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Internal server error",
    cause,
  });
}

function parsePositiveInteger(value: unknown): number {
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
    throw new Error("Marketplace preview numeric value was invalid");
  }
  return number;
}

function parseFields(value: unknown): readonly MarketplacePreviewField[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Marketplace preview field dictionary was invalid");
  }
  return Object.freeze(
    value.map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error("Marketplace preview field dictionary was invalid");
      }
      const row = entry as Record<string, unknown>;
      if (
        typeof row.name !== "string" ||
        !["text", "url", "date", "number", "array", "object", "boolean"].includes(
          String(row.type),
        ) ||
        typeof row.active !== "boolean" ||
        typeof row.required !== "boolean" ||
        typeof row.description !== "string" ||
        !["visible", "masked", "suppressed"].includes(String(row.sample_visibility)) ||
        !Array.isArray(row.allowed_operators) ||
        !row.allowed_operators.every((operator) =>
          [
            "=",
            "!=",
            "in",
            "not_in",
            "includes",
            "not_includes",
            "is_null",
            "is_not_null",
          ].includes(String(operator)),
        )
      ) {
        throw new Error("Marketplace preview field dictionary was invalid");
      }
      return Object.freeze({
        name: row.name,
        type: row.type as MarketplaceFieldType,
        active: row.active,
        required: row.required,
        description: row.description,
        sampleVisibility: row.sample_visibility as MarketplaceSampleVisibility,
        allowedOperators: Object.freeze(row.allowed_operators as MarketplaceFilterOperator[]),
      });
    }),
  );
}

export function createMarketplacePreviewRepository(pool: Pool): MarketplacePreviewRepository {
  return Object.freeze({
    async resolve(input: Parameters<MarketplacePreviewRepository["resolve"]>[0]) {
      try {
        return await withBrowseTransaction(pool, input, async (database) => {
          const result = await database.query<ManifestRow>(
            `SELECT preview.* FROM ${marketplacePreviewSource} WHERE preview.template_slug=$1`,
            [input.templateSlug],
          );
          const row = result.rows[0];
          if (row === undefined) return undefined;
          if (
            row.template_slug !== input.templateSlug ||
            !/^[0-9a-f]{64}$/.test(row.sample_checksum_hex) ||
            !(row.collected_at instanceof Date) ||
            Number.isNaN(row.collected_at.valueOf()) ||
            !(row.expires_at instanceof Date) ||
            Number.isNaN(row.expires_at.valueOf())
          ) {
            throw new Error("Marketplace preview manifest was invalid");
          }
          return Object.freeze({
            templateSlug: row.template_slug,
            templateVersion: parsePositiveInteger(row.template_version),
            sampleVersion: parsePositiveInteger(row.sample_version),
            sampleRecordCount: parsePositiveInteger(row.sample_record_count),
            sampleByteCount: parsePositiveInteger(row.sample_byte_count),
            sampleChecksumHex: row.sample_checksum_hex,
            sampleObjectKey: row.sample_object_key,
            collectedAt: row.collected_at,
            expiresAt: row.expires_at,
            fields: parseFields(row.fields),
          });
        });
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw internalFailure(error);
      }
    },
  });
}
