import { describe, expect, it } from "vitest";
import {
  createServiceConfigurationValidator,
  StoredServiceSchemaError,
} from "../../src/helpers/serviceConfigurationValidator.js";

describe("Service configuration validator", () => {
  it("validates JSON Schema 2020-12 with formats and preserves the input", () => {
    const validator = createServiceConfigurationValidator();
    const configuration = {
      query: "not-an-email",
      nested: { enabled: "true" },
      untouched: "sentinel",
    };
    const before = structuredClone(configuration);
    const result = validator.validate({
      templateVersionId: "11111111-1111-4111-8111-111111111111",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["query", "nested"],
        properties: {
          query: { type: "string", format: "email" },
          nested: {
            type: "object",
            required: ["enabled"],
            properties: { enabled: { type: "boolean", default: true } },
          },
        },
      },
      configuration,
    });

    expect(result).toMatchObject({ valid: false });
    expect(configuration).toEqual(before);
    if (!result.valid) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          { field: "/query", message: "has an invalid format" },
          { field: "/nested/enabled", message: "has an invalid type" },
          { field: "/", message: "contains an unsupported property" },
        ]),
      );
    }
  });

  it("returns a stable 32-byte schema hash independent of object key order", () => {
    const validator = createServiceConfigurationValidator();
    const left = validator.validate({
      templateVersionId: "11111111-1111-4111-8111-111111111111",
      schema: { type: "object", properties: { b: { type: "number" }, a: { type: "string" } } },
      configuration: { a: "value", b: 1 },
    });
    const right = validator.validate({
      templateVersionId: "11111111-1111-4111-8111-111111111111",
      schema: { properties: { a: { type: "string" }, b: { type: "number" } }, type: "object" },
      configuration: { b: 1, a: "value" },
    });
    expect(left.schemaHash).toHaveLength(32);
    expect(left.schemaHash.equals(right.schemaHash)).toBe(true);
  });

  it("fails closed for invalid schemas and every non-local reference", () => {
    const validator = createServiceConfigurationValidator();
    expect(() =>
      validator.validate({
        templateVersionId: "11111111-1111-4111-8111-111111111111",
        schema: { type: "not-a-json-schema-type" },
        configuration: {},
      }),
    ).toThrow(StoredServiceSchemaError);
    expect(() =>
      validator.validate({
        templateVersionId: "11111111-1111-4111-8111-111111111111",
        schema: { $ref: "https://example.invalid/schema.json" },
        configuration: {},
      }),
    ).toThrow(StoredServiceSchemaError);
  });
});
