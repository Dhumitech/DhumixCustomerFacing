import type { TemplatePresentation } from "../../catalogue/catalogTemplate.js";
import { getAmazonPreciseOutputContract } from "./amazonOutputContracts.js";

export type JsonSchemaDocument = Readonly<Record<string, unknown>>;

export type AmazonProviderRequestPolicy =
  | Readonly<{ mode: "collect" }>
  | Readonly<{ mode: "discover"; discoverBy: AmazonDiscoverySelector }>;

export type AmazonDiscoverySelector =
  | "category_url"
  | "keyword"
  | "upc"
  | "best_sellers_url"
  | "brand"
  | "seller";

export type AmazonOutputFamily = "product" | "review" | "seller";

export type AmazonFieldKind =
  | "string"
  | "number"
  | "boolean"
  | "string_array"
  | "url";

export type AmazonUrlRole =
  | "amazon_url"
  | "amazon_origin"
  | "product_url"
  | "category_url"
  | "best_sellers_url"
  | "brand_url"
  | "seller_url";

export interface AmazonTargetFieldDefinition {
  readonly name: string;
  readonly kind: AmazonFieldKind;
  readonly required: boolean;
  readonly urlRole?: AmazonUrlRole;
  readonly nonEmpty?: true;
}

export interface AmazonOperationDefinition {
  readonly operationCode: string;
  readonly slug: string;
  readonly publicName: string;
  readonly presentation: TemplatePresentation;
  readonly configurationSchema: JsonSchemaDocument;
  readonly inputSchema: JsonSchemaDocument;
  readonly targetFields: readonly AmazonTargetFieldDefinition[];
  readonly example: Readonly<{
    targets: readonly Readonly<Record<string, unknown>>[];
  }>;
  readonly mappingLabel: string;
  readonly providerRequest: AmazonProviderRequestPolicy;
  readonly lifecycle: Readonly<{
    submit: true;
    inlineResult: true;
    snapshotFallback: true;
    multipart: "conditional";
    cancel: "conditional";
  }>;
  readonly output: Readonly<{
    family: AmazonOutputFamily;
    contractVersion: "observed-0.1";
    normalizerCode: string;
    normalizerVersion: 1;
    schemaVersion: string;
    preciseContract:
      | Readonly<{
          state: "available";
          normalizerCode: string;
          normalizerVersion: 2;
          schemaVersion: string;
        }>
      | Readonly<{ state: "unavailable" }>;
  }>;
  readonly usage: Readonly<{
    meterCode: "amazon.result_records.observed";
    quantitySource: "normalized_record_count";
    qualification: "pending";
  }>;
  readonly qualificationState: "pending";
  readonly publicationState: "draft";
}

export const AMAZON_CONFIGURATION_SCHEMA: JsonSchemaDocument = deepFreeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:dhumi:schema:amazon:configuration:v1",
  type: "object",
  additionalProperties: false,
  properties: {},
});

const OUTPUT_SCHEMAS = deepFreeze({
  product: {
    contractVersion: "observed-0.1" as const,
    normalizerCode: "amazon.product.observed-array",
    normalizerVersion: 1 as const,
    schemaVersion: "amazon.product.output.observed-0.1",
  },
  review: {
    contractVersion: "observed-0.1" as const,
    normalizerCode: "amazon.review.observed-array",
    normalizerVersion: 1 as const,
    schemaVersion: "amazon.review.output.observed-0.1",
  },
  seller: {
    contractVersion: "observed-0.1" as const,
    normalizerCode: "amazon.seller.observed-array",
    normalizerVersion: 1 as const,
    schemaVersion: "amazon.seller.output.observed-0.1",
  },
});

const LIFECYCLE = deepFreeze({
  submit: true as const,
  inlineResult: true as const,
  snapshotFallback: true as const,
  multipart: "conditional" as const,
  cancel: "conditional" as const,
});

const USAGE = deepFreeze({
  meterCode: "amazon.result_records.observed" as const,
  quantitySource: "normalized_record_count" as const,
  qualification: "pending" as const,
});

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function presentation(
  operationGroup: string,
  operationName: string,
  displayPriority: number,
): TemplatePresentation {
  return {
    domain_slug: "amazon-com",
    domain_name: "amazon.com",
    category: "e-commerce",
    icon_key: "amazon",
    operation_group: operationGroup,
    operation_name: operationName,
    display_priority: displayPriority,
  };
}

