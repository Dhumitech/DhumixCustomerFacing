import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import type { RuntimeConfig } from "../config/environment.js";

const CORS_METHODS = ["GET", "POST", "DELETE", "OPTIONS"] as const;
const CORS_ALLOWED_HEADERS = [
  "Authorization",
  "Content-Type",
  "Idempotency-Key",
  "X-CSRF-Token",
  "X-Canary-Confirmation",
  "X-Request-ID",
] as const;
const CORS_EXPOSED_HEADERS = ["Retry-After", "X-Request-ID"] as const;

/**
 * Installs the security controls that are independent of any one API module.
 * Route-specific rate limits and CSRF checks are deliberately added by the
 * owning route module when those routes are implemented.
 */
export async function installRequestSecurity(
  app: FastifyInstance,
  config: RuntimeConfig,
): Promise<void> {
  await app.register(cors, {
    origin: config.frontendOrigin,
    credentials: true,
    methods: [...CORS_METHODS],
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    exposedHeaders: [...CORS_EXPOSED_HEADERS],
    strictPreflight: true,
  });

  await app.register(helmet, {
    global: true,
    ...(config.nodeEnv === "production" ? {} : { strictTransportSecurity: false }),
  });

  await app.register(cookie);

  // No unverified global limit is invented here. Authentication and other
  // public routes must opt in with their approved, tested route policy.
  await app.register(rateLimit, { global: false });
}
