const FIELD_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,255}$/;
const MAX_FILTER_DEPTH = 3;
const MAX_PROVIDER_IDENTIFIER_LENGTH = 512;

const comparisonOperators = new Set(["<", "<=", ">", ">="]);
const listOperators = new Set(["in", "not_in"]);
const containsOperators = new Set([
  "includes",
  "not_includes",
  "array_includes",
  "not_array_includes",
]);
const nullOperators = new Set(["is_null", "is_not_null"]);
const allLeafOperators = new Set([
  "=",
  "!=",
  ...comparisonOperators,
  ...listOperators,
  ...containsOperators,
  ...nullOperators,
]);

export type MarketplaceJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly MarketplaceJsonValue[]
  | Readonly<{ [key: string]: MarketplaceJsonValue }>;

export interface MarketplaceReviewedFilterField {
  readonly types: readonly ("array" | "boolean" | "integer" | "number" | "object" | "string")[];
  readonly format?: "date" | "date-time" | "uri";
}

export interface MarketplaceFilterRequest {
  readonly dataset_id: string;
  readonly records_limit: number;
  readonly filter: Readonly<Record<string, MarketplaceJsonValue>>;
}

export class MarketplaceFilterContractError extends Error {
  public constructor() {
    super("Marketplace Filter request did not satisfy the reviewed contract");
    this.name = "MarketplaceFilterContractError";
  }
}

export function isMarketplaceProviderIdentifier(value: unknown): value is string {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_PROVIDER_IDENTIFIER_LENGTH &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function fail(): never {
  throw new MarketplaceFilterContractError();
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key))) fail();
}

function jsonValue(value: unknown): MarketplaceJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail();
    return value;
  }
  if (Array.isArray(value)) return Object.freeze(value.map(jsonValue));
  const source = record(value);
  return Object.freeze(Object.fromEntries(
    Object.entries(source).map(([key, child]) => [key, jsonValue(child)]),
  ));
}

function providerFilterValue(value: unknown): MarketplaceJsonValue {
  if (value === null) fail();
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => {
      if (typeof item === "string" || typeof item === "boolean") return item;
      if (typeof item === "number" && Number.isFinite(item)) return item;
      fail();
    }));
  }
  if (typeof value === "object") return jsonValue(record(value));
  return jsonValue(value);
}

function supports(field: MarketplaceReviewedFilterField, type: string): boolean {
  return field.types.includes(type as MarketplaceReviewedFilterField["types"][number]);
}

function validateOperatorForField(
  operator: string,
  field: MarketplaceReviewedFilterField,
  value: unknown,
): void {
  if (comparisonOperators.has(operator)) {
    const dateLike = supports(field, "string") &&
      (field.format === "date" || field.format === "date-time");
    if (!supports(field, "number") && !supports(field, "integer") && !dateLike) fail();
  }
  if ((operator === "includes" || operator === "not_includes") &&
      !supports(field, "string") && !supports(field, "array")) fail();
  if ((operator === "array_includes" || operator === "not_array_includes") &&
      !supports(field, "array")) fail();
  if (listOperators.has(operator) && (!Array.isArray(value) || value.length < 1)) fail();
}

function normalizeFilter(
  input: unknown,
  fields: Readonly<Record<string, MarketplaceReviewedFilterField>>,
  depth: number,
): Readonly<Record<string, MarketplaceJsonValue>> {
  const value = record(input);
  const operator = value.operator;
  if (operator === "and" || operator === "or") {
    if (depth > MAX_FILTER_DEPTH) fail();
    exactKeys(value, ["operator", "filters", "combine_nested_fields"]);
    if (!Array.isArray(value.filters) || value.filters.length < 1) fail();
    if (
      value.combine_nested_fields !== undefined &&
      typeof value.combine_nested_fields !== "boolean"
    ) fail();
    return Object.freeze({
      operator,
      filters: Object.freeze(value.filters.map((child) => normalizeFilter(child, fields, depth + 1))),
      ...(value.combine_nested_fields === undefined
        ? {}
        : { combine_nested_fields: value.combine_nested_fields }),
    });
  }

  if (typeof operator !== "string" || !allLeafOperators.has(operator)) fail();
  const name = value.name;
  if (typeof name !== "string" || !FIELD_NAME_PATTERN.test(name)) fail();
  const field = fields[name];
  if (field === undefined || field.types.length < 1) fail();

  if (nullOperators.has(operator)) {
    exactKeys(value, ["name", "operator"]);
    return Object.freeze({ name, operator });
  }

  exactKeys(value, ["name", "operator", "value"]);
  if (!("value" in value)) fail();
  validateOperatorForField(operator, field, value.value);
  return Object.freeze({ name, operator, value: providerFilterValue(value.value) });
}

export function serializeMarketplaceFilterRequest(input: {
  readonly datasetId: string;
  readonly recordsLimit: number;
  readonly maximumRecords: number;
  readonly filter: unknown;
  readonly reviewedFields: Readonly<Record<string, MarketplaceReviewedFilterField>>;
}): MarketplaceFilterRequest {
  if (
    !isMarketplaceProviderIdentifier(input.datasetId) ||
    !Number.isSafeInteger(input.recordsLimit) ||
    input.recordsLimit < 1 ||
    !Number.isSafeInteger(input.maximumRecords) ||
    input.maximumRecords < 1 ||
    input.recordsLimit > input.maximumRecords ||
    Object.keys(input.reviewedFields).length < 1
  ) fail();

  return Object.freeze({
    dataset_id: input.datasetId,
    records_limit: input.recordsLimit,
    filter: normalizeFilter(input.filter, input.reviewedFields, 1),
  });
}
