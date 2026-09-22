import type { FastifyInstance } from "fastify";
import { ApplicationError } from "../utils/applicationError.js";

function mediaType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

/** Rejects a declared JSON request body before Fastify's permissive text parser. */
export function installJsonContentTypeGuard(app: FastifyInstance): void {
  app.addHook("onRequest", async (request) => {
    if (request.routeOptions.schema?.body === undefined) return;
    const contentType = request.headers["content-type"];
    // An absent header/body remains Fastify's syntactic 400 path. A caller
    // explicitly selecting another representation receives the declared 415.
    if (contentType === undefined || mediaType(contentType) === "application/json") return;
    throw new ApplicationError({
      status: 415,
      code: "UNSUPPORTED_MEDIA_TYPE",
      title: "Unsupported media type",
    });
  });
}