function schemaProperty(field: AmazonTargetFieldDefinition): JsonSchemaDocument {
  switch (field.kind) {
    case "url":
      return { type: "string", format: "uri" };
    case "string":
      return {
        type: "string",
        ...(field.required || field.nonEmpty === true ? { minLength: 1 } : {}),
      };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "string_array":
      return { type: "array", items: { type: "string" } };
  }
}

function targetInputSchema(
  id: string,
  fields: readonly AmazonTargetFieldDefinition[],
): JsonSchemaDocument {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: id,
    type: "object",
    additionalProperties: false,
    required: ["targets"],
    properties: {
      targets: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: fields.filter((field) => field.required).map((field) => field.name),
          properties: Object.fromEntries(
            fields.map((field) => [field.name, schemaProperty(field)]),
          ),
        },
      },
    },
  };
}

function definition(input: {
  readonly operationCode: string;
  readonly slug: string;
  readonly publicName: string;
  readonly group: string;
  readonly name: string;
  readonly priority: number;
  readonly schemaId: string;
  readonly fields: readonly AmazonTargetFieldDefinition[];
  readonly example: Readonly<{ targets: readonly Readonly<Record<string, unknown>>[] }>;
  readonly mappingLabel: string;
  readonly providerRequest: AmazonProviderRequestPolicy;
  readonly outputFamily: AmazonOutputFamily;
}): AmazonOperationDefinition {
  const preciseContract = getAmazonPreciseOutputContract(input.operationCode);
  return deepFreeze({
    operationCode: input.operationCode,
    slug: input.slug,
    publicName: input.publicName,
    presentation: presentation(input.group, input.name, input.priority),
    configurationSchema: AMAZON_CONFIGURATION_SCHEMA,
    inputSchema: targetInputSchema(input.schemaId, input.fields),
    targetFields: input.fields,
    example: input.example,
    mappingLabel: input.mappingLabel,
    providerRequest: input.providerRequest,
    lifecycle: LIFECYCLE,
    output: {
      family: input.outputFamily,
      ...OUTPUT_SCHEMAS[input.outputFamily],
      preciseContract: preciseContract === undefined
        ? { state: "unavailable" as const }
        : {
            state: "available" as const,
            normalizerCode: preciseContract.normalizerCode,
            normalizerVersion: preciseContract.normalizerVersion,
            schemaVersion: preciseContract.schemaVersion,
          },
    },
    usage: USAGE,
    qualificationState: "pending" as const,
    publicationState: "draft" as const,
  });
}

const url = (name: string, role: AmazonUrlRole): AmazonTargetFieldDefinition => ({
  name,
  kind: "url",
  required: true,
  urlRole: role,
});
const requiredString = (name: string): AmazonTargetFieldDefinition => ({
  name,
  kind: "string",
  required: true,
});
const optionalString = (name: string, requireNonEmpty = false): AmazonTargetFieldDefinition => ({
  name,
  kind: "string",
  required: false,
  ...(requireNonEmpty ? { nonEmpty: true as const } : {}),
});
const optionalNumber = (name: string): AmazonTargetFieldDefinition => ({
  name,
  kind: "number",
  required: false,
});

