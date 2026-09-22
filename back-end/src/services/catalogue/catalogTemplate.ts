import type { CatalogProductFamily } from "../../helpers/catalogTemplateListCursor.js";

export const CATALOG_TEMPLATE_AVAILABILITY = [
  "available",
  "preview_available",
  "temporarily_unavailable",
  "coming_soon",
] as const;

export type CatalogTemplateAvailability =
  (typeof CATALOG_TEMPLATE_AVAILABILITY)[number];
export type PublicCatalogTemplateState = "published" | "preview" | "disabled";

export interface MarketplaceContactMode {
  readonly code: "standard" | "enriched_when_available" | "contacts_only";
  readonly display_order: 1 | 2 | 3;
  readonly customer_meaning: string;
  readonly preview_state: "available" | "not_enabled";
  readonly fulfillment_state: "not_enabled";
}

export interface MarketplaceTemplateMetadata {
  readonly record_count: number | null;
  readonly record_count_as_of: string;
  readonly sample: {
    readonly state: "available";
    readonly version: number;
    readonly record_count: number;
    readonly display_page_size: number;
    readonly collected_at: string;
    readonly expires_at: string;
    readonly masking_notice: string;
  };
  readonly capabilities: {
    readonly sample_query: "available";
    readonly sample_download: "available";
    readonly full_export: "not_enabled";
  };
  readonly fields: readonly {
    readonly name: string;
    readonly type: "text" | "url" | "date" | "number" | "array" | "object" | "boolean";
    readonly active: boolean;
    readonly required: boolean;
    readonly description: string;
    readonly sample_visibility: "visible" | "masked" | "suppressed";
    readonly allowed_operators: readonly string[];
  }[];
  readonly contact_modes: readonly MarketplaceContactMode[];
}

export interface TemplatePresentation {
  readonly domain_slug: string;
  readonly domain_name: string;
  readonly category: string;
  readonly icon_key: string;
  readonly operation_group: string;
  readonly operation_name: string;
  readonly display_priority: number;
}

/** Safe database projection shared by the public catalogue list and item reads. */
export interface PublicCatalogTemplateRecord {
  readonly id: string;
  readonly slug: string;
  readonly family: CatalogProductFamily;
  readonly templateState: PublicCatalogTemplateState;
  readonly version: number;
  readonly name: string;
  readonly description: string;
  readonly availabilityState: CatalogTemplateAvailability;
  readonly presentation: TemplatePresentation;
  readonly configurationSchema: Readonly<Record<string, unknown>>;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly marketplaceMetadata?: MarketplaceTemplateMetadata;
}

/** Exact customer-facing ServiceTemplate shape from the accepted OpenAPI contract. */
export interface ServiceTemplate {
  readonly slug: string;
  readonly version: number;
  readonly family: CatalogProductFamily;
  readonly name: string;
  readonly description: string;
  readonly availability: CatalogTemplateAvailability;
  readonly presentation: TemplatePresentation;
  readonly configuration_schema: Readonly<Record<string, unknown>>;
  readonly input_schema: Readonly<Record<string, unknown>>;
  readonly marketplace?: MarketplaceTemplateMetadata;
}

/** Centralizes the safe non-disclosure boundary for both public reads. */
export function toServiceTemplate(record: PublicCatalogTemplateRecord): ServiceTemplate {
  return {
    slug: record.slug,
    version: record.version,
    family: record.family,
    name: record.name,
    description: record.description,
    availability:
      record.templateState === "disabled"
        ? "temporarily_unavailable"
        : record.availabilityState,
    presentation: record.presentation,
    configuration_schema: record.configurationSchema,
    input_schema: record.inputSchema,
    ...(record.marketplaceMetadata === undefined
      ? {}
      : { marketplace: record.marketplaceMetadata }),
  };
}
