import type { JobCommandPublisher } from "./executionQueue.js";
import type { OutboxDispatcherRepository } from "./outboxDispatcherRepository.js";

export interface OutboxDispatcherService {
  dispatchOnce(): Promise<number>;
}

export function createOutboxDispatcherService(input: {
  readonly repository: OutboxDispatcherRepository;
  readonly publisher: JobCommandPublisher;
  readonly consumerId: string;
  readonly batchSize: number;
  readonly claimTtlMs: number;
}): OutboxDispatcherService {
  return {
    async dispatchOnce(): Promise<number> {
      const claimed = await input.repository.claim({
        consumerId: input.consumerId,
        batchSize: input.batchSize,
        claimTtlMs: input.claimTtlMs,
      });
      let published = 0;
      for (const event of claimed) {
        await input.publisher.publish(event.command);
        if (!(await input.repository.markPublished(event.command.event_id, event.claimToken))) {
          throw new Error("OUTBOX_PUBLISH_ACKNOWLEDGEMENT_REJECTED");
        }
        published += 1;
      }
      return published;
    },
  };
}
