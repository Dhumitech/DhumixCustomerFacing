import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { loadSampleDownloadCleanupConfig } from "../config/sampleDownloadCleanupEnvironment.js";
import { createLoggerOptions, safeErrorLogContext } from "../config/logger.js";
import { createOperatorPool } from "../services/database/pools.js";
import { verifyOperatorPool } from "../services/database/roleVerification.js";
import { withOperatorTransaction } from "../services/database/transactions.js";
import { createConfiguredMarketplaceSampleDownloadStore } from
  "../services/marketplaceSampleDownload/azuriteMarketplaceSampleDownloadStore.js";
import { createMarketplaceSampleDownloadCleanupRepository } from
  "../services/marketplaceSampleDownload/marketplaceSampleDownloadCleanupRepository.js";
import { cleanupMarketplaceSampleDownloads } from
  "../services/marketplaceSampleDownload/marketplaceSampleDownloadCleanup.js";

export function parseSampleDownloadCleanupCommand(values: readonly string[]): {
  readonly expectedDatabase: string;
  readonly pageSize: number;
  readonly maxPages: number;
} {
  const options = new Map<string, string | true>();
  const allowed = new Set(["--expected-database", "--page-size", "--max-pages", "--confirm-delete-generated-objects"]);
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index] as string;
    if (!allowed.has(name) || options.has(name)) throw new TypeError("Invalid cleanup command option");
    if (name === "--confirm-delete-generated-objects") options.set(name, true);
    else {
      const value = values[++index];
      if (value === undefined || value.startsWith("--")) throw new TypeError("Missing cleanup command value");
      options.set(name, value);
    }
  }
  if (options.get("--confirm-delete-generated-objects") !== true) {
    throw new TypeError("Explicit --confirm-delete-generated-objects is required");
  }
  const expectedDatabase = options.get("--expected-database");
  const pageSize = Number(options.get("--page-size") ?? 100);
  const maxPages = Number(options.get("--max-pages") ?? 1000);
  if (typeof expectedDatabase !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(expectedDatabase) ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000 ||
      !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 10000) {
    throw new TypeError("Invalid cleanup command bounds or database identity");
  }
  return { expectedDatabase, pageSize, maxPages };
}

export async function runSampleDownloadCleanupCommand(values = process.argv.slice(2)): Promise<void> {
  const options = parseSampleDownloadCleanupCommand(values);
  const config = loadSampleDownloadCleanupConfig();
  if (config.database.database !== options.expectedDatabase) throw new Error("Cleanup database configuration mismatch");
  const logger = pino(createLoggerOptions(config, "dhumi-sample-download-cleanup"));
  const pool = createOperatorPool(config.database,
    (error) => logger.error(safeErrorLogContext(error), "Unexpected cleanup database error"),
    "dhumi-sample-download-cleanup");
  try {
    await verifyOperatorPool(pool, config.database.credential.user);
    const identity = await withOperatorTransaction(pool, (database) =>
      database.query<{ database_name: string; migrated: boolean }>(
        `SELECT current_database() AS database_name,
          to_regclass('app.marketplace_sample_downloads') IS NOT NULL AND to_regclass('app.organizations') IS NOT NULL AND EXISTS(SELECT 1 FROM app.schema_migrations WHERE version='0075_naming') AS migrated`,
      ));
    if (identity.rows[0]?.database_name !== options.expectedDatabase || identity.rows[0].migrated !== true) {
      throw new Error("Cleanup database identity or migration 0075 is not verified");
    }
    const store = await createConfiguredMarketplaceSampleDownloadStore(config.storage);
    const summary = await cleanupMarketplaceSampleDownloads({
      store,
      repository: createMarketplaceSampleDownloadCleanupRepository(pool),
      pageSize: options.pageSize,
      maxPages: options.maxPages,
    });
    logger.info({ ...summary, providerCalls: 0 }, "Generated sample-download cleanup completed");
    if (!summary.complete || summary.failures > 0 || summary.untracked > 0 || summary.ignored > 0) {
      throw new Error("Cleanup needs operator review; unverified objects were preserved");
    }
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  runSampleDownloadCleanupCommand().catch((error: unknown) => {
    pino({ base: { service: "dhumi-sample-download-cleanup" } })
      .error(safeErrorLogContext(error), "Sample-download cleanup failed");
    process.exitCode = 1;
  });
}
