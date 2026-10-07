import type { FastifyInstance } from "fastify";
import {
  getUsageSummary,
  listUsageEvents,
} from "../controllers/usageController.js";
import { requireTenantPrincipal } from "../middleware/tenantPrincipal.js";
import { USAGE_RECONCILIATION_STATES } from "../services/usage/getUsageSummaryService.js";
import {
  USAGE_OUTCOMES,
  USAGE_PRODUCT_FAMILIES,
} from "../services/usage/listUsageEventsService.js";

const usageRangeQueryProperties = {
  from: { type: "string", format: "date-time" },
  to: { type: "string", format: "date-time" },
} as const;

const usageSummaryQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["from", "to"],
  properties: usageRangeQueryProperties,
} as const;

const usageEventsQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["from", "to"],
  properties: {
    ...usageRangeQueryProperties,
    cursor: { type: "string", minLength: 1, maxLength: 2048 },
    limit: {
      type: "string",
      minLength: 1,
      maxLength: 3,
      pattern: "^(?:[1-9]|[1-9][0-9]|100)$",
    },
  },
} as const;

const usageItemResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["meter", "quantity", "unit"],
  properties: {
    meter: { type: "string" },
    quantity: { type: "number", minimum: 0 },
    unit: { type: "string" },
  },
} as const;

const usageSummaryResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["from", "to", "items", "updated_at", "state"],
  properties: {
    from: { type: "string", format: "date-time" },
    to: { type: "string", format: "date-time" },
    items: { type: "array", items: usageItemResponseSchema },
    updated_at: { type: "string", format: "date-time" },
    state: { type: "string", enum: USAGE_RECONCILIATION_STATES },
  },
} as const;

const usageEventResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "run_id",
    "product_family",
    "meter",
    "quantity",
    "unit",
    "outcome",
    "observed_at",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    run_id: { type: "string", format: "uuid" },
    product_family: { type: "string", enum: USAGE_PRODUCT_FAMILIES },
    meter: { type: "string" },
    quantity: { type: "number", minimum: 0 },
    unit: { type: "string" },
    outcome: { type: "string", enum: USAGE_OUTCOMES },
    observed_at: { type: "string", format: "date-time" },
  },
} as const;

const usageEventPageResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data", "page"],
  properties: {
    data: { type: "array", items: usageEventResponseSchema },
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

export async function registerUsageRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/usage/summary", {
    attachValidation: true,
    schema: {
      querystring: usageSummaryQuerySchema,
      response: { 200: usageSummaryResponseSchema },
    },
    preHandler: [requireTenantPrincipal()],
    handler: getUsageSummary,
  });

  app.get("/v1/usage/events", {
    attachValidation: true,
    schema: {
      querystring: usageEventsQuerySchema,
      response: { 200: usageEventPageResponseSchema },
    },
    preHandler: [requireTenantPrincipal()],
    handler: listUsageEvents,
  });
}
