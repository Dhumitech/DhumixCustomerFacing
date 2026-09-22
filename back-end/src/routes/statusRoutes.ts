import type { FastifyInstance } from "fastify";
import { getPlatformStatus } from "../controllers/statusController.js";
import {
  PLATFORM_PRODUCT_FAMILIES,
  PLATFORM_PRODUCT_STATES,
} from "../services/status/getPlatformStatusService.js";

const statusTimestampSchema = {
  type: "string",
  format: "date-time",
} as const;

const productStatusResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["family", "state", "updated_at"],
  properties: {
    family: { type: "string", enum: PLATFORM_PRODUCT_FAMILIES },
    state: { type: "string", enum: PLATFORM_PRODUCT_STATES },
    message: {
      anyOf: [{ type: "string" }, { type: "null" }],
    },
    updated_at: statusTimestampSchema,
  },
} as const;

const platformStatusResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["state", "products", "updated_at"],
  properties: {
    state: {
      type: "string",
      enum: ["operational", "degraded", "unavailable", "maintenance", "unknown"],
    },
    products: {
      type: "array",
      minItems: 2,
      maxItems: 2,
      items: productStatusResponseSchema,
    },
    updated_at: statusTimestampSchema,
  },
} as const;

export async function registerStatusRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/status", {
    schema: {
      querystring: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      response: { 200: platformStatusResponseSchema },
    },
    handler: getPlatformStatus,
  });
}
