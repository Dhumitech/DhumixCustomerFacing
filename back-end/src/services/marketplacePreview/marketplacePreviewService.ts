import { createHash } from "node:crypto";
import type { CsrfService } from "../../helpers/csrf.js";
import {
  decodeMarketplaceSampleCursor,
  encodeMarketplaceSampleCursor,
} from "../../helpers/marketplaceSampleCursor.js";
import { ApplicationError } from "../../utils/applicationError.js";
import type { PublicProblemCode } from "../../utils/publicProblemCode.js";
import { csrfValidationFailed } from "../identity/sessionErrors.js";
import { accessDenied } from "../tenantAccess/tenantAccessErrors.js";
import type { MarketplaceSampleStore } from "../marketplaceSample/marketplaceSampleStore.js";
import { MarketplaceSampleIntegrityError } from "../marketplaceSample/marketplaceSampleStore.js";
import type { TrustedBrowsePrincipal } from "../tenantAccess/trustedBrowsePrincipal.js";
import type {
  MarketplaceFilterOperator,
  MarketplacePreviewField,
  MarketplacePreviewManifest,
  MarketplacePreviewRepository,
} from "./marketplacePreviewRepository.js";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const MASKING_NOTICE =
  "Values containing *** are masked. Counts describe only this stored sample, not the full dataset.";

interface FilterPredicate {
  readonly name: string;
  readonly operator: MarketplaceFilterOperator;
  readonly value?: unknown;
}

interface FilterGroup {
  readonly operator: "and" | "or";
  readonly filters: readonly FilterExpression[];
}

type FilterExpression = FilterPredicate | FilterGroup;

interface SortItem {
  readonly field: string;
  readonly direction: "asc" | "desc";
}

interface QueryBody {
  readonly expected_sample_version?: unknown;
  readonly selected_fields?: unknown;
  readonly filter?: unknown;
  readonly sort?: unknown;
  readonly page?: unknown;
}

export interface MarketplaceSampleQueryResult {
  readonly template_slug: string;
  readonly template_version: number;
  readonly sample_version: number;
  readonly sample_record_count: number;
  readonly matches_in_sample: number;
  readonly selected_fields: readonly string[];
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly masking_notice: string;
  readonly page: { readonly next_cursor: string | null; readonly has_more: boolean };
}

export interface MarketplacePreviewService {
  get(input: {
    readonly principal: TrustedBrowsePrincipal;
    readonly slug: unknown;
    readonly cursor: unknown;
    readonly limit: unknown;
    readonly schemaErrors: readonly { readonly field: string; readonly message: string }[];
  }): Promise<MarketplaceSampleQueryResult>;
  query(input: {
    readonly principal: TrustedBrowsePrincipal;
    readonly slug: unknown;
    readonly csrfToken: string | undefined;
    readonly body: QueryBody;
    readonly schemaErrors: readonly { readonly field: string; readonly message: string }[];
  }): Promise<MarketplaceSampleQueryResult>;
}

interface Dependencies {
  readonly repository: MarketplacePreviewRepository;
  readonly store: MarketplaceSampleStore;
  readonly csrf: CsrfService;
  readonly cursorSecret: string;
  readonly maxBytes: number;
}

function error(
  status: number,
  code: PublicProblemCode,
  title: string,
  detail?: string,
  errors?: readonly { readonly field: string; readonly message: string }[],
): ApplicationError {
  return new ApplicationError({
    status,
    code,
    title,
    ...(detail === undefined ? {} : { detail }),
    ...(errors === undefined ? {} : { errors }),
  });
}

function validationError(field: string, message: string): ApplicationError {
  return error(
    422,
    "VALIDATION_ERROR",
    "Validation failed",
    "The Marketplace sample request is invalid.",
    [{ field, message }],
  );
}

function notFound(): ApplicationError {
  return error(404, "RESOURCE_NOT_FOUND", "Resource not found");
}

function unavailable(cause?: unknown): ApplicationError {
  return new ApplicationError({
    status: 503,
    code: "SERVICE_UNAVAILABLE",
    title: "Service unavailable",
    detail: "The stored sample is temporarily unavailable.",
    cause,
  });
}

