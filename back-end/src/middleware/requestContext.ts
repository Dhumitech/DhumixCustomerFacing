import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { FastifyInstance } from "fastify";

/**
 * Request-ID flow
 *
 * Client
 *   |
 *   | HTTP request
 *   | Optional header: x-request-id
 *   v
 * Fastify creates the request
 *   |
 *   |-- genReqId calls createRequestId()
 *   |     |
 *   |     |-- requestIdHeader() reads x-request-id
 *   |     |
 *   |     |-- Is it a string matching REQUEST_ID_PATTERN?
 *   |           |-- Yes: preserve the client's ID
 *   |           `-- No:  generate a random UUID
 *   |
 *   |-- Fastify stores the result in request.id
 *   v
 * Global onRequest hooks
 *   |
 *   |-- requestSecurity.ts applies global security plugins
 *   |
 *   `-- installRequestContext()
 *         `-- Adds x-request-id: request.id to the response
 *   v
 * Routes -> controllers -> services
 *   |
 *   | request.id is available for logs and error responses
 *   v
 * Client receives the HTTP response
 *   `-- Header: x-request-id
 *
 * createRequestId is connected to Fastify's genReqId option in app.ts.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

function requestIdHeader(request: IncomingMessage): string | undefined {
  const value = request.headers["x-request-id"];
  return typeof value === "string" ? value : undefined;
}

/**
 * Selects the correlation ID that Fastify stores as `request.id`.
 *
 * A valid caller-provided ID is preserved so the same request can be traced
 * between systems. A missing or invalid value is replaced with a random UUID.
 *
 * @param request - Raw Node.js HTTP request received by Fastify.
 * @returns The validated caller ID or a newly generated UUID.
 */
export function createRequestId(request: IncomingMessage): string {
  const candidate = requestIdHeader(request);
  return candidate !== undefined && REQUEST_ID_PATTERN.test(candidate) ? candidate : randomUUID();
}

/**
 * Installs the Fastify hook that echoes the final request ID in every response.
 *
 * @param app - Fastify application receiving the global `onRequest` hook.
 * @returns Nothing; the function registers the hook on the supplied app.
 */
export function installRequestContext(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });
}
