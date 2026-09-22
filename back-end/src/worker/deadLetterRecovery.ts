import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { loadDeadLetterRecoveryConfig } from "../config/pattern4Environment.js";
import { createLoggerOptions, safeErrorLogContext } from "../config/logger.js";
import { createOperatorPool } from "../services/database/pools.js";
import { verifyOperatorPool } from "../services/database/roleVerification.js";
import {
  type DeadLetterRecoveryReason,
  createDeadLetterRecoveryRepository,
} from "../services/jobs/deadLetterRecoveryRepository.js";
import { createDeadLetterRecoveryService } from "../services/jobs/deadLetterRecoveryService.js";
import { createServiceBusDeadLetterCommandReceiver } from "../services/jobs/serviceBusExecutionQueue.js";

const reasons = new Set<DeadLetterRecoveryReason>([
  "transient_infrastructure_recovered",
  "configuration_repaired",
  "manual_reconciliation_required",
]);

function argumentsFor(values: readonly string[]): {
  readonly eventId: string;
  readonly reasonCode: DeadLetterRecoveryReason;
} {
  const [eventId, reasonCode, ...extra] = values;
  if (eventId === undefined || reasonCode === undefined || extra.length > 0) {
    throw new Error(
      "Usage: worker:dlq-recover -- <event-id> <transient_infrastructure_recovered|configuration_repaired|manual_reconciliation_required>",
    );
  }
  if (!reasons.has(reasonCode as DeadLetterRecoveryReason)) {
    throw new Error("Dead-letter recovery reason is not approved");
  }
  return { eventId, reasonCode: reasonCode as DeadLetterRecoveryReason };
}

export async function recoverDeadLetteredCommand(values = process.argv.slice(2)): Promise<void> {
  const request = argumentsFor(values);
  const config = loadDeadLetterRecoveryConfig();
  const logger = pino(createLoggerOptions(config, "dhumi-dlq-operator"));
  const pool = createOperatorPool(config.database, (error) => {
    logger.error(safeErrorLogContext(error), "Unexpected DLQ operator database client error");
  });
  const receiver = createServiceBusDeadLetterCommandReceiver(config.serviceBus);
  try {
    await verifyOperatorPool(pool, config.database.credential.user);
    const result = await createDeadLetterRecoveryService({
      receiver,
      repository: createDeadLetterRecoveryRepository(pool),
    }).recover({ ...request, maxWaitTimeMs: 10_000 });
    logger.info(
      {
        originalEventId: request.eventId,
        recoveryEventId: result.recoveryEventId,
        scheduled: result.scheduled,
        terminal: result.terminal,
        deadLetterReason: result.deadLetterReason,
      },
      "Controlled dead-letter recovery completed",
    );
  } finally {
    await Promise.allSettled([receiver.close(), pool.end()]);
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  recoverDeadLetteredCommand().catch((error: unknown) => {
    const logger = pino({ base: { service: "dhumi-dlq-operator" } });
    logger.error(safeErrorLogContext(error), "Controlled dead-letter recovery failed");
    process.exitCode = 1;
  });
}
