import { createHash } from "node:crypto";
import type {
  FastifyReply,
  FastifyRequest,
  FastifySchemaValidationError,
} from "fastify";
import type { ApiKeyCreateBody } from "../helpers/apiKeyCanonicalization.js";
import { authenticationRequired } from "../services/identity/sessionErrors.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function databaseRequestId(requestId: string): string | null {
  return UUID_PATTERN.test(requestId) ? requestId : null;
}

function ipFingerprint(ip: string | undefined): Buffer | null {
  return ip === undefined || ip === ""
    ? null
    : createHash("sha256").update(ip, "utf8").digest();
}

function validationErrors(request: FastifyRequest): readonly {
  readonly field: string;
  readonly message: string;
}[] {
  return (request.validationError?.validation ?? []).map((issue: FastifySchemaValidationError) => ({
    field:
      issue.instancePath === ""
        ? (request.validationError?.validationContext ?? "body")
        : issue.instancePath,
    message: issue.message ?? "is invalid",
  }));
}

function requestBody(value: unknown): ApiKeyCreateBody {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as ApiKeyCreateBody)
    : {};
}

function requestQuery(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function requestParams(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

export async function listApiKeys(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const identity = request.trustedTenantIdentity;
  if (identity === null) {
    throw authenticationRequired();
  }
  const query = requestQuery(request.query);
  const result = await request.server.listApiKeysService.list({
    identity,
    cursor: query.cursor,
    limit: query.limit,
    schemaErrors: validationErrors(request),
  });

  await reply.status(200).send(result);
}

export async function createApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const identity = request.trustedTenantIdentity;
  if (identity === null) {
    throw authenticationRequired();
  }
  const csrfHeader = request.headers["x-csrf-token"];
  const idempotencyHeader = request.headers["idempotency-key"];
  const result = await request.server.createApiKeyService.create({
    identity,
    csrfToken: typeof csrfHeader === "string" ? csrfHeader : undefined,
    idempotencyKey: typeof idempotencyHeader === "string" ? idempotencyHeader : undefined,
    body: requestBody(request.body),
    schemaErrors: validationErrors(request),
    requestId: databaseRequestId(request.id),
    ipFingerprint: ipFingerprint(request.ip),
  });

  await reply.status(201).send(result);
}

export async function revokeApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const identity = request.trustedTenantIdentity;
  if (identity === null) {
    throw authenticationRequired();
  }
  const params = requestParams(request.params);
  const csrfHeader = request.headers["x-csrf-token"];
  await request.server.revokeApiKeyService.revoke({
    identity,
    keyId: params.key_id,
    csrfToken: typeof csrfHeader === "string" ? csrfHeader : undefined,
    schemaErrors: validationErrors(request),
    requestId: databaseRequestId(request.id),
    ipFingerprint: ipFingerprint(request.ip),
  });

  await reply.status(204).send();
}
