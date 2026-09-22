import type { FastifyInstance } from "fastify";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "../controllers/apiKeyController.js";
import { API_SCOPES } from "../helpers/apiKeyMaterial.js";
import { requireBrowserSession } from "../middleware/browserAuthentication.js";
import { requireBrowserTenantAccess } from "../middleware/tenantAuthorization.js";

const nullableDateTime = {
  anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
} as const;

const createApiKeyBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "scopes"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    scopes: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", enum: API_SCOPES },
    },
    expires_at: nullableDateTime,
  },
} as const;

const idempotencyHeadersSchema = {
  type: "object",
  required: ["idempotency-key"],
  properties: {
    "idempotency-key": {
      type: "string",
      minLength: 16,
      maxLength: 128,
      pattern: "^[A-Za-z0-9._:-]+$",
    },
  },
} as const;

const csrfHeadersSchema = {
  type: "object",
  required: ["x-csrf-token"],
  properties: {
    "x-csrf-token": {
      type: "string",
      minLength: 16,
      maxLength: 512,
    },
  },
} as const;

const revokeApiKeyParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["key_id"],
  properties: {
    key_id: { type: "string", format: "uuid" },
  },
} as const;

const apiKeyCreatedResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "prefix", "scopes", "state", "created_at", "secret"],
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string", minLength: 1, maxLength: 100 },
    prefix: { type: "string", minLength: 1 },
    scopes: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", enum: API_SCOPES },
    },
    state: { type: "string", enum: ["active", "revoked", "expired"] },
    created_at: { type: "string", format: "date-time" },
    last_used_at: nullableDateTime,
    expires_at: nullableDateTime,
    revoked_at: nullableDateTime,
    secret: { type: "string", minLength: 1 },
  },
} as const;

const listApiKeysQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cursor: { type: "string", minLength: 1, maxLength: 2048 },
    limit: { type: "string", minLength: 1, maxLength: 3, pattern: "^[0-9]+$" },
  },
} as const;

const apiKeyMetadataResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "name",
    "prefix",
    "scopes",
    "state",
    "created_at",
    "last_used_at",
    "expires_at",
    "revoked_at",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string", minLength: 1, maxLength: 100 },
    prefix: { type: "string", minLength: 1 },
    scopes: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", enum: API_SCOPES },
    },
    state: { type: "string", enum: ["active", "revoked", "expired"] },
    created_at: { type: "string", format: "date-time" },
    last_used_at: nullableDateTime,
    expires_at: nullableDateTime,
    revoked_at: nullableDateTime,
  },
} as const;

const apiKeyPageResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data", "page"],
  properties: {
    data: { type: "array", items: apiKeyMetadataResponseSchema },
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

export async function registerApiKeyRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/keys", {
    attachValidation: true,
    schema: {
      querystring: listApiKeysQuerySchema,
      response: { 200: apiKeyPageResponseSchema },
    },
    preHandler: [requireBrowserSession, requireBrowserTenantAccess],
    handler: listApiKeys,
  });

  app.post("/v1/keys", {
    attachValidation: true,
    schema: {
      headers: idempotencyHeadersSchema,
      body: createApiKeyBodySchema,
      response: { 201: apiKeyCreatedResponseSchema },
    },
    preHandler: [requireBrowserSession, requireBrowserTenantAccess],
    handler: createApiKey,
  });

  app.delete("/v1/keys/:key_id", {
    attachValidation: true,
    schema: {
      params: revokeApiKeyParamsSchema,
      headers: csrfHeadersSchema,
    },
    preHandler: [requireBrowserSession, requireBrowserTenantAccess],
    handler: revokeApiKey,
  });
}
