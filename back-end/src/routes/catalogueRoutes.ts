import type { FastifyInstance } from "fastify";
import {
  authorizeMarketplaceSampleDownload,
  createMarketplaceExpertEnquiry,
  getMarketplaceSample,
  getTemplate,
  listCatalogTemplates,
  queryMarketplaceSample,
} from "../controllers/catalogueController.js";
import { CATALOG_PRODUCT_FAMILIES } from "../helpers/catalogTemplateListCursor.js";
import { requireBrowsePrincipal } from "../middleware/browsePrincipal.js";
import { requireTenantPrincipal } from "../middleware/tenantPrincipal.js";
import { CATALOG_TEMPLATE_AVAILABILITY } from "../services/catalogue/catalogTemplate.js";

const listCatalogTemplatesQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    family: { type: "string", enum: CATALOG_PRODUCT_FAMILIES },
    cursor: { type: "string", minLength: 1, maxLength: 2048 },
    limit: { type: "string", minLength: 1, maxLength: 3, pattern: "^[0-9]+$" },
  },
} as const;

const getCatalogTemplateParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["slug"],
  properties: {
    slug: {
      type: "string",
      pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
      minLength: 3,
      maxLength: 100,
    },
  },
} as const;

const serviceTemplateResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "slug",
    "version",
    "family",
    "name",
    "description",
    "availability",
    "presentation",
    "configuration_schema",
    "input_schema",
  ],
  properties: {
    slug: { type: "string" },
    version: { type: "integer", minimum: 1 },
    family: { type: "string", enum: CATALOG_PRODUCT_FAMILIES },
    name: { type: "string" },
    description: { type: "string" },
    availability: { type: "string", enum: CATALOG_TEMPLATE_AVAILABILITY },
    presentation: {
      type: "object",
      additionalProperties: false,
      required: [
        "domain_slug",
        "domain_name",
        "category",
        "icon_key",
        "operation_group",
        "operation_name",
        "display_priority",
      ],
      properties: {
        domain_slug: {
          type: "string",
          pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
        },
        domain_name: { type: "string", minLength: 1, maxLength: 120 },
        category: { type: "string", minLength: 1, maxLength: 80 },
        icon_key: {
          type: "string",
          pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
        },
        operation_group: { type: "string", minLength: 1, maxLength: 120 },
        operation_name: { type: "string", minLength: 1, maxLength: 120 },
        display_priority: {
          type: "integer",
          minimum: 0,
          maximum: 1_000_000,
        },
      },
    },
    configuration_schema: { type: "object", additionalProperties: true },
    input_schema: { type: "object", additionalProperties: true },
    marketplace: { type: "object", additionalProperties: true },
  },
} as const;

const templatePageResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data", "page"],
  properties: {
    data: { type: "array", items: serviceTemplateResponseSchema },
    page: {
      type: "object",
      additionalProperties: false,
      required: ["next_cursor", "has_more"],
      properties: {
        next_cursor: {
          anyOf: [{ type: "string", minLength: 1, maxLength: 2048 }, { type: "null" }],
        },
        has_more: { type: "boolean" },
      },
    },
  },
} as const;

const filterOperators = [
  "=",
  "!=",
  "in",
  "not_in",
  "includes",
  "not_includes",
  "is_null",
  "is_not_null",
] as const;

const samplePageQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cursor: { type: "string", minLength: 1, maxLength: 2048 },
    limit: { type: "string", minLength: 1, maxLength: 3, pattern: "^[0-9]+$" },
  },
} as const;

const filterPredicateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "operator"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 160 },
    operator: { type: "string", enum: filterOperators },
    value: {
      anyOf: [
        { type: "string" },
        { type: "array", minItems: 1, maxItems: 1000, items: { type: "string" } },
      ],
    },
  },
} as const;

const filterGroupSchema = {
  type: "object",
  additionalProperties: false,
  required: ["operator", "filters"],
  properties: {
    operator: { type: "string", enum: ["and", "or"] },
    filters: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: filterPredicateSchema,
    },
  },
} as const;

const sampleQueryBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["expected_sample_version", "selected_fields", "page"],
  properties: {
    expected_sample_version: { type: "integer", minimum: 1 },
    selected_fields: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 160 },
    },
    filter: { anyOf: [filterPredicateSchema, filterGroupSchema] },
    sort: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "direction"],
        properties: {
          field: { type: "string", minLength: 1, maxLength: 160 },
          direction: { type: "string", enum: ["asc", "desc"] },
        },
      },
    },
    page: {
      type: "object",
      additionalProperties: false,
      required: ["limit"],
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: {
          anyOf: [{ type: "string", minLength: 1, maxLength: 2048 }, { type: "null" }],
        },
      },
    },
  },
} as const;

const sampleResultResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "template_slug",
    "template_version",
    "sample_version",
    "sample_record_count",
    "matches_in_sample",
    "selected_fields",
    "rows",
    "masking_notice",
    "page",
  ],
  properties: {
    template_slug: { type: "string" },
    template_version: { type: "integer", minimum: 1 },
    sample_version: { type: "integer", minimum: 1 },
    sample_record_count: { type: "integer", minimum: 0 },
    matches_in_sample: { type: "integer", minimum: 0 },
    selected_fields: { type: "array", items: { type: "string" } },
    rows: { type: "array", items: { type: "object", additionalProperties: true } },
    masking_notice: { type: "string" },
    page: {
      type: "object",
      additionalProperties: false,
      required: ["next_cursor", "has_more"],
      properties: {
        next_cursor: {
          anyOf: [{ type: "string", minLength: 1, maxLength: 2048 }, { type: "null" }],
        },
        has_more: { type: "boolean" },
      },
    },
  },
} as const;

const sampleDownloadHeadersSchema = {
  type: "object",
  required: ["idempotency-key"],
  properties: {
    "idempotency-key": {
      type: "string",
      minLength: 16,
      maxLength: 128,
      pattern: "^[A-Za-z0-9._:-]+$",
    },
    "x-csrf-token": { type: "string", minLength: 16, maxLength: 512 },
  },
} as const;

const sampleDownloadBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["expected_sample_version", "selected_fields", "format", "record_limit"],
  properties: {
    expected_sample_version: { type: "integer", minimum: 1 },
    selected_fields: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 160 },
    },
    filter: { anyOf: [filterPredicateSchema, filterGroupSchema] },
    sort: sampleQueryBodySchema.properties.sort,
    format: { type: "string", enum: ["json", "csv"] },
    record_limit: { type: "integer", minimum: 1, maximum: 100 },
  },
} as const;

const sampleDownloadResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "sample_version",
    "format",
    "record_count",
    "content_type",
    "byte_count",
    "checksum",
    "download_url",
    "download_expires_at",
  ],
  properties: {
    sample_version: { type: "integer", minimum: 1 },
    format: { type: "string", enum: ["json", "csv"] },
    record_count: { type: "integer", minimum: 0 },
    content_type: { type: "string" },
    byte_count: { type: "integer", minimum: 0 },
    checksum: { type: "string", pattern: "^[a-f0-9]{64}$" },
    download_url: { type: "string", format: "uri" },
    download_expires_at: { type: "string", format: "date-time" },
  },
} as const;

const expertEnquiryBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["expected_template_version"],
  properties: {
    expected_template_version: { type: "integer", minimum: 1 },
  },
} as const;

const expertEnquiryResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "template_slug", "template_version", "state", "submitted_at"],
  properties: {
    id: { type: "string", format: "uuid" },
    template_slug: { type: "string" },
    template_version: { type: "integer", minimum: 1 },
    state: { type: "string", enum: ["received", "in_review", "contacted", "closed"] },
    submitted_at: { type: "string", format: "date-time" },
  },
} as const;

export async function registerCatalogueRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/catalog/templates", {
    attachValidation: true,
    schema: {
      querystring: listCatalogTemplatesQuerySchema,
      response: { 200: templatePageResponseSchema },
    },
    preHandler: [requireBrowsePrincipal],
    handler: listCatalogTemplates,
  });

  app.get("/v1/catalog/templates/:slug", {
    attachValidation: true,
    schema: {
      params: getCatalogTemplateParamsSchema,
      response: { 200: serviceTemplateResponseSchema },
    },
    preHandler: [requireBrowsePrincipal],
    handler: getTemplate,
  });

  app.get("/v1/catalog/templates/:slug/sample", {
    attachValidation: true,
    schema: {
      params: getCatalogTemplateParamsSchema,
      querystring: samplePageQuerySchema,
      response: { 200: sampleResultResponseSchema },
    },
    preHandler: [requireBrowsePrincipal],
    handler: getMarketplaceSample,
  });

  app.post("/v1/catalog/templates/:slug/sample/query", {
    attachValidation: true,
    schema: {
      params: getCatalogTemplateParamsSchema,
      body: sampleQueryBodySchema,
      response: { 200: sampleResultResponseSchema },
    },
    preHandler: [requireBrowsePrincipal],
    handler: queryMarketplaceSample,
  });

  app.post("/v1/catalog/templates/:slug/sample/downloads", {
    attachValidation: true,
    schema: {
      params: getCatalogTemplateParamsSchema,
      headers: sampleDownloadHeadersSchema,
      body: sampleDownloadBodySchema,
      response: { 201: sampleDownloadResponseSchema },
    },
    preHandler: [requireTenantPrincipal()],
    handler: authorizeMarketplaceSampleDownload,
  });

  app.post("/v1/catalog/templates/:slug/expert-enquiries", {
    attachValidation: true,
    schema: {
      params: getCatalogTemplateParamsSchema,
      headers: sampleDownloadHeadersSchema,
      body: expertEnquiryBodySchema,
      response: { 201: expertEnquiryResponseSchema },
    },
    preHandler: [requireTenantPrincipal()],
    handler: createMarketplaceExpertEnquiry,
  });
}