function stateConflict(): ApplicationError {
  return error(
    409,
    "STATE_CONFLICT",
    "State conflict",
    "The stored sample changed. Refresh the dataset before continuing.",
  );
}

function parseLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  const parsed = typeof value === "string" && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (
    typeof parsed !== "number" ||
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_LIMIT
  ) {
    throw validationError("limit", "must be an integer between 1 and 100");
  }
  return parsed;
}

function recordArray(bytes: Buffer): readonly Readonly<Record<string, unknown>>[] {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    throw unavailable(cause);
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "object" || entry === null || Array.isArray(entry))
  ) {
    throw unavailable();
  }
  return value as readonly Readonly<Record<string, unknown>>[];
}

function loadFieldMap(
  manifest: MarketplacePreviewManifest,
): ReadonlyMap<string, MarketplacePreviewField> {
  return new Map(
    manifest.fields.filter((field) => field.active).map((field) => [field.name, field]),
  );
}

function selectedFields(
  value: unknown,
  fields: ReadonlyMap<string, MarketplacePreviewField>,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 100 ||
    value.some((field) => typeof field !== "string") ||
    new Set(value).size !== value.length
  ) {
    throw validationError("/selected_fields", "must contain 1-100 unique reviewed fields");
  }
  for (const field of value as string[]) {
    const definition = fields.get(field);
    if (definition === undefined || definition.sampleVisibility === "suppressed") {
      throw validationError("/selected_fields", "contains an unavailable field");
    }
  }
  return Object.freeze([...(value as string[])]);
}

function isGroup(value: Record<string, unknown>): boolean {
  return "filters" in value || value.operator === "and" || value.operator === "or";
}

function parseFilter(
  value: unknown,
  fields: ReadonlyMap<string, MarketplacePreviewField>,
  depth = 0,
): FilterExpression {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw validationError("/filter", "must be a supported filter expression");
  }
  const row = value as Record<string, unknown>;
  if (isGroup(row)) {
    if (
      depth >= 4 ||
      (row.operator !== "and" && row.operator !== "or") ||
      !Array.isArray(row.filters) ||
      row.filters.length < 1 ||
      row.filters.length > 4
    ) {
      throw validationError("/filter", "contains unsupported nesting or group size");
    }
    return Object.freeze({
      operator: row.operator,
      filters: Object.freeze(row.filters.map((item) => parseFilter(item, fields, depth + 1))),
    });
  }
  if (typeof row.name !== "string" || typeof row.operator !== "string") {
    throw validationError("/filter", "must identify a reviewed field and operator");
  }
  const field = fields.get(row.name);
  if (
    field === undefined ||
    field.sampleVisibility !== "visible" ||
    !field.allowedOperators.includes(row.operator as MarketplaceFilterOperator)
  ) {
    throw validationError("/filter", "uses an unavailable field or operator");
  }
  const operator = row.operator as MarketplaceFilterOperator;
  const nullOperator = operator === "is_null" || operator === "is_not_null";
  if (nullOperator ? "value" in row : !("value" in row)) {
    throw validationError(
      "/filter",
      nullOperator
        ? "must omit value for null operators"
        : "must include a value for this operator",
    );
  }
  if (
    (operator === "in" || operator === "not_in") &&
    (!Array.isArray(row.value) ||
      row.value.length < 1 ||
      row.value.length > 1000 ||
      row.value.some((item) => typeof item !== "string"))
  ) {
    throw validationError("/filter/value", "must be a non-empty string list");
  }
  if (
    !nullOperator &&
    operator !== "in" &&
    operator !== "not_in" &&
    typeof row.value !== "string"
  ) {
    throw validationError("/filter/value", "must be a string for this field");
  }
  return Object.freeze({
    name: row.name,
    operator,
    ...("value" in row ? { value: row.value } : {}),
  });
}

function parseSort(
  value: unknown,
  fields: ReadonlyMap<string, MarketplacePreviewField>,
): readonly SortItem[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 3) {
    throw validationError("/sort", "must contain at most three sort fields");
  }
  return Object.freeze(
    value.map((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw validationError("/sort", "contains an invalid sort item");
      }
      const row = item as Record<string, unknown>;
      const field = typeof row.field === "string" ? fields.get(row.field) : undefined;
      if (
        field === undefined ||
        field.sampleVisibility !== "visible" ||
        (row.direction !== "asc" && row.direction !== "desc")
      ) {
        throw validationError("/sort", "contains an unavailable field or direction");
      }
      return Object.freeze({ field: row.field as string, direction: row.direction });
    }),
  );
}