export const AMAZON_OPERATION_DEFINITIONS: readonly AmazonOperationDefinition[] =
  deepFreeze([
    definition({
      operationCode: "amazon.products.collect_by_url",
      slug: "amazon-products-collect-by-url",
      publicName: "Amazon products — Collect by URL",
      group: "Amazon products",
      name: "Collect by URL",
      priority: 100,
      schemaId: "urn:dhumi:schema:amazon:products:collect-by-url:input:v1",
      fields: [
        url("url", "product_url"),
        optionalString("zipcode"),
        optionalString("language"),
        { name: "all_variations", kind: "boolean", required: false },
      ],
      example: {
        targets: [
          {
            url: "https://www.amazon.com/dp/B0CHHSFMRL",
            zipcode: "94107",
            language: "EN",
            all_variations: true,
          },
        ],
      },
      mappingLabel: "M-AMAZON-PRODUCTS",
      providerRequest: { mode: "collect" },
      outputFamily: "product",
    }),
    definition({
      operationCode: "amazon.products_global.collect_by_url",
      slug: "amazon-products-global-collect-by-url",
      publicName: "Amazon products global — Collect by URL",
      group: "Amazon products global",
      name: "Collect by URL",
      priority: 200,
      schemaId: "urn:dhumi:schema:amazon:products-global:collect-by-url:input:v1",
      fields: [url("url", "product_url"), optionalNumber("bought_past_month")],
      example: {
        targets: [
          {
            url: "https://www.amazon.de/-/en/dp/B078TNNZK3",
            bought_past_month: 100,
          },
        ],
      },
      mappingLabel: "M-AMAZON-PRODUCTS-GLOBAL",
      providerRequest: { mode: "collect" },
      outputFamily: "product",
    }),
    definition({
      operationCode: "amazon.products_search.collect_by_url",
      slug: "amazon-products-search-collect-by-url",
      publicName: "Amazon products search — Collect by URL",
      group: "Amazon products search",
      name: "Collect by URL",
      priority: 300,
      schemaId: "urn:dhumi:schema:amazon:products-search:collect-by-url:input:v1",
      fields: [
        requiredString("keyword"),
        url("url", "amazon_origin"),
        optionalNumber("pages_to_search"),
      ],
      example: {
        targets: [
          { keyword: "X-box", url: "https://www.amazon.com/", pages_to_search: 2 },
        ],
      },
      mappingLabel: "M-AMAZON-PRODUCTS-SEARCH",
      providerRequest: { mode: "collect" },
      outputFamily: "product",
    }),
    definition({
      operationCode: "amazon.reviews.collect_by_url",
      slug: "amazon-reviews-collect-by-url",
      publicName: "Amazon reviews — Collect by URL",
      group: "Amazon reviews",
      name: "Collect by URL",
      priority: 400,
      schemaId: "urn:dhumi:schema:amazon:reviews:collect-by-url:input:v1",
      fields: [
        url("url", "amazon_url"),
        { name: "reviews_to_not_include", kind: "string_array", required: false },
      ],
      example: { targets: [{ url: "https://www.amazon.com/dp/B0CHHSFMRL" }] },
      mappingLabel: "M-AMAZON-REVIEWS",
      providerRequest: { mode: "collect" },
      outputFamily: "review",
    }),
    definition({
      operationCode: "amazon.sellers.collect_by_url",
      slug: "amazon-sellers-info-collect-by-url",
      publicName: "Amazon sellers info — Collect by URL",
      group: "Amazon sellers info",
      name: "Collect by URL",
      priority: 500,
      schemaId: "urn:dhumi:schema:amazon:sellers:collect-by-url:input:v1",
      fields: [url("url", "seller_url")],
      example: {
        targets: [{ url: "https://www.amazon.com/sp?ie=UTF8&seller=A2FE2Y3KEQLBV7" }],
      },
      mappingLabel: "M-AMAZON-SELLERS",
      providerRequest: { mode: "collect" },
      outputFamily: "seller",
    }),
    definition({
      operationCode: "amazon.products_global.discover_by_category_url",
      slug: "amazon-products-global-discover-by-category-url",
      publicName: "Amazon products global — Discover by category URL",
      group: "Amazon products global",
      name: "Discover by category URL",
      priority: 210,
      schemaId: "urn:dhumi:schema:amazon:products-global:discover-by-category-url:input:v1",
      fields: [url("category_url", "category_url"), optionalNumber("num_of_products")],
      example: {
        targets: [
          { category_url: "https://www.amazon.de/-/en/b?node=340843031", num_of_products: 25 },
        ],
      },
      mappingLabel: "M-AMAZON-PRODUCTS-GLOBAL",
      providerRequest: { mode: "discover", discoverBy: "category_url" },
      outputFamily: "product",
    }),
    definition({
      operationCode: "amazon.products.discover_by_category_url",
      slug: "amazon-products-discover-by-category-url",
      publicName: "Amazon products — Discover by category URL",
      group: "Amazon products",
      name: "Discover by category URL",
      priority: 110,
      schemaId: "urn:dhumi:schema:amazon:products:discover-by-category-url:input:v1",
      fields: [url("url", "category_url")],
      example: { targets: [{ url: "https://www.amazon.com/s?bbn=172282&rh=n%3A172282" }] },
      mappingLabel: "M-AMAZON-PRODUCTS",
      providerRequest: { mode: "discover", discoverBy: "category_url" },
      outputFamily: "product",
    }),
    definition({
      operationCode: "amazon.products.discover_by_keyword",
      slug: "amazon-products-discover-by-keyword",
      publicName: "Amazon products — Discover by keyword",
      group: "Amazon products",
      name: "Discover by keyword",
      priority: 120,
      schemaId: "urn:dhumi:schema:amazon:products:discover-by-keyword:input:v1",
      fields: [
        requiredString("keyword"),
        optionalString("zipcode", true),
      ],
      example: { targets: [{ keyword: "wireless mouse", zipcode: "10001" }] },
      mappingLabel: "M-AMAZON-PRODUCTS",
      providerRequest: { mode: "discover", discoverBy: "keyword" },
      outputFamily: "product",
    }),
    definition({
      operationCode: "amazon.products.discover_by_upc",
      slug: "amazon-products-discover-by-upc",
      publicName: "Amazon products — Discover by UPC",
      group: "Amazon products",
      name: "Discover by UPC",
      priority: 130,
      schemaId: "urn:dhumi:schema:amazon:products:discover-by-upc:input:v1",
      fields: [requiredString("upc")],
      example: { targets: [{ upc: "012345678901" }] },
      mappingLabel: "M-AMAZON-PRODUCTS",
      providerRequest: { mode: "discover", discoverBy: "upc" },
      outputFamily: "product",
    }),
    definition({
      operationCode: "amazon.products.discover_by_best_sellers_url",
      slug: "amazon-products-discover-by-best-sellers-url",
      publicName: "Amazon products — Discover by best sellers URL",
      group: "Amazon products",
      name: "Discover by best sellers URL",
      priority: 140,
      schemaId: "urn:dhumi:schema:amazon:products:discover-by-best-sellers-url:input:v1",
      fields: [url("url", "best_sellers_url")],
      example: {
        targets: [
          { url: "https://www.amazon.com/Best-Sellers-Electronics/zgbs/electronics" },
        ],
      },
      mappingLabel: "M-AMAZON-PRODUCTS",
      providerRequest: { mode: "discover", discoverBy: "best_sellers_url" },
      outputFamily: "product",
    }),
    definition({
      operationCode: "amazon.products_global.discover_by_brand",
      slug: "amazon-products-global-discover-by-brand",
      publicName: "Amazon products global — Discover by brand",
      group: "Amazon products global",
      name: "Discover by brand",
      priority: 220,
      schemaId: "urn:dhumi:schema:amazon:products-global:discover-by-brand:input:v1",
      fields: [url("brand_url", "brand_url"), optionalNumber("num_of_products")],
      example: {
        targets: [
          {
            brand_url:
              "https://www.amazon.com/stores/BrandName/page/12345678-ABCD-1234-EFGH-123456789012",
            num_of_products: 20,
          },
        ],
      },
      mappingLabel: "M-AMAZON-PRODUCTS-GLOBAL",
      providerRequest: { mode: "discover", discoverBy: "brand" },
      outputFamily: "product",
    }),
    definition({
      operationCode: "amazon.products_global.discover_by_keyword",
      slug: "amazon-products-global-discover-by-keyword",
      publicName: "Amazon products global — Discover by keyword",
      group: "Amazon products global",
      name: "Discover by keyword",
      priority: 230,
      schemaId: "urn:dhumi:schema:amazon:products-global:discover-by-keyword:input:v1",
      fields: [
        requiredString("keyword"),
        url("url", "amazon_origin"),
        optionalNumber("pages_to_search"),
      ],
      example: {
        targets: [
          { keyword: "laptop stand", url: "https://www.amazon.com/", pages_to_search: 3 },
        ],
      },
      mappingLabel: "M-AMAZON-PRODUCTS-GLOBAL",
      providerRequest: { mode: "discover", discoverBy: "keyword" },
      outputFamily: "product",
    }),
    definition({
      operationCode: "amazon.products_global.discover_by_seller",
      slug: "amazon-products-global-discover-by-seller",
      publicName: "Amazon products global — Discover by seller",
      group: "Amazon products global",
      name: "Discover by seller",
      priority: 240,
      schemaId: "urn:dhumi:schema:amazon:products-global:discover-by-seller:input:v1",
      fields: [url("seller_url", "seller_url"), optionalNumber("num_of_products")],
      example: {
        targets: [
          {
            seller_url: "https://www.amazon.com/sp?ie=UTF8&seller=A2FE2Y3KEQLBV7",
            num_of_products: 30,
          },
        ],
      },
      mappingLabel: "M-AMAZON-PRODUCTS-GLOBAL",
      providerRequest: { mode: "discover", discoverBy: "seller" },
      outputFamily: "product",
    }),
  ]);

const byOperationCode = new Map(
  AMAZON_OPERATION_DEFINITIONS.map((item) => [item.operationCode, item]),
);

export function getAmazonOperationDefinition(
  operationCode: string,
): AmazonOperationDefinition | undefined {
  return byOperationCode.get(operationCode);
}
