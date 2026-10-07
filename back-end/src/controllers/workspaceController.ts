import type { FastifyReply, FastifyRequest } from "fastify";
import { requireEstablishedTenantPrincipal } from "../middleware/tenantPrincipal.js";

export async function getWorkspace(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const workspace = await request.server.workspaceService.getWorkspace(
    requireEstablishedTenantPrincipal(request),
  );
  await reply.status(200).send({
    id: workspace.id,
    name: workspace.name,
    state: workspace.state,
    role: workspace.role,
    created_at: workspace.createdAt.toISOString(),
  });
}
