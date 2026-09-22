import type {
  FastifyReply,
  FastifyRequest,
  FastifySchemaValidationError,
} from "fastify";
import { requireEstablishedTenantPrincipal } from "../middleware/tenantPrincipal.js";

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

export async function getUsageSummary(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const query = requestQuery(request.query);
  const result = await request.server.getUsageSummaryService.get({
    principal: requireEstablishedTenantPrincipal(request),
    from: query.from,
    to: query.to,
    schemaErrors: validationErrors(request),
  });
  await reply.status(200).send(result);
}

export async function listUsageEvents(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const query = requestQuery(request.query);
  const result = await request.server.listUsageEventsService.list({
    principal: requireEstablishedTenantPrincipal(request),
    from: query.from,
    to: query.to,
    cursor: query.cursor,
    limit: query.limit,
    schemaErrors: validationErrors(request),
  });
  await reply.status(200).send(result);
}
