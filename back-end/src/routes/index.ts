import type { FastifyInstance } from "fastify";
import type { RuntimeConfig } from "../config/environment.js";
import { registerAuthRoutes } from "./authRoutes.js";
import { registerWorkspaceRoutes } from "./workspaceRoutes.js";
import { registerApiKeyRoutes } from "./apiKeyRoutes.js";
import { registerCatalogueRoutes } from "./catalogueRoutes.js";
import { registerServiceRoutes } from "./serviceRoutes.js";
import { registerRunRoutes } from "./runRoutes.js";
import { registerUsageRoutes } from "./usageRoutes.js";
import { registerStatusRoutes } from "./statusRoutes.js";

/** Only routes present in the accepted OpenAPI contract are registered here. */
export async function registerRoutes(
  app: FastifyInstance,
  config: RuntimeConfig,
): Promise<void> {
  await registerAuthRoutes(app, config);
  await registerWorkspaceRoutes(app);
  await registerApiKeyRoutes(app);
  await registerCatalogueRoutes(app);
  await registerServiceRoutes(app);
  await registerRunRoutes(app);
  await registerUsageRoutes(app);
  await registerStatusRoutes(app);
}