function compare(left: unknown, right: unknown): number {
  return String(left ?? "").localeCompare(String(right ?? ""), "en", { numeric: true });
}

function matchesPredicate(
  row: Readonly<Record<string, unknown>>,
  filter: FilterPredicate,
): boolean {
  const actual = row[filter.name];
  if (filter.operator === "is_null") return actual === null || actual === undefined;
  if (filter.operator === "is_not_null") return actual !== null && actual !== undefined;
  const text = typeof actual === "string" ? actual : String(actual ?? "");
  if (filter.operator === "=") return text === filter.value;
  if (filter.operator === "!=") return text !== filter.value;
  if (filter.operator === "includes")
    return text.toLocaleLowerCase().includes(String(filter.value).toLocaleLowerCase());
  if (filter.operator === "not_includes")
    return !text.toLocaleLowerCase().includes(String(filter.value).toLocaleLowerCase());
  if (filter.operator === "in") return (filter.value as readonly string[]).includes(text);
  return !(filter.value as readonly string[]).includes(text);
}

function matchesFilter(row: Readonly<Record<string, unknown>>, filter: FilterExpression): boolean {
  if ("filters" in filter) {
    return filter.operator === "and"
      ? filter.filters.every((child) => matchesFilter(row, child))
      : filter.filters.some((child) => matchesFilter(row, child));
  }
  return matchesPredicate(row, filter);
}

function project(
  row: Readonly<Record<string, unknown>>,
  selected: readonly string[],
  fields: ReadonlyMap<string, MarketplacePreviewField>,
): Readonly<Record<string, unknown>> {
  return Object.freeze(
    Object.fromEntries(
      selected.map((name) => {
        const field = fields.get(name) as MarketplacePreviewField;
        const value = row[name];
        return [
          name,
          field.sampleVisibility === "masked" && value !== null && value !== undefined
            ? "***"
            : (value ?? null),
        ];
      }),
    ),
  );
}

function contextHash(input: {
  readonly selected: readonly string[];
  readonly filter: FilterExpression | undefined;
  readonly sort: readonly SortItem[];
}): string {
  return createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex");
}

