import { describe, expect, it } from "vitest";
import { parseTemplateExecutionDefinition, requireExecutableTemplate, templateExecutionDefinitionHash, TemplateExecutionDefinitionError } from "../../src/services/catalogue/templateExecutionDefinition.js";
import { toServiceTemplate } from "../../src/services/catalogue/catalogTemplate.js";

const definition = {
  capability_metadata: { snapshot: true }, request_schema: { type: "array" }, result_schema: { type: "array" },
  error_schema: { type: "object" }, operation_code: "amazon.products.by_url", output_policy: { private_policy: "retained" },
  commercial_config_version: "local-v1", config_version: "mapping-v4",
};
const executable = () => ({ productFamily: "scraper_library", engine: "amazon.v1", definition,
  definitionSha256: templateExecutionDefinitionHash(definition), datasetCiphertext: Buffer.alloc(40), datasetFingerprint: Buffer.alloc(32) });

describe("private template execution contract for 0073", () => {
  it("preserves all adapter/mapping facts, hashes independently of JSON key order and freezes the copy", () => {
    const parsed = parseTemplateExecutionDefinition(definition);
    expect(parsed).toEqual(definition); expect(parsed).not.toBe(definition);
    expect(Object.isFrozen(parsed.output_policy)).toBe(true);
    const reordered = Object.fromEntries(Object.entries(definition).reverse());
    expect(templateExecutionDefinitionHash(reordered)).toEqual(templateExecutionDefinitionHash(definition));
  });
  it("accepts a complete closed engine definition and refuses changed definition bytes", () => {
    expect(requireExecutableTemplate(executable()).engine).toBe("amazon.v1");
    expect(() => requireExecutableTemplate({ ...executable(), definition: { ...definition, operation_code: "amazon.search.by_keyword" } })).toThrow(TemplateExecutionDefinitionError);
  });
  it.each([
    { productFamily: "marketplace_dataset" }, { engine: null }, { engine: "custom.javascript" }, { definition: null },
    { definitionSha256: null }, { definitionSha256: Buffer.alloc(31) }, { datasetCiphertext: null },
    { datasetCiphertext: Buffer.alloc(29) }, { datasetFingerprint: null }, { datasetFingerprint: Buffer.alloc(31) },
  ])("refuses an incomplete, unknown or sample-only executable row %j", change => {
    expect(() => requireExecutableTemplate({ ...executable(), ...change })).toThrow(TemplateExecutionDefinitionError);
  });
  it("rejects unknown definition fields and malformed versions/schema/operation", () => {
    for (const change of [{ script: "eval()" }, { output_policy: [] }, { request_schema: null }, { config_version: "" }, { operation_code: "contains spaces" }])
      expect(() => parseTemplateExecutionDefinition({ ...definition, ...change })).toThrow(TemplateExecutionDefinitionError);
  });
  it("customer projections discard execution, encrypted dataset and supplier-cost metadata", () => {
    const record = { id: "private-id", slug: "amazon-products", family: "scraper_library" as const, templateState: "published" as const,
      version: 4, name: "Products", description: "Products", availabilityState: "available" as const,
      presentation: { domain_slug: "amazon", domain_name: "Amazon", category: "retail", icon_key: "amazon", operation_group: "products", operation_name: "By URL", display_priority: 1 },
      configurationSchema: {}, inputSchema: {}, execution_definition: definition, provider_dataset_ciphertext: Buffer.alloc(40), estimated_cost_micros: 1000 };
    const response = JSON.stringify(toServiceTemplate(record));
    expect(response).not.toMatch(/execution_definition|provider_dataset|estimated_cost|private_policy|local-v1/);
  });
});
