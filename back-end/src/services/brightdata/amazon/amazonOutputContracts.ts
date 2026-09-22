export type AmazonOutputSchemaDocument = Readonly<Record<string, unknown>>;

export interface AmazonPreciseOutputContract {
  readonly operationCode: string;
  readonly normalizerCode: string;
  readonly normalizerVersion: 2;
  readonly schemaVersion: string;
  readonly outputSchema: AmazonOutputSchemaDocument;
  readonly projectedFields: readonly string[];
  readonly example: readonly Readonly<Record<string, unknown>>[];
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function objectArraySchema(input: {
  readonly id: string;
  readonly fields: Readonly<Record<string, AmazonOutputSchemaDocument>>;
}): AmazonOutputSchemaDocument {
  const required = Object.keys(input.fields);
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: input.id,
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required,
      properties: input.fields,
    },
  };
}

const PRODUCT_FIELDS = deepFreeze({
  asin: { type: "string" },
  title: { type: "string" },
  url: { type: "string", format: "uri" },
  domain: { type: "string" },
  currency: { type: "string" },
  final_price: { type: "number" },
  initial_price: { type: "number" },
  rating: { type: "number" },
  reviews_count: { type: "number" },
  availability: { type: "string" },
  brand: { type: "string" },
  image_url: { type: "string", format: "uri" },
  timestamp: { type: "string" },
});

const SEARCH_FIELDS = deepFreeze({
  asin: { type: ["string", "null"] },
  name: { type: "string" },
  url: { type: "string", format: "uri" },
  domain: { type: "string" },
  currency: { type: "string" },
  final_price: { type: "number" },
  initial_price: { type: "number" },
  rating: { type: "number" },
  num_ratings: { type: "number" },
  brand: { type: ["string", "null"] },
  image: { type: "string", format: "uri" },
  page_number: { type: "number" },
  rank_on_page: { type: "number" },
  bought_past_month: { type: "number" },
  sold: { type: "number" },
  sponsored: { type: "string" },
  sponsored_video: { type: ["string", "null"] },
  total_results: { type: "number" },
  timestamp: { type: "string" },
});

function contract(input: {
  readonly operationCode: string;
  readonly normalizerCode: string;
  readonly schemaVersion: string;
  readonly fields: Readonly<Record<string, AmazonOutputSchemaDocument>>;
  readonly example: readonly Readonly<Record<string, unknown>>[];
}): AmazonPreciseOutputContract {
  return deepFreeze({
    operationCode: input.operationCode,
    normalizerCode: input.normalizerCode,
    normalizerVersion: 2 as const,
    schemaVersion: input.schemaVersion,
    outputSchema: objectArraySchema({ id: `urn:dhumi:schema:${input.schemaVersion}`, fields: input.fields }),
    projectedFields: Object.keys(input.fields),
    example: input.example,
  });
}

const PRODUCT_EXAMPLE = deepFreeze([{
  asin: "B0CRMZHDG8",
  title: "Observed Amazon product",
  url: "https://www.amazon.com/dp/B0CRMZHDG8",
  domain: "amazon.com",
  currency: "USD",
  final_price: 45,
  initial_price: 50,
  rating: 4.7,
  reviews_count: 1200,
  availability: "In Stock",
  brand: "Observed brand",
  image_url: "https://m.media-amazon.com/images/I/observed.jpg",
  timestamp: "2026-08-30T08:56:31.000Z",
}]);

export const AMAZON_PRECISE_OUTPUT_CONTRACTS: readonly AmazonPreciseOutputContract[] =
  deepFreeze([
    contract({
      operationCode: "amazon.products.collect_by_url",
      normalizerCode: "amazon.products.collect-by-url.projected-array",
      schemaVersion: "amazon.products.collect-by-url.output.v1",
      fields: PRODUCT_FIELDS,
      example: PRODUCT_EXAMPLE,
    }),
    contract({
      operationCode: "amazon.products_global.collect_by_url",
      normalizerCode: "amazon.products-global.collect-by-url.projected-array",
      schemaVersion: "amazon.products-global.collect-by-url.output.v1",
      fields: PRODUCT_FIELDS,
      example: [{
        ...PRODUCT_EXAMPLE[0],
        url: "https://www.amazon.de/dp/B078TNNZK3",
        domain: "amazon.de",
        currency: "EUR",
      }],
    }),
    contract({
      operationCode: "amazon.products_search.collect_by_url",
      normalizerCode: "amazon.products-search.collect-by-url.projected-array",
      schemaVersion: "amazon.products-search.collect-by-url.output.v1",
      fields: SEARCH_FIELDS,
      example: [{
        asin: null,
        name: "Observed search result",
        url: "https://www.amazon.com/dp/B000000000",
        domain: "amazon.com",
        currency: "USD",
        final_price: 10,
        initial_price: 12,
        rating: 4.2,
        num_ratings: 100,
        brand: null,
        image: "https://m.media-amazon.com/images/I/search.jpg",
        page_number: 1,
        rank_on_page: 1,
        bought_past_month: 50,
        sold: 0,
        sponsored: "true",
        sponsored_video: null,
        total_results: 500,
        timestamp: "2026-08-30T08:48:01.000Z",
      }],
    }),
    deepFreeze({
      operationCode: "amazon.products.discover_by_upc",
      normalizerCode: "amazon.products.discover-by-upc.empty-array",
      normalizerVersion: 2 as const,
      schemaVersion: "amazon.products.discover-by-upc.output.empty-v1",
      outputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "urn:dhumi:schema:amazon.products.discover-by-upc.output.empty-v1",
        type: "array",
        maxItems: 0,
      },
      projectedFields: [],
      example: [],
    }),
  ]);

const byOperationCode = new Map(
  AMAZON_PRECISE_OUTPUT_CONTRACTS.map((item) => [item.operationCode, item]),
);

export function getAmazonPreciseOutputContract(
  operationCode: string,
): AmazonPreciseOutputContract | undefined {
  return byOperationCode.get(operationCode);
}
