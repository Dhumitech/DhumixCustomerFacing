import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest, FastifySchemaValidationError } from "fastify";
import { requireEstablishedBrowsePrincipal } from "../middleware/browsePrincipal.js";
import { requireEstablishedTenantPrincipal } from "../middleware/tenantPrincipal.js";

function validationErrors(request: FastifyRequest): readonly {
  readonly field: string;
  readonly message: string;
}[] {
  return (request.validationError?.validation ?? []).map((issue: FastifySchemaValidationError) => ({
    field:
      issue.instancePath === ""
        ? (request.validationError?.validationContext ?? "querystring")
        : issue.instancePath,
    message: issue.message ?? "is invalid",
  }));
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

export async function listCatalogTemplates(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const query = requestQuery(request.query);
  const result = await request.server.listCatalogTemplatesService.list({
    principal: requireEstablishedBrowsePrincipal(request),
    family: query.family,
    cursor: query.cursor,
    limit: query.limit,
    schemaErrors: validationErrors(request),
  });

  await reply.status(200).send(result);
}

export async function getTemplate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const params = requestParams(request.params);
  const result = await request.server.getCatalogTemplateService.get({
    principal: requireEstablishedBrowsePrincipal(request),
    slug: params.slug,
    schemaErrors: validationErrors(request),
  });

  await reply.status(200).send(result);
}

export async function getMarketplaceSample(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const params = requestParams(request.params);
  const query = requestQuery(request.query);
  const result = await request.server.marketplacePreviewService.get({
    principal: requireEstablishedBrowsePrincipal(request),
    slug: params.slug,
    cursor: query.cursor,
    limit: query.limit,
    schemaErrors: validationErrors(request),
  });

  await reply.status(200).send(result);
}

export async function queryMarketplaceSample(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const params = requestParams(request.params);
  const csrfHeader = request.headers["x-csrf-token"];
  const body =
    typeof request.body === "object" && request.body !== null && !Array.isArray(request.body)
      ? request.body
      : {};
  const result = await request.server.marketplacePreviewService.query({
    principal: requireEstablishedBrowsePrincipal(request),
    slug: params.slug,
    csrfToken: typeof csrfHeader === "string" ? csrfHeader : undefined,
    body,
    schemaErrors: validationErrors(request),
  });

  await reply.status(200).send(result);
}

function ipFingerprint(ip: string | undefined): Buffer | null {
  return ip === undefined || ip === "" ? null : createHash("sha256").update(ip, "utf8").digest();
}

export async function authorizeMarketplaceSampleDownload(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const params = requestParams(request.params);
  const csrfHeader = request.headers["x-csrf-token"];
  const idempotencyHeader = request.headers["idempotency-key"];
  const body =
    typeof request.body === "object" && request.body !== null && !Array.isArray(request.body)
      ? request.body
      : {};
  const result = await request.server.marketplaceSampleDownloadService.authorize({
    principal: requireEstablishedTenantPrincipal(request),
    slug: params.slug,
    csrfToken: typeof csrfHeader === "string" ? csrfHeader : undefined,
    idempotencyKey: typeof idempotencyHeader === "string" ? idempotencyHeader : undefined,
    body,
    schemaErrors: validationErrors(request),
    requestId: request.traceId,
    ipFingerprint: ipFingerprint(request.ip),
  });
  await reply.status(201).send(result);
}

export async function createMarketplaceExpertEnquiry(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const params = requestParams(request.params);
  const csrfHeader = request.headers["x-csrf-token"];
  const idempotencyHeader = request.headers["idempotency-key"];
  const body =
    typeof request.body === "object" && request.body !== null && !Array.isArray(request.body)
      ? request.body
      : {};
  const result = await request.server.marketplaceExpertEnquiryService.submit({
    principal: requireEstablishedTenantPrincipal(request),
    slug: params.slug,
    csrfToken: typeof csrfHeader === "string" ? csrfHeader : undefined,
    idempotencyKey: typeof idempotencyHeader === "string" ? idempotencyHeader : undefined,
    body,
    schemaErrors: validationErrors(request),
    requestId: request.traceId,
    ipFingerprint: ipFingerprint(request.ip),
  });
  await reply.status(201).send(result);
}
