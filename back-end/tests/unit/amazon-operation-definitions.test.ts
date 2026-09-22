import Ajv2020Module, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  AMAZON_CONFIGURATION_SCHEMA,
  AMAZON_OPERATION_DEFINITIONS,
  getAmazonOperationDefinition,
  type JsonSchemaDocument,
} from "../../src/services/brightdata/amazon/amazonOperationDefinitions.js";

function compile(schema: JsonSchemaDocument): ValidateFunction {
  const Ajv2020 = Ajv2020Module as unknown as new (
    options: Readonly<Record<string, unknown>>,
  ) => { compile(document: object): ValidateFunction };
  const addFormats = addFormatsModule as unknown as (
    compiler: { compile(document: object): ValidateFunction },
  ) => void;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

describe("Pattern 6 Amazon operation definitions", () => {
  it("contains exactly 13 immutable definitions with unique public identities", () => {
    expect(Object.isFrozen(AMAZON_OPERATION_DEFINITIONS)).toBe(true);
    expect(AMAZON_OPERATION_DEFINITIONS).toHaveLength(13);

    const codes = AMAZON_OPERATION_DEFINITIONS.map((item) => item.operationCode);
    const slugs = AMAZON_OPERATION_DEFINITIONS.map((item) => item.slug);
    const priorities = AMAZON_OPERATION_DEFINITIONS.map(
      (item) => item.presentation.display_priority,
    );
    expect(new Set(codes).size).toBe(13);
    expect(new Set(slugs).size).toBe(13);
    expect(new Set(priorities).size).toBe(13);

    for (const definition of AMAZON_OPERATION_DEFINITIONS) {
      expect(Object.isFrozen(definition)).toBe(true);
      expect(getAmazonOperationDefinition(definition.operationCode)).toBe(definition);
      expect(definition.publicationState).toBe("draft");
      expect(definition.qualificationState).toBe("pending");
      expect(definition.configurationSchema).toBe(AMAZON_CONFIGURATION_SCHEMA);
    }
  });

  it("validates the evidence-backed example for every definition", () => {
    for (const definition of AMAZON_OPERATION_DEFINITIONS) {
      const validate = compile(definition.inputSchema);
      expect(
        validate(structuredClone(definition.example)),
        `${definition.operationCode}: ${JSON.stringify(validate.errors)}`,
      ).toBe(true);
      expect(validate({ targets: [] }), definition.operationCode).toBe(false);
      expect(
        validate({
          ...structuredClone(definition.example),
          provider_resource: "forbidden",
        }),
        definition.operationCode,
      ).toBe(false);
    }
  });

  it("pins five logical mappings, three output families and exact discovery selectors", () => {
    expect(
      new Set(AMAZON_OPERATION_DEFINITIONS.map((item) => item.mappingLabel)),
    ).toEqual(
      new Set([
        "M-AMAZON-PRODUCTS",
        "M-AMAZON-PRODUCTS-GLOBAL",
        "M-AMAZON-PRODUCTS-SEARCH",
        "M-AMAZON-REVIEWS",
        "M-AMAZON-SELLERS",
      ]),
    );
    expect(
      new Set(AMAZON_OPERATION_DEFINITIONS.map((item) => item.output.family)),
    ).toEqual(new Set(["product", "review", "seller"]));

    const discovery = AMAZON_OPERATION_DEFINITIONS.filter(
      (item) => item.providerRequest.mode === "discover",
    );
    expect(discovery).toHaveLength(8);
    expect(
      discovery.map((item) =>
        item.providerRequest.mode === "discover"
          ? item.providerRequest.discoverBy
          : "unexpected-collect",
      ),
    ).toEqual([
      "category_url",
      "category_url",
      "keyword",
      "upc",
      "best_sellers_url",
      "brand",
      "keyword",
      "seller",
    ]);
  });

  it("distinguishes qualification observation from precise customer output", () => {
    const precise = AMAZON_OPERATION_DEFINITIONS.filter(
      (item) => item.output.preciseContract.state === "available",
    );
    expect(precise.map((item) => item.operationCode)).toEqual([
      "amazon.products.collect_by_url",
      "amazon.products_global.collect_by_url",
      "amazon.products_search.collect_by_url",
      "amazon.products.discover_by_upc",
    ]);
    expect(
      AMAZON_OPERATION_DEFINITIONS.filter(
        (item) => item.output.preciseContract.state === "unavailable",
      ),
    ).toHaveLength(9);
  });

  it("contains no provider resource identifier or customer-controlled fixed field", () => {
    const serialized = JSON.stringify(AMAZON_OPERATION_DEFINITIONS);
    expect(serialized).not.toMatch(/gd_[a-z0-9]{8,}/i);
    expect(serialized).not.toContain("snapshot_id");

    for (const definition of AMAZON_OPERATION_DEFINITIONS) {
      const targetProperties = (
        definition.inputSchema.properties as Record<string, unknown>
      ).targets as { items: { properties: Record<string, unknown> } };
      expect(Object.keys(targetProperties.items.properties)).not.toEqual(
        expect.arrayContaining([
          "dataset_id",
          "discover_by",
          "limit_per_input",
          "notify",
          "include_errors",
          "format",
          "type",
        ]),
      );
    }
  });
});
