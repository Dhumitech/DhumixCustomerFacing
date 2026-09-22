import { readFile } from "node:fs/promises";
import Ajv2020Module, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  AMAZON_CONFIGURATION_SCHEMA,
  AMAZON_OPERATION_FIXTURES,
  AMAZON_PUBLIC_TEMPLATES,
  type JsonSchemaDocument,
} from "../support/amazonCatalogueFixtures.js";

const FORBIDDEN_CUSTOMER_PROPERTY_NAMES = new Set([
  "dataset_id",
  "snapshot_id",
  "provider_id",
  "discover_by",
  "limit_per_input",
  "notify",
  "include_errors",
  "type",
  "format",
]);

function propertyNames(schema: unknown, result = new Set<string>()): ReadonlySet<string> {
  if (Array.isArray(schema)) {
    for (const item of schema) propertyNames(item, result);
    return result;
  }
  if (typeof schema !== "object" || schema === null) return result;

  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && typeof value === "object" && value !== null) {
      for (const [propertyName, propertySchema] of Object.entries(value)) {
        result.add(propertyName);
        propertyNames(propertySchema, result);
      }
    } else {
      propertyNames(value, result);
    }
  }
  return result;
}

function mutableExample(
  example: Readonly<{ targets: readonly Readonly<Record<string, unknown>>[] }>,
): { targets: Record<string, unknown>[] } {
  return {
    targets: example.targets.map((target) => ({ ...target })),
  };
}

function compile(schema: JsonSchemaDocument) {
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

describe("Pattern 2 Amazon catalogue model", () => {
  it("contains exactly 13 operations with unique codes, slugs and priorities", () => {
    expect(AMAZON_OPERATION_FIXTURES).toHaveLength(13);

    const codes = AMAZON_OPERATION_FIXTURES.map((operation) => operation.operationCode);
    const slugs = AMAZON_OPERATION_FIXTURES.map((operation) => operation.slug);
    const priorities = AMAZON_OPERATION_FIXTURES.map(
      (operation) => operation.presentation.display_priority,
    );

    expect(new Set(codes).size).toBe(13);
    expect(new Set(slugs).size).toBe(13);
    expect(new Set(priorities).size).toBe(13);
  });

  it("projects every operation through the same public nine-field Template shape", () => {
    expect(AMAZON_PUBLIC_TEMPLATES).toHaveLength(13);

    for (const template of AMAZON_PUBLIC_TEMPLATES) {
      expect(Object.keys(template).sort()).toEqual([
        "availability",
        "configuration_schema",
        "description",
        "family",
        "input_schema",
        "name",
        "presentation",
        "slug",
        "version",
      ]);
      expect(Object.keys(template.presentation).sort()).toEqual([
        "category",
        "display_priority",
        "domain_name",
        "domain_slug",
        "icon_key",
        "operation_group",
        "operation_name",
      ]);
      expect(template.family).toBe("scraper_library");
    }
  });

  it("keeps provider identifiers and provider-controlled fields out of public data", () => {
    const publicJson = JSON.stringify(AMAZON_PUBLIC_TEMPLATES);
    expect(publicJson).not.toMatch(/gd_[a-z0-9]{8,}/i);

    for (const schema of [
      AMAZON_CONFIGURATION_SCHEMA,
      ...AMAZON_OPERATION_FIXTURES.map((operation) => operation.inputSchema),
    ]) {
      for (const name of propertyNames(schema)) {
        expect(
          FORBIDDEN_CUSTOMER_PROPERTY_NAMES.has(name),
          `${name} must not be a customer-controlled schema property`,
        ).toBe(false);
      }
    }
  });

  it("validates each evidence-backed example and rejects missing or unknown target fields", () => {
    for (const operation of AMAZON_OPERATION_FIXTURES) {
      const validate = compile(operation.inputSchema);
      const valid = mutableExample(operation.example);
      expect(validate(valid), `${operation.slug}: ${JSON.stringify(validate.errors)}`).toBe(true);

      const missingRequired = { targets: [{}] };
      expect(validate(missingRequired), operation.slug).toBe(false);

      const unknownTarget = mutableExample(operation.example);
      unknownTarget.targets[0] = {
        ...unknownTarget.targets[0],
        unexpected_customer_field: "forbidden",
      };
      expect(validate(unknownTarget), operation.slug).toBe(false);

      expect(validate({ ...valid, unexpected_envelope_field: true }), operation.slug).toBe(false);
      expect(validate({ targets: [] }), operation.slug).toBe(false);
      expect(
        validate({ targets: Array.from({ length: 21 }, () => ({ ...valid.targets[0] })) }),
        operation.slug,
      ).toBe(false);
    }
  });

  it("keeps the authoritative OpenAPI free of provider-specific Amazon routes", async () => {
    const openApi = await readFile(
      new URL("../../contracts/openapi.yaml", import.meta.url),
      "utf8",
    );
    const publicPaths = [...openApi.matchAll(/^  (\/v1\/[^:]+):\s*$/gm)].map(
      ([, path]) => path,
    );

    expect(publicPaths).toContain("/v1/catalog/templates");
    expect(publicPaths).toContain("/v1/catalog/templates/{slug}");
    expect(publicPaths).toContain("/v1/services");
    expect(publicPaths).toContain("/v1/services/{service_id}/runs");
    expect(publicPaths).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/amazon/i),
        expect.stringMatching(/bright.?data/i),
        expect.stringMatching(/^\/v1\/(datasets|scrapers)(?:\/|$)/i),
      ]),
    );

    for (const operation of AMAZON_OPERATION_FIXTURES) {
      expect(publicPaths).not.toContain(`/v1/${operation.slug}`);
    }
  });
});
