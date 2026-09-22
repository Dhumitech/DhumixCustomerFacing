import type { FastifyInstance } from "fastify";
import { getWorkspace } from "../controllers/workspaceController.js";
import { requireTenantPrincipal } from "../middleware/tenantPrincipal.js";

const workspaceResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "state", "created_at"],
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
    state: { type: "string", enum: ["active", "suspended", "closing", "closed"] },
    created_at: { type: "string", format: "date-time" },
  },
} as const;

export async function registerWorkspaceRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/workspace", {
    schema: {
      response: { 200: workspaceResponseSchema },
    },
    preHandler: [requireTenantPrincipal()],
    handler: getWorkspace,
  });
}
