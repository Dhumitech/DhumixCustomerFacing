import type { Logger } from "pino";
import { safeErrorLogContext } from "../config/logger.js";
import type { JobCommandReceiver } from "../services/jobs/executionQueue.js";
import type { JobManagerService } from "../services/jobs/jobManagerService.js";

export async function runJobManagerSubscription(input: {
  readonly receiver: JobCommandReceiver;
  readonly service: JobManagerService;
  readonly signal: AbortSignal;
  readonly logger: Pick<Logger, "error">;
}): Promise<void> {
  if (input.signal.aborted) return;

  const subscription = await input.receiver.subscribe(
    async (delivery) => {
      try {
        await input.service.handle(delivery);
      } catch (error) {
        input.logger.error(
          { ...safeErrorLogContext(error), deliveryCount: delivery.deliveryCount },
          "Run command handling failed",
        );
      }
    },
    async (error) => {
      input.logger.error(safeErrorLogContext(error), "Service Bus receiver failed");
    },
  );

  try {
    await new Promise<void>((resolve) => {
      if (input.signal.aborted) {
        resolve();
        return;
      }
      input.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  } finally {
    // The Service Bus subscription contract stops new deliveries and waits for
    // already-dispatched handlers before resolving close(). Database, Redis
    // and storage clients therefore remain available until this drain ends.
    await subscription.close();
  }
}
