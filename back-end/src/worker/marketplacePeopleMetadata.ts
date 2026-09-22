import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { loadQualificationOperatorConfig } from "../config/qualificationEnvironment.js";
import { createLoggerOptions, safeErrorLogContext } from "../config/logger.js";
import { createMarketplaceDatasetCatalogueClient } from
  "../services/brightdata/marketplace/marketplaceDatasetCatalogueClient.js";
import { createLocalProviderReferenceProtector } from
  "../services/brightdata/providerReferenceProtector.js";
import { createOperatorPool } from "../services/database/pools.js";
import { verifyOperatorPool } from "../services/database/roleVerification.js";
import { createMarketplacePeopleMetadataRepository } from
  "../services/marketplacePeople/marketplacePeopleMetadataRepository.js";
import {
  MarketplacePeopleMetadataError,
  createMarketplacePeopleMetadataService,
} from "../services/marketplacePeople/marketplacePeopleMetadataService.js";
import { createConfiguredQualificationEvidenceStore } from
  "../services/qualification/qualificationEvidenceStore.js";
import { createLocalEnvironmentSecretProvider } from
  "../services/secrets/localEnvironmentSecretProvider.js";

type Options = Readonly<Record<string, string | true>>;

function parse(values: readonly string[]): Options {
  const options: Record<string, string | true> = {};
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index] as string;
    if (!option.startsWith("--") || option in options) {
      throw new MarketplacePeopleMetadataError("MARKETPLACE_PEOPLE_METADATA_INPUT_INVALID");
    }
    const next = values[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options[option] = true;
    } else {
      options[option] = next;
      index += 1;
    }
  }
  const allowed = new Set([
    "--candidate-id",
    "--actor",
    "--evidence-reference",
    "--confirm-read-only-provider",
  ]);
  if (Object.keys(options).some((name) => !allowed.has(name))) {
    throw new MarketplacePeopleMetadataError("MARKETPLACE_PEOPLE_METADATA_INPUT_INVALID");
  }
  return Object.freeze(options);
}

function value(options: Options, name: string): string {
  const result = options[name];
  if (typeof result !== "string") {
    throw new MarketplacePeopleMetadataError("MARKETPLACE_PEOPLE_METADATA_INPUT_INVALID");
  }
  return result;
}

export async function runMarketplacePeopleMetadataCommand(
  values = process.argv.slice(2),
): Promise<unknown> {
  const options = parse(values);
  if (options["--confirm-read-only-provider"] !== true) {
    throw new MarketplacePeopleMetadataError(
      "MARKETPLACE_PEOPLE_METADATA_CONFIRMATION_REQUIRED",
    );
  }
  const config = loadQualificationOperatorConfig();
  const logger = pino(createLoggerOptions(config, "dhumi-marketplace-people-metadata-operator"));
  const pool = createOperatorPool(
    config.database,
    (error) => logger.error(
      safeErrorLogContext(error),
      "Unexpected LinkedIn People metadata database error",
    ),
    "dhumi-marketplace-people-metadata-operator",
  );
  const abort = new AbortController();
  const stop = (): void => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await verifyOperatorPool(pool, config.database.credential.user);
    const service = createMarketplacePeopleMetadataService({
      repository: createMarketplacePeopleMetadataRepository(pool),
      evidenceStore: await createConfiguredQualificationEvidenceStore(config.storage),
      client: createMarketplaceDatasetCatalogueClient({
        requestTimeoutMs: config.requestTimeoutMs,
        responseMaxBytes: config.catalogueResponseMaxBytes,
      }),
      secretProvider: createLocalEnvironmentSecretProvider(config.nodeEnv),
      protector: createLocalProviderReferenceProtector(
        config.nodeEnv,
        config.providerReferenceLocalKey,
      ),
      evidenceMaxBytes: config.storage.maxBytes,
    });
    return await service.capture({
      candidateId: value(options, "--candidate-id"),
      actor: value(options, "--actor"),
      restrictedReference: value(options, "--evidence-reference"),
      confirmedReadOnlyRequest: true,
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
  runMarketplacePeopleMetadataCommand()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error: unknown) => {
      const logger = pino({ base: { service: "dhumi-marketplace-people-metadata-operator" } });
      logger.error(safeErrorLogContext(error), "LinkedIn People metadata command failed");
      process.exitCode = 1;
    });
}
