import type {
  FastifyReply,
  FastifyRequest,
  FastifySchemaValidationError,
} from "fastify";
import { createHash } from "node:crypto";
import type { ServiceCreateBody } from "../helpers/serviceCanonicalization.js";
import { requireEstablishedTenantPrincipal } from "../middleware/tenantPrincipal.js";

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
  return (request.validationError?.validation ?? []).map(
    (issue: FastifySchemaValidationError) => ({
      field:
        issue.instancePath === ""
          ? (request.validationError?.validationContext ?? "querystring")
          : issue.instancePath,
      message: issue.message ?? "is invalid",
    }),
  );
}

function requestQuery(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function requestBody(value: unknown): ServiceCreateBody {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as ServiceCreateBody)
    : {};
}

function requestParams(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

export async function listServices(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const query = requestQuery(request.query);
  const result = await request.server.listServicesService.list({
    principal: requireEstablishedTenantPrincipal(request),
    cursor: query.cursor,
    limit: query.limit,
    schemaErrors: validationErrors(request),
  });

  await reply.status(200).send(result);
}

export async function createService(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const csrfHeader = request.headers["x-csrf-token"];
  const idempotencyHeader = request.headers["idempotency-key"];
  const result = await request.server.createServiceService.create({
    principal: requireEstablishedTenantPrincipal(request),
    csrfToken: typeof csrfHeader === "string" ? csrfHeader : undefined,
    idempotencyKey:
      typeof idempotencyHeader === "string" ? idempotencyHeader : undefined,
    body: requestBody(request.body),
    schemaErrors: validationErrors(request),
    requestId: databaseRequestId(request.id),
    ipFingerprint: ipFingerprint(request.ip),
  });

  await reply.status(201).send(result);
}

export async function getService(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const params = requestParams(request.params);
  const result = await request.server.getServiceService.get({
    principal: requireEstablishedTenantPrincipal(request),
    serviceId: params.service_id,
    schemaErrors: validationErrors(request),
  });

  await reply.status(200).send(result);
}
