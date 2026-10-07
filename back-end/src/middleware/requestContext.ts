import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { FastifyInstance } from "fastify";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const traces = new WeakMap<IncomingMessage, string>();

/** One server-owned UUID, also available before Fastify's incoming log line. */
export function requestTraceId(request: IncomingMessage): string {
  let trace = traces.get(request);
  if (trace === undefined) {
    trace = randomUUID();
    traces.set(request, trace);
  }
  return trace;
}

/** Preserve the accepted caller correlation header and public error contract. */
export function createRequestId(request: IncomingMessage): string {
  const trace = requestTraceId(request);
  const candidate = request.headers["x-request-id"];
  return typeof candidate === "string" && REQUEST_ID_PATTERN.test(candidate) ? candidate : trace;
}

export function installRequestContext(app: FastifyInstance): void {
  app.decorateRequest("traceId", "");
  app.addHook("onRequest", async (request, reply) => {
    request.traceId = requestTraceId(request.raw);
    reply.header("x-request-id", request.id);
  });
}
