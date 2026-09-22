import type { FastifyReply, FastifyRequest } from "fastify";

export async function getPlatformStatus(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const result = await request.server.getPlatformStatusService.get();
  await reply.status(200).send(result);
}
