import type { MarketplaceField } from "../../api/generated";

export const MARKETPLACE_DEFAULT_VISIBLE_FIELD_COUNT = 7;

export function marketplaceFieldLabel(field: string): string {
  return field
    .split("_")
    .map((part) => `${part[0]?.toLocaleUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

export function marketplaceDisplayValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

export function defaultMarketplaceFields(
  fields: readonly MarketplaceField[],
): string[] {
  return fields
    .filter((field) => field.active && field.sample_visibility !== "suppressed")
    .slice(0, MARKETPLACE_DEFAULT_VISIBLE_FIELD_COUNT)
    .map((field) => field.name);
}

export function marketplaceRowKey(
  sampleVersion: number,
  rowIndex: number,
): string {
  // Sample rows intentionally do not expose a provider or database identifier.
  // The page resets expansion state after every query, so the immutable sample
  // version plus the page-local ordinal is the safest stable customer-side key.
  return `sample-${sampleVersion}-row-${rowIndex}`;
}

export function formatMarketplaceCount(value: number | null): string {
  return value === null
    ? "Not published"
    : new Intl.NumberFormat().format(value);
}

export function formatMarketplaceDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Not published";
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}