export function createMarketplacePreviewService(
  dependencies: Dependencies,
): MarketplacePreviewService {
  if (
    dependencies.cursorSecret.length < 32 ||
    !Number.isSafeInteger(dependencies.maxBytes) ||
    dependencies.maxBytes < 2
  ) {
    throw new TypeError("Marketplace preview configuration is invalid");
  }

  async function execute(input: {
    readonly principal: TrustedBrowsePrincipal;
    readonly slug: unknown;
    readonly expectedSampleVersion?: unknown;
    readonly selected?: unknown;
    readonly filter?: unknown;
    readonly sort?: unknown;
    readonly cursor?: unknown;
    readonly limit: unknown;
    readonly schemaErrors: readonly { readonly field: string; readonly message: string }[];
  }): Promise<MarketplaceSampleQueryResult> {
    if (input.schemaErrors.length > 0) {
      throw error(
        422,
        "VALIDATION_ERROR",
        "Validation failed",
        "The Marketplace sample request is invalid.",
        input.schemaErrors,
      );
    }
    if (typeof input.slug !== "string" || !SLUG_PATTERN.test(input.slug)) throw notFound();
    const limit = parseLimit(input.limit);
    const manifest = await dependencies.repository.resolve({
      userId: input.principal.userId,
      ...(input.principal.tenantId === undefined ? {} : { tenantId: input.principal.tenantId }),
      templateSlug: input.slug,
    });
    if (manifest === undefined) throw notFound();
    if (
      input.expectedSampleVersion !== undefined &&
      input.expectedSampleVersion !== manifest.sampleVersion
    )
      throw stateConflict();
    const fields = loadFieldMap(manifest);
    const selected =
      input.selected === undefined
        ? Object.freeze(
            manifest.fields
              .filter((field) => field.active && field.sampleVisibility !== "suppressed")
              .map((field) => field.name),
          )
        : selectedFields(input.selected, fields);
    const filter = input.filter === undefined ? undefined : parseFilter(input.filter, fields);
    const sort = parseSort(input.sort, fields);
    const hash = contextHash({ selected, filter, sort });
    let offset = 0;
    if (input.cursor !== undefined && input.cursor !== null) {
      if (typeof input.cursor !== "string")
        throw validationError("cursor", "must be a valid sample cursor");
      let position;
      try {
        position = decodeMarketplaceSampleCursor(input.cursor, dependencies.cursorSecret);
      } catch {
        throw validationError("cursor", "must be a valid sample cursor");
      }
      if (
        position.templateSlug !== manifest.templateSlug ||
        position.templateVersion !== manifest.templateVersion ||
        position.sampleVersion !== manifest.sampleVersion ||
        position.contextHash !== hash
      ) {
        throw stateConflict();
      }
      offset = position.offset;
    }
    let opened;
    try {
      opened = await dependencies.store.open(manifest.sampleObjectKey, dependencies.maxBytes);
    } catch (cause) {
      throw unavailable(cause);
    }
    if (
      opened.receipt.objectKey !== manifest.sampleObjectKey ||
      opened.receipt.contentType !== "application/json" ||
      opened.receipt.byteCount !== manifest.sampleByteCount ||
      opened.receipt.checksumHex !== manifest.sampleChecksumHex ||
      opened.bytes.byteLength !== manifest.sampleByteCount
    ) {
      throw unavailable(new MarketplaceSampleIntegrityError());
    }
    const storedRows = recordArray(opened.bytes);
    if (storedRows.length !== manifest.sampleRecordCount) throw unavailable();
    const filtered =
      filter === undefined
        ? [...storedRows]
        : storedRows.filter((row) => matchesFilter(row, filter));
    filtered.sort((left, right) => {
      for (const item of sort) {
        const compared = compare(left[item.field], right[item.field]);
        if (compared !== 0) return item.direction === "asc" ? compared : -compared;
      }
      return storedRows.indexOf(left) - storedRows.indexOf(right);
    });
    if (offset > filtered.length) throw stateConflict();
    const pageRows = filtered.slice(offset, offset + limit);
    const nextOffset = offset + pageRows.length;
    const hasMore = nextOffset < filtered.length;
    return Object.freeze({
      template_slug: manifest.templateSlug,
      template_version: manifest.templateVersion,
      sample_version: manifest.sampleVersion,
      sample_record_count: manifest.sampleRecordCount,
      matches_in_sample: filtered.length,
      selected_fields: selected,
      rows: Object.freeze(pageRows.map((row) => project(row, selected, fields))),
      masking_notice: MASKING_NOTICE,
      page: Object.freeze({
        next_cursor: hasMore
          ? encodeMarketplaceSampleCursor(
              {
                templateSlug: manifest.templateSlug,
                templateVersion: manifest.templateVersion,
                sampleVersion: manifest.sampleVersion,
                contextHash: hash,
                offset: nextOffset,
              },
              dependencies.cursorSecret,
            )
          : null,
        has_more: hasMore,
      }),
    });
  }

  return Object.freeze({
    async get(input: Parameters<MarketplacePreviewService["get"]>[0]) {
      return execute({ ...input, limit: input.limit });
    },
    async query(input: Parameters<MarketplacePreviewService["query"]>[0]) {
      if (input.principal.kind !== "browser") {
        throw accessDenied();
      }
      if (
        input.csrfToken === undefined ||
        !dependencies.csrf.verify(input.principal.sessionId, input.csrfToken)
      ) {
        throw csrfValidationFailed();
      }
      const page =
        typeof input.body.page === "object" &&
        input.body.page !== null &&
        !Array.isArray(input.body.page)
          ? (input.body.page as Record<string, unknown>)
          : {};
      return execute({
        principal: input.principal,
        slug: input.slug,
        expectedSampleVersion: input.body.expected_sample_version,
        selected: input.body.selected_fields,
        filter: input.body.filter,
        sort: input.body.sort,
        cursor: page.cursor,
        limit: page.limit,
        schemaErrors: input.schemaErrors,
      });
    },
  });
}
