import Ajv2020Module, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  AMAZON_PRECISE_OUTPUT_CONTRACTS,
  getAmazonPreciseOutputContract,
} from "../../src/services/brightdata/amazon/amazonOutputContracts.js";

function compile(schema: Readonly<Record<string, unknown>>): ValidateFunction {
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

describe("Pattern 8 Priority 4 precise Amazon output contracts", () => {
  it("contains only the four stored-evidence-backed behaviors", () => {
    expect(AMAZON_PRECISE_OUTPUT_CONTRACTS.map((contract) => contract.operationCode)).toEqual([
      "amazon.products.collect_by_url",
      "amazon.products_global.collect_by_url",
      "amazon.products_search.collect_by_url",
      "amazon.products.discover_by_upc",
    ]);
    expect(new Set(AMAZON_PRECISE_OUTPUT_CONTRACTS.map((item) => item.schemaVersion)).size)
      .toBe(4);
    for (const contract of AMAZON_PRECISE_OUTPUT_CONTRACTS) {
      expect(Object.isFrozen(contract)).toBe(true);
      expect(contract.normalizerVersion).toBe(2);
      expect(compile(contract.outputSchema)(contract.example)).toBe(true);
    }
  });

  it("does not manufacture contracts for dashboard-only or provider-error evidence", () => {
    expect(getAmazonPreciseOutputContract("amazon.reviews.collect_by_url")).toBeUndefined();
    expect(getAmazonPreciseOutputContract("amazon.sellers.collect_by_url")).toBeUndefined();
    expect(
      getAmazonPreciseOutputContract("amazon.products.discover_by_keyword"),
    ).toBeUndefined();
  });

  it("pins an empty-only UPC schema until a non-empty response is observed", () => {
    const contract = getAmazonPreciseOutputContract("amazon.products.discover_by_upc");
    expect(contract).toBeDefined();
    const validate = compile(contract?.outputSchema ?? {});
    expect(validate([])).toBe(true);
    expect(validate([{ asin: "B000000000" }])).toBe(false);
  });
});
