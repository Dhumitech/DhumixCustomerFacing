import type { FastifyRequest } from "fastify";

/** Establishes current-session identity; resource/Tenant authorization is separate. */
export async function requireBrowserSession(request: FastifyRequest): Promise<void> {
  request.trustedSessionIdentity = await request.server.browserAuthenticationService.authenticate(
    request.headers.authorization,
  );
}
