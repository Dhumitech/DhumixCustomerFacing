import type { FastifyInstance } from "fastify";
import {
  createService,
  getService,
  listServices,
} from "../controllers/serviceController.js";
import { requireTenantPrincipal } from "../middleware/tenantPrincipal.js";

const listServicesQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cursor: { type: "string", minLength: 1, maxLength: 2048 },
    limit: { type: "string", minLength: 1, maxLength: 3, pattern: "^[0-9]+$" },
  },
} as const;

const createServiceHeadersSchema = {
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

const createServiceBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["template_slug", "name", "configuration"],
  properties: {
    template_slug: {
      type: "string",
      pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
    },
    name: { type: "string", minLength: 1, maxLength: 120 },
    configuration: { type: "object", additionalProperties: true },
  },
} as const;

const getServiceParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["service_id"],
  properties: {
    service_id: { type: "string", format: "uuid" },
  },
} as const;

const serviceResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "name",
    "template_slug",
    "template_version",
    "version",
    "family",
    "state",
    "created_at",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
    template_slug: { type: "string" },
    template_version: { type: "integer", minimum: 1 },
    version: { type: "integer", minimum: 1 },
    family: {
      type: "string",
      enum: ["marketplace_dataset", "scraper_library"],
    },
    state: { type: "string", enum: ["active", "disabled"] },
    created_at: { type: "string", format: "date-time" },
  },
} as const;

const servicePageResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data", "page"],
  properties: {
    data: { type: "array", items: serviceResponseSchema },
    page: {
      type: "object",
      additionalProperties: false,
      required: ["next_cursor", "has_more"],
      properties: {
        next_cursor: {
          anyOf: [
            { type: "string", minLength: 1, maxLength: 2048 },
            { type: "null" },
          ],
        },
        has_more: { type: "boolean" },
      },
    },
  },
} as const;

const serviceDetailResponseSchema = {
  ...serviceResponseSchema,
  required: [...serviceResponseSchema.required, "configuration"],
  properties: {
    ...serviceResponseSchema.properties,
    configuration: { type: "object", additionalProperties: true },
  },
} as const;

export async function registerServiceRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/services", {
    attachValidation: true,
    schema: {
      querystring: listServicesQuerySchema,
      response: { 200: servicePageResponseSchema },
    },
    preHandler: [requireTenantPrincipal()],
    handler: listServices,
  });

  app.get("/v1/services/:service_id", {
    attachValidation: true,
    schema: {
      params: getServiceParamsSchema,
      response: { 200: serviceDetailResponseSchema },
    },
    preHandler: [requireTenantPrincipal()],
    handler: getService,
  });

  app.post("/v1/services", {
    attachValidation: true,
    schema: {
      headers: createServiceHeadersSchema,
      body: createServiceBodySchema,
      response: { 201: serviceDetailResponseSchema },
    },
    preHandler: [requireTenantPrincipal()],
    handler: createService,
  });
}
