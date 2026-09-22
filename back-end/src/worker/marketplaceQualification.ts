import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { loadQualificationOperatorConfig } from "../config/qualificationEnvironment.js";
import { createLoggerOptions, safeErrorLogContext } from "../config/logger.js";
import { createMarketplaceFilterClient } from
  "../services/brightdata/marketplace/marketplaceFilterClient.js";
import { createLocalProviderReferenceProtector } from
  "../services/brightdata/providerReferenceProtector.js";
import { createOperatorPool } from "../services/database/pools.js";
import { verifyOperatorPool } from "../services/database/roleVerification.js";
import {
  createMarketplaceQualificationExecutionRepository,
} from "../services/marketplaceQualification/marketplaceQualificationExecutionRepository.js";
import {
  createMarketplaceQualificationExecutionService,
  MarketplaceQualificationExecutionError,
} from "../services/marketplaceQualification/marketplaceQualificationExecutionService.js";
import { createConfiguredQualificationEvidenceStore } from
  "../services/qualification/qualificationEvidenceStore.js";
import { createLocalEnvironmentSecretProvider } from
  "../services/secrets/localEnvironmentSecretProvider.js";

type Options = Readonly<Record<string, string | true>>;

function parse(values: readonly string[]): Options {
  const [action, ...tokens] = values;
  if (action !== "execute") {
    throw new MarketplaceQualificationExecutionError("MARKETPLACE_QUALIFICATION_INPUT_INVALID");
  }
  const options: Record<string, string | true> = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const option = tokens[index] as string;
    if (!option.startsWith("--") || option.length < 4 || option in options) {
      throw new MarketplaceQualificationExecutionError("MARKETPLACE_QUALIFICATION_INPUT_INVALID");
    }
    const next = tokens[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options[option] = true;
      continue;
    }
    options[option] = next;
    index += 1;
  }
  const allowed = new Set([
    "--packet-id",
    "--request-fingerprint",
    "--actor",
    "--confirm-exact-authorized-packet",
  ]);
  if (Object.keys(options).some((name) => !allowed.has(name))) {
    throw new MarketplaceQualificationExecutionError("MARKETPLACE_QUALIFICATION_INPUT_INVALID");
  }
  return Object.freeze(options);
}

function value(options: Options, name: string): string {
  const result = options[name];
  if (typeof result !== "string") {
    throw new MarketplaceQualificationExecutionError("MARKETPLACE_QUALIFICATION_INPUT_INVALID");
  }
  return result;
}

export async function runMarketplaceQualificationCommand(
  values = process.argv.slice(2),
): Promise<unknown> {
  if (process.env.RUN_EXECUTOR_DRIVER !== "controlled") {
    throw new MarketplaceQualificationExecutionError(
      "MARKETPLACE_QUALIFICATION_CONFIGURATION_INVALID",
    );
  }
  const options = parse(values);
  if (options["--confirm-exact-authorized-packet"] !== true) {
    throw new MarketplaceQualificationExecutionError(
      "MARKETPLACE_QUALIFICATION_CONFIRMATION_REQUIRED",
    );
  }
  const config = loadQualificationOperatorConfig();
  const logger = pino(createLoggerOptions(config, "dhumi-marketplace-qualification"));
  const pool = createOperatorPool(
    config.database,
    (error) => logger.error(
      safeErrorLogContext(error),
      "Unexpected Marketplace qualification database error",
    ),
    "dhumi-marketplace-qualification",
  );
  const abort = new AbortController();
  const stop = (): void => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await verifyOperatorPool(pool, config.database.credential.user);
    const service = createMarketplaceQualificationExecutionService({
      repository: createMarketplaceQualificationExecutionRepository(pool),
      client: createMarketplaceFilterClient({
        requestTimeoutMs: config.requestTimeoutMs,
        controlResponseMaxBytes: config.controlResponseMaxBytes,
        resultMaxBytes: config.storage.maxBytes,
        fetch,
      }),
      protector: createLocalProviderReferenceProtector(
        config.nodeEnv,
        config.providerReferenceLocalKey,
      ),
      secretProvider: createLocalEnvironmentSecretProvider(config.nodeEnv),
      evidenceStore: await createConfiguredQualificationEvidenceStore(config.storage),
      evidenceMaxBytes: config.storage.maxBytes,
      pollIntervalMs: config.pollIntervalMs,
      maximumPollFailures: 5,
    });
    return await service.execute({
      confirmedExactAuthorizedPacket: true,
      packetId: value(options, "--packet-id"),
      requestFingerprint: value(options, "--request-fingerprint"),
      actor: value(options, "--actor"),
      signal: abort.signal,
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await pool.end();
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  runMarketplaceQualificationCommand()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error: unknown) => {
      const logger = pino({ base: { service: "dhumi-marketplace-qualification" } });
      logger.error(safeErrorLogContext(error), "Marketplace qualification command failed");
      process.exitCode = 1;
    });
}
