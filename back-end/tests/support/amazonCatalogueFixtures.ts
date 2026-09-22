import type { ServiceTemplate } from "../../src/services/catalogue/catalogTemplate.js";
import {
  AMAZON_CONFIGURATION_SCHEMA,
  AMAZON_OPERATION_DEFINITIONS,
  type JsonSchemaDocument,
} from "../../src/services/brightdata/amazon/amazonOperationDefinitions.js";

export { AMAZON_CONFIGURATION_SCHEMA, type JsonSchemaDocument };

export interface AmazonOperationFixture {
  readonly operationCode: string;
  readonly slug: string;
  readonly publicName: string;
  readonly presentation: ServiceTemplate["presentation"];
  readonly inputSchema: JsonSchemaDocument;
  readonly example: Readonly<{
    targets: readonly Readonly<Record<string, unknown>>[];
  }>;
}

/** Pattern 2 now reads the production Pattern 6 registry, preventing drift. */
export const AMAZON_OPERATION_FIXTURES: readonly AmazonOperationFixture[] =
  AMAZON_OPERATION_DEFINITIONS.map((definition) => ({
    operationCode: definition.operationCode,
    slug: definition.slug,
    publicName: definition.publicName,
    presentation: definition.presentation,
    inputSchema: definition.inputSchema,
    example: definition.example,
  }));

export const AMAZON_PUBLIC_TEMPLATES: readonly ServiceTemplate[] =
  AMAZON_OPERATION_DEFINITIONS.map((definition) => ({
    slug: definition.slug,
    version: 1,
    family: "scraper_library",
    name: definition.publicName,
    description: `${definition.publicName} using a qualified Dhumi Template.`,
    availability: "available",
    presentation: definition.presentation,
    configuration_schema: definition.configurationSchema,
    input_schema: definition.inputSchema,
  }));
