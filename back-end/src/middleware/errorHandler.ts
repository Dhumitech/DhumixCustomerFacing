import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { safeErrorLogContext } from "../config/logger.js";
import { ApplicationError } from "../utils/applicationError.js";
import type { PublicProblemCode } from "../utils/publicProblemCode.js";

interface ProblemDocument {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string | null;
  readonly instance: string;
  readonly code: PublicProblemCode;
  readonly request_id: string;
  readonly errors?: readonly { readonly field: string; readonly message: string }[];
}

function sendProblem(reply: FastifyReply, problem: ProblemDocument): void {
  // The contract's shared Unauthorized response declares a WWW-Authenticate
  // header. Every 401 carries it, so the declaration is honoured wherever that
  // response is used: sign-in, refresh, logout and workspace.
  if (problem.status === 401) {
    reply.header("www-authenticate", "Bearer");
  }
  if (problem.status === 429) {
    reply.header("retry-after", "60");
  }
  void reply.status(problem.status).type("application/problem+json").send(problem);
}

function problemInstance(request: FastifyRequest): string {
  const queryStart = request.url.indexOf("?");
  return queryStart === -1 ? request.url : request.url.slice(0, queryStart);
}

export function installErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    sendProblem(reply, {
      type: "about:blank",
      title: "Route not found",
      status: 404,
      detail: null,
      instance: problemInstance(request),
      code: "RESOURCE_NOT_FOUND",
      request_id: request.id,
    });
  });

  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof ApplicationError) {
      if (error.status >= 500) {
        request.log.error(
          { ...safeErrorLogContext(error), applicationCode: error.code },
          "Internal application error",
        );
      }
      sendProblem(reply, {
        type: "about:blank",
        title: error.title,
        status: error.status,
        detail: error.detail,
        instance: problemInstance(request),
        code: error.code,
        request_id: request.id,
        ...(error.errors === undefined ? {} : { errors: error.errors }),
      });
      return;
    }

    // Schema violations arrive as Fastify validation errors. The contract
    // separates 400 "Malformed request" from 422 "Semantically invalid", so a
    // shape violation is 400 and semantic rules raise 422 from the service.
    if (error.validation !== undefined) {
      sendProblem(reply, {
        type: "about:blank",
        title: "Malformed request",
        status: 400,
        detail: null,
        instance: problemInstance(request),
        // Project Specs 03_API/01 fixes the stable public code for 400.
        code: "BAD_REQUEST",
        request_id: request.id,
        errors: error.validation.map((issue) => ({
          field:
            issue.instancePath === "" ? (error.validationContext ?? "body") : issue.instancePath,
          message: issue.message ?? "is invalid",
        })),
      });
      return;
    }

    // Rate limiting, payload limits and body-parse failures are raised by
    // Fastify itself with a safe status. Preserve the status without echoing
    // the framework's message.
    //
    // An unparseable body fails in the content-type parser, before routing
    // validation, so `attachValidation` never sees it and the branch above
    // cannot catch it. Body limits and media-type negotiation also fail before
    // route validation. Preserve those documented HTTP semantics and collapse
    // any other framework 4xx to the declared 400 contract.
    if (typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      const status =
        error.statusCode === 413 || error.statusCode === 415 || error.statusCode === 429
          ? error.statusCode
          : 400;
      const problem =
        status === 413
          ? { title: "Payload too large", code: "PAYLOAD_TOO_LARGE" as const }
          : status === 415
            ? { title: "Unsupported media type", code: "UNSUPPORTED_MEDIA_TYPE" as const }
            : status === 429
              ? { title: "Platform capacity limit", code: "PLATFORM_CAPACITY_LIMIT" as const }
              : { title: "Malformed request", code: "BAD_REQUEST" as const };
      sendProblem(reply, {
        type: "about:blank",
        title: problem.title,
        status,
        detail: null,
        instance: problemInstance(request),
        code: problem.code,
        request_id: request.id,
      });
      return;
    }

    request.log.error(safeErrorLogContext(error), "Unhandled request error");
    sendProblem(reply, {
      type: "about:blank",
      title: "Internal server error",
      status: 500,
      detail: null,
      instance: problemInstance(request),
      code: "INTERNAL_ERROR",
      request_id: request.id,
    });
  });
}
