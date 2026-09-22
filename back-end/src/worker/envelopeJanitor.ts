import { setTimeout as wait } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import pino, { type Logger } from "pino";
import { loadEnvelopeJanitorConfig } from "../config/environment.js";
import { createLoggerOptions, safeErrorLogContext } from "../config/logger.js";
import { createEnvelopeJanitorPool } from "../services/database/pools.js";
import { verifyEnvelopeJanitorPool } from "../services/database/roleVerification.js";
import {
  createEnvelopeJanitorRepository,
  type EnvelopeJanitorRepository,
} from "../services/envelopeJanitor/envelopeJanitorRepository.js";

export interface EnvelopeJanitorLoopOptions {
  readonly repository: EnvelopeJanitorRepository;
  readonly batchSize: number;
  readonly intervalMs: number;
  readonly signal: AbortSignal;
  readonly logger: Pick<Logger, "debug" | "error" | "info">;
  readonly waitForNextPoll?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function defaultWaitForNextPoll(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  await wait(milliseconds, undefined, { signal });
}

export async function runEnvelopeJanitorLoop(options: EnvelopeJanitorLoopOptions): Promise<void> {
  const waitForNextPoll = options.waitForNextPoll ?? defaultWaitForNextPoll;

  while (!options.signal.aborted) {
    try {
      const destroyedCount = await options.repository.destroyDue(options.batchSize);
      if (destroyedCount > 0) {
        options.logger.info({ destroyedCount }, "Expired response envelopes destroyed");
      } else {
        options.logger.debug("No expired response envelopes were due");
      }

      // A full batch is evidence that more due work may already exist. Drain it
      // sequentially without creating overlapping database transactions.
      if (destroyedCount === options.batchSize) {
        continue;
      }
    } catch (error) {
      if (options.signal.aborted || isAbortError(error)) {
        return;
      }
      options.logger.error(safeErrorLogContext(error), "Envelope destruction poll failed");
    }

    try {
      await waitForNextPoll(options.intervalMs, options.signal);
    } catch (error) {
      if (options.signal.aborted || isAbortError(error)) {
        return;
      }
      throw error;
    }
  }
}

export async function startEnvelopeJanitor(): Promise<void> {
  const config = loadEnvelopeJanitorConfig();
  const logger = pino(createLoggerOptions(config, "dhumi-envelope-janitor"));
  const pool = createEnvelopeJanitorPool(config.database, (error) => {
    logger.error(
      safeErrorLogContext(error),
      "Unexpected idle envelope-janitor database client error",
    );
  });
  const abortController = new AbortController();
  let shutdownSignal: NodeJS.Signals | undefined;

  const requestShutdown = (signal: NodeJS.Signals): void => {
    if (abortController.signal.aborted) return;
    shutdownSignal = signal;
    logger.info({ signal }, "Envelope janitor shutdown requested");
    abortController.abort();
  };
  const onSigint = (): void => requestShutdown("SIGINT");
  const onSigterm = (): void => requestShutdown("SIGTERM");

  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    await verifyEnvelopeJanitorPool(pool, config.database.credential.user);
    logger.info(
      { batchSize: config.batchSize, intervalMs: config.intervalMs },
      "Envelope janitor started",
    );
    await runEnvelopeJanitorLoop({
      repository: createEnvelopeJanitorRepository(pool),
      batchSize: config.batchSize,
      intervalMs: config.intervalMs,
      signal: abortController.signal,
      logger,
    });
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    await pool.end();
    logger.info({ signal: shutdownSignal }, "Envelope janitor stopped");
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  startEnvelopeJanitor().catch((error: unknown) => {
    const fallbackLogger = pino({ base: { service: "dhumi-envelope-janitor" } });
    fallbackLogger.error(safeErrorLogContext(error), "Envelope janitor startup failed");
    process.exitCode = 1;
  });
}
