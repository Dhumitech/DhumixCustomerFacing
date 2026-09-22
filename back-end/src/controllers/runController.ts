import { createHash } from "node:crypto";
import type {
  FastifyReply,
  FastifyRequest,
  FastifySchemaValidationError,
} from "fastify";
import type { RunCreateBody } from "../helpers/runCanonicalization.js";
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
          ? (request.validationError?.validationContext ?? "body")
          : issue.instancePath,
      message: issue.message ?? "is invalid",
    }),
  );
}

function requestBody(value: unknown): RunCreateBody {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RunCreateBody)
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

export async function listRuns(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const query = requestQuery(request.query);
  const result = await request.server.listRunsService.list({
    principal: requireEstablishedTenantPrincipal(request),
    status: query.status,
    serviceId: query.service_id,
    cursor: query.cursor,
    limit: query.limit,
    schemaErrors: validationErrors(request),
  });

  await reply.status(200).send(result);
}

export async function getRun(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const params = requestParams(request.params);
  const result = await request.server.getRunService.get({
    principal: requireEstablishedTenantPrincipal(request),
    runId: params.run_id,
    schemaErrors: validationErrors(request),
  });

  await reply.status(200).send(result);
}

export async function getRunResult(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const params = requestParams(request.params);
  const query = requestQuery(request.query);
  const result = await request.server.getRunResultService.get({
    principal: requireEstablishedTenantPrincipal(request),
    runId: params.run_id,
    representation: query.representation,
    schemaErrors: validationErrors(request),
    requestId: databaseRequestId(request.id),
    ipFingerprint: ipFingerprint(request.ip),
  });

  await reply.status(200).send(result);
}

export async function listRunEvents(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const params = requestParams(request.params);
  const query = requestQuery(request.query);
  const result = await request.server.listRunEventsService.list({
    principal: requireEstablishedTenantPrincipal(request),
    runId: params.run_id,
    cursor: query.cursor,
    limit: query.limit,
    schemaErrors: validationErrors(request),
  });

  await reply.status(200).send(result);
}

export async function createRun(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const params = requestParams(request.params);
  const csrfHeader = request.headers["x-csrf-token"];
  const idempotencyHeader = request.headers["idempotency-key"];
  const result = await request.server.createRunService.create({
    principal: requireEstablishedTenantPrincipal(request),
    csrfToken: typeof csrfHeader === "string" ? csrfHeader : undefined,
    idempotencyKey:
      typeof idempotencyHeader === "string" ? idempotencyHeader : undefined,
    serviceId: params.service_id,
    body: requestBody(request.body),
    schemaErrors: validationErrors(request),
    requestId: databaseRequestId(request.id),
    ipFingerprint: ipFingerprint(request.ip),
  });

  await reply.status(202).send(result);
}

export async function cancelRun(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const params = requestParams(request.params);
  const csrfHeader = request.headers["x-csrf-token"];
  const idempotencyHeader = request.headers["idempotency-key"];
  const result = await request.server.cancelRunService.cancel({
    principal: requireEstablishedTenantPrincipal(request),
    csrfToken: typeof csrfHeader === "string" ? csrfHeader : undefined,
    idempotencyKey:
      typeof idempotencyHeader === "string" ? idempotencyHeader : undefined,
    runId: params.run_id,
    bodyPresent: request.body !== undefined,
    schemaErrors: validationErrors(request),
    requestId: databaseRequestId(request.id),
    ipFingerprint: ipFingerprint(request.ip),
  });

  await reply.status(202).send(result);
}

export async function retryRun(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const params = requestParams(request.params);
  const csrfHeader = request.headers["x-csrf-token"];
  const idempotencyHeader = request.headers["idempotency-key"];
  const result = await request.server.retryRunService.retry({
    principal: requireEstablishedTenantPrincipal(request),
    csrfToken: typeof csrfHeader === "string" ? csrfHeader : undefined,
    idempotencyKey:
      typeof idempotencyHeader === "string" ? idempotencyHeader : undefined,
    runId: params.run_id,
    bodyPresent: request.body !== undefined,
    schemaErrors: validationErrors(request),
    requestId: databaseRequestId(request.id),
    ipFingerprint: ipFingerprint(request.ip),
  });

  await reply.status(202).send(result);
}
