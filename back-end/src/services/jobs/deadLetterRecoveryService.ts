import type { DeadLetterCommandReceiver } from "./executionQueue.js";
import type {
  DeadLetterRecoveryReason,
  DeadLetterRecoveryRecord,
  DeadLetterRecoveryRepository,
} from "./deadLetterRecoveryRepository.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface DeadLetterRecoveryService {
  recover(input: {
    readonly eventId: string;
    readonly reasonCode: DeadLetterRecoveryReason;
    readonly maxWaitTimeMs: number;
  }): Promise<DeadLetterRecoveryRecord & { readonly deadLetterReason: string | null }>;
}

export function createDeadLetterRecoveryService(input: {
  readonly receiver: DeadLetterCommandReceiver;
  readonly repository: DeadLetterRecoveryRepository;
}): DeadLetterRecoveryService {
  return {
    async recover(request) {
      if (!UUID_PATTERN.test(request.eventId)) throw new TypeError("eventId must be a UUID");
      if (
        !Number.isInteger(request.maxWaitTimeMs) ||
        request.maxWaitTimeMs < 100 ||
        request.maxWaitTimeMs > 60_000
      ) {
        throw new TypeError("maxWaitTimeMs must be between 100 and 60000");
      }

      const delivery = await input.receiver.receiveByEventId(
        request.eventId.toLowerCase(),
        request.maxWaitTimeMs,
      );
      if (delivery === null) throw new Error("DEAD_LETTER_COMMAND_NOT_FOUND");

      try {
        const recovery = await input.repository.requestRecovery({
          originalEventId: delivery.command.event_id,
          reasonCode: request.reasonCode,
        });
        await delivery.complete();
        return { ...recovery, deadLetterReason: delivery.deadLetterReason };
      } catch (error) {
        await delivery.abandon();
        throw error;
      }
    },
  };
}
