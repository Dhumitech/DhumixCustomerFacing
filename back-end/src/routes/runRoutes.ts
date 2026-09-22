import type { FastifyInstance } from "fastify";
import {
  cancelRun,
  createRun,
  getRun,
  getRunResult,
  listRunEvents,
  listRuns,
  retryRun,
} from "../controllers/runController.js";
import { RUN_PUBLIC_STATUSES } from "../helpers/runListCursor.js";
import { requireTenantPrincipal } from "../middleware/tenantPrincipal.js";
import { RUN_EVENT_TYPES } from "../services/runQuery/listRunEventsService.js";

const listRunsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: RUN_PUBLIC_STATUSES },
    service_id: { type: "string", format: "uuid" },
    cursor: { type: "string", minLength: 1, maxLength: 2048 },
    limit: { type: "string", minLength: 1, maxLength: 3, pattern: "^[0-9]+$" },
  },
} as const;

const createRunParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["service_id"],
  properties: {
    service_id: { type: "string", format: "uuid" },
  },
} as const;

const getRunParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["run_id"],
  properties: {
    run_id: { type: "string", format: "uuid" },
  },
} as const;

const listRunEventsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cursor: { type: "string", minLength: 1, maxLength: 2048 },
    limit: {
      type: "string",
      minLength: 1,
      maxLength: 3,
      pattern: "^(?:[1-9]|[1-9][0-9]|100)$",
    },
  },
} as const;

const getRunResultQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    representation: {
      type: "string",
      enum: ["normalized", "raw"],
      default: "normalized",
    },
  },
} as const;

const createRunHeadersSchema = {
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

const createRunBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["input"],
  properties: {
    input: { type: "object", additionalProperties: true },
  },
} as const;

const runAcceptedResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["run_id", "status", "accepted_at"],
  properties: {
    run_id: { type: "string", format: "uuid" },
    status: { type: "string", const: "queued" },
    accepted_at: { type: "string", format: "date-time" },
  },
} as const;

const runResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "service_id", "status", "created_at", "updated_at"],
  properties: {
    id: { type: "string", format: "uuid" },
    service_id: { type: "string", format: "uuid" },
    status: { type: "string", enum: RUN_PUBLIC_STATUSES },
    progress_message: {
      anyOf: [{ type: "string" }, { type: "null" }],
    },
    error_code: {
      anyOf: [{ type: "string" }, { type: "null" }],
    },
    retryable: { type: "boolean" },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
    completed_at: {
      anyOf: [
        { type: "string", format: "date-time" },
        { type: "null" },
      ],
    },
  },
} as const;

const runPageResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data", "page"],
  properties: {
    data: { type: "array", items: runResponseSchema },
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

const runEventResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "type", "message", "occurred_at"],
  properties: {
    id: { type: "string", format: "uuid" },
    type: { type: "string", enum: RUN_EVENT_TYPES },
    message: { type: "string" },
    occurred_at: { type: "string", format: "date-time" },
  },
} as const;

const runEventPageResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data", "page"],
  properties: {
    data: { type: "array", items: runEventResponseSchema },
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

const runResultResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "run_id",
    "content_type",
    "byte_count",
    "checksum",
    "download_url",
    "download_expires_at",
  ],
  properties: {
    run_id: { type: "string", format: "uuid" },
    content_type: { type: "string" },
    byte_count: { type: "integer", minimum: 0 },
    checksum: { type: "string" },
    download_url: { type: "string", format: "uri" },
    download_expires_at: { type: "string", format: "date-time" },
  },
} as const;

export async function registerRunRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/runs", {
    attachValidation: true,
    schema: {
      querystring: listRunsQuerySchema,
      response: { 200: runPageResponseSchema },
    },
    preHandler: [requireTenantPrincipal("runs:read")],
    handler: listRuns,
  });

  app.get("/v1/runs/:run_id", {
    attachValidation: true,
    schema: {
      params: getRunParamsSchema,
      response: { 200: runResponseSchema },
    },
    preHandler: [requireTenantPrincipal("runs:read")],
    handler: getRun,
  });

  app.get("/v1/runs/:run_id/events", {
    attachValidation: true,
    schema: {
      params: getRunParamsSchema,
      querystring: listRunEventsQuerySchema,
      response: { 200: runEventPageResponseSchema },
    },
    preHandler: [requireTenantPrincipal("runs:read")],
    handler: listRunEvents,
  });

  app.get("/v1/runs/:run_id/result", {
    attachValidation: true,
    schema: {
      params: getRunParamsSchema,
      querystring: getRunResultQuerySchema,
      response: { 200: runResultResponseSchema },
    },
    preHandler: [requireTenantPrincipal("results:read")],
    handler: getRunResult,
  });

  app.post("/v1/services/:service_id/runs", {
    attachValidation: true,
    schema: {
      params: createRunParamsSchema,
      headers: createRunHeadersSchema,
      body: createRunBodySchema,
      response: { 202: runAcceptedResponseSchema },
    },
    preHandler: [requireTenantPrincipal("runs:write")],
    handler: createRun,
  });

  app.post("/v1/runs/:run_id/cancel", {
    attachValidation: true,
    schema: {
      params: getRunParamsSchema,
      headers: createRunHeadersSchema,
      response: { 202: runResponseSchema },
    },
    preHandler: [requireTenantPrincipal("runs:write")],
    handler: cancelRun,
  });

  app.post("/v1/runs/:run_id/retry", {
    attachValidation: true,
    schema: {
      params: getRunParamsSchema,
      headers: createRunHeadersSchema,
      response: { 202: runAcceptedResponseSchema },
    },
    preHandler: [requireTenantPrincipal("runs:write")],
    handler: retryRun,
  });
}
