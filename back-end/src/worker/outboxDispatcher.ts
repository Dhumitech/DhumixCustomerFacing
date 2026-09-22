import { resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import pino, { type Logger } from "pino";
import { loadOutboxDispatcherConfig } from "../config/pattern4Environment.js";
import { createLoggerOptions, safeErrorLogContext } from "../config/logger.js";
import { createOutboxDispatcherPool } from "../services/database/pools.js";
import { verifyOutboxDispatcherPool } from "../services/database/roleVerification.js";
import { createOutboxDispatcherRepository } from "../services/jobs/outboxDispatcherRepository.js";
import {
  createOutboxDispatcherService,
  type OutboxDispatcherService,
} from "../services/jobs/outboxDispatcherService.js";
import { createServiceBusJobCommandPublisher } from "../services/jobs/serviceBusExecutionQueue.js";

export interface OutboxDispatcherLoopOptions {
  readonly service: OutboxDispatcherService;
  readonly intervalMs: number;
  readonly batchSize: number;
  readonly signal: AbortSignal;
  readonly logger: Pick<Logger, "debug" | "error" | "info">;
  readonly waitForNextPoll?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export async function runOutboxDispatcherLoop(options: OutboxDispatcherLoopOptions): Promise<void> {
  const waitForNextPoll =
    options.waitForNextPoll ??
    (async (milliseconds: number, signal: AbortSignal) => {
      await wait(milliseconds, undefined, { signal });
    });

  while (!options.signal.aborted) {
    try {
      const publishedCount = await options.service.dispatchOnce();
      if (publishedCount > 0) {
        options.logger.info({ publishedCount }, "Run commands published");
      } else {
        options.logger.debug("No Run commands were due");
      }
      if (publishedCount === options.batchSize) continue;
    } catch (error) {
      if (options.signal.aborted || isAbortError(error)) return;
      options.logger.error(safeErrorLogContext(error), "Run-command dispatch poll failed");
    }

    try {
      await waitForNextPoll(options.intervalMs, options.signal);
    } catch (error) {
      if (options.signal.aborted || isAbortError(error)) return;
      throw error;
    }
  }
}

export async function startOutboxDispatcher(): Promise<void> {
  const config = loadOutboxDispatcherConfig();
  const logger = pino(createLoggerOptions(config, "dhumi-outbox-dispatcher"));
  const pool = createOutboxDispatcherPool(config.database, (error) => {
    logger.error(safeErrorLogContext(error), "Unexpected dispatcher database client error");
  });
  const publisher = createServiceBusJobCommandPublisher(config.serviceBus);
  const abortController = new AbortController();
  let shutdownSignal: NodeJS.Signals | undefined;
  const requestShutdown = (signal: NodeJS.Signals): void => {
    if (abortController.signal.aborted) return;
    shutdownSignal = signal;
    logger.info({ signal }, "Outbox Dispatcher shutdown requested");
    abortController.abort();
  };
  const onSigint = (): void => requestShutdown("SIGINT");
  const onSigterm = (): void => requestShutdown("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    await verifyOutboxDispatcherPool(pool, config.database.credential.user);
    logger.info(
      { batchSize: config.batchSize, intervalMs: config.intervalMs },
      "Outbox Dispatcher started",
    );
    await runOutboxDispatcherLoop({
      service: createOutboxDispatcherService({
        repository: createOutboxDispatcherRepository(pool),
        publisher,
        consumerId: config.dispatcherId,
        batchSize: config.batchSize,
        claimTtlMs: config.claimTtlMs,
      }),
      intervalMs: config.intervalMs,
      batchSize: config.batchSize,
      signal: abortController.signal,
      logger,
    });
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    await Promise.allSettled([publisher.close(), pool.end()]);
    logger.info({ signal: shutdownSignal }, "Outbox Dispatcher stopped");
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  startOutboxDispatcher().catch((error: unknown) => {
    const fallbackLogger = pino({ base: { service: "dhumi-outbox-dispatcher" } });
    fallbackLogger.error(safeErrorLogContext(error), "Outbox Dispatcher startup failed");
    process.exitCode = 1;
  });
}
