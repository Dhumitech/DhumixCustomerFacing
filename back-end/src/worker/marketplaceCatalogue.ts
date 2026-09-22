import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { loadQualificationOperatorConfig } from "../config/qualificationEnvironment.js";
import { createLoggerOptions, safeErrorLogContext } from "../config/logger.js";
import {
  createFixtureMarketplaceDatasetCatalogueClient,
  createMarketplaceDatasetCatalogueClient,
} from "../services/brightdata/marketplace/marketplaceDatasetCatalogueClient.js";
import { createLocalProviderReferenceProtector } from
  "../services/brightdata/providerReferenceProtector.js";
import { createOperatorPool } from "../services/database/pools.js";
import { verifyOperatorPool } from "../services/database/roleVerification.js";
import { createMarketplaceCatalogueRepository } from
  "../services/marketplaceCatalogue/marketplaceCatalogueRepository.js";
import {
  MarketplaceCatalogueError,
  createMarketplaceCatalogueService,
  reviewMarketplaceCatalogueCandidate,
} from "../services/marketplaceCatalogue/marketplaceCatalogueService.js";
import { createConfiguredQualificationEvidenceStore } from
  "../services/qualification/qualificationEvidenceStore.js";
import { createLocalEnvironmentSecretProvider } from
  "../services/secrets/localEnvironmentSecretProvider.js";

type Options = Readonly<Record<string, string | true>>;

function parse(values: readonly string[]): {
  readonly action: "import" | "review";
  readonly options: Options;
} {
  const [action, ...tokens] = values;
  if (action !== "import" && action !== "review") {
    throw new MarketplaceCatalogueError("MARKETPLACE_CATALOGUE_INPUT_INVALID");
  }
  const options: Record<string, string | true> = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const option = tokens[index] as string;
    if (!option.startsWith("--") || option.length < 4 || option in options) {
      throw new MarketplaceCatalogueError("MARKETPLACE_CATALOGUE_INPUT_INVALID");
    }
    const next = tokens[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options[option] = true;
      continue;
    }
    options[option] = next;
    index += 1;
  }
  return { action, options: Object.freeze(options) };
}

function only(options: Options, names: readonly string[]): void {
  const allowed = new Set(names);
  if (Object.keys(options).some((name) => !allowed.has(name))) {
    throw new MarketplaceCatalogueError("MARKETPLACE_CATALOGUE_INPUT_INVALID");
  }
}

function value(options: Options, name: string): string {
  const result = options[name];
  if (typeof result !== "string") {
    throw new MarketplaceCatalogueError("MARKETPLACE_CATALOGUE_INPUT_INVALID");
  }
  return result;
}

async function fixtureClient(directory: string, maximumBytes: number) {
  if (!isAbsolute(directory)) {
    throw new MarketplaceCatalogueError("MARKETPLACE_CATALOGUE_INPUT_INVALID");
  }
  const read = async (fileName: string): Promise<Buffer> => {
    const bytes = await readFile(join(directory, fileName));
    if (bytes.byteLength < 2 || bytes.byteLength > maximumBytes) {
      throw new MarketplaceCatalogueError("MARKETPLACE_CATALOGUE_INPUT_INVALID");
    }
    return bytes;
  };
  return createFixtureMarketplaceDatasetCatalogueClient({
    listBytes: await read("dataset-list.json"),
    metadataBytesByDatasetName: new Map([
      ["linkedin posts", await read("linkedin-posts-metadata.json")],
      ["linkedin people profiles", await read("linkedin-people-metadata.json")],
    ]),
  });
}

export async function runMarketplaceCatalogueCommand(
  values = process.argv.slice(2),
): Promise<unknown> {
  const request = parse(values);
  const config = loadQualificationOperatorConfig();
  const logger = pino(createLoggerOptions(config, "dhumi-marketplace-catalogue-operator"));
  const pool = createOperatorPool(
    config.database,
    (error) => logger.error(
      safeErrorLogContext(error),
      "Unexpected Marketplace catalogue database error",
    ),
    "dhumi-marketplace-catalogue-operator",
  );
  const abort = new AbortController();
  const stop = (): void => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await verifyOperatorPool(pool, config.database.credential.user);
    const repository = createMarketplaceCatalogueRepository(pool);
    if (request.action === "review") {
      only(request.options, ["--candidate-id", "--decision", "--actor"]);
      const decision = value(request.options, "--decision");
      if (decision !== "approve" && decision !== "reject") {
        throw new MarketplaceCatalogueError("MARKETPLACE_CATALOGUE_INPUT_INVALID");
      }
      return await reviewMarketplaceCatalogueCandidate(repository, {
        candidateId: value(request.options, "--candidate-id"),
        decision,
        actor: value(request.options, "--actor"),
      });
    }

    only(request.options, [
      "--source",
      "--fixture-directory",
      "--confirm-read-only-provider",
      "--actor",
      "--evidence-reference",
    ]);
    const source = value(request.options, "--source");
    if (source !== "fixture" && source !== "provider") {
      throw new MarketplaceCatalogueError("MARKETPLACE_CATALOGUE_INPUT_INVALID");
    }
    const confirmedReadOnlyRequest =
      request.options["--confirm-read-only-provider"] === true ? true : undefined;
    if (source === "provider" && confirmedReadOnlyRequest !== true) {
      throw new MarketplaceCatalogueError(
        "MARKETPLACE_CATALOGUE_READ_CONFIRMATION_REQUIRED",
      );
    }
    if (source === "fixture" && request.options["--confirm-read-only-provider"] !== undefined) {
      throw new MarketplaceCatalogueError("MARKETPLACE_CATALOGUE_INPUT_INVALID");
    }
    const client = source === "fixture"
      ? await fixtureClient(
          value(request.options, "--fixture-directory"),
          config.catalogueResponseMaxBytes,
        )
      : createMarketplaceDatasetCatalogueClient({
          requestTimeoutMs: config.requestTimeoutMs,
          responseMaxBytes: config.catalogueResponseMaxBytes,
        });
    if (source === "provider" && request.options["--fixture-directory"] !== undefined) {
      throw new MarketplaceCatalogueError("MARKETPLACE_CATALOGUE_INPUT_INVALID");
    }
    const service = createMarketplaceCatalogueService({
      repository,
      evidenceStore: await createConfiguredQualificationEvidenceStore(config.storage),
      client,
      secretProvider: createLocalEnvironmentSecretProvider(config.nodeEnv),
      protector: createLocalProviderReferenceProtector(
        config.nodeEnv,
        config.providerReferenceLocalKey,
      ),
      evidenceMaxBytes: config.storage.maxBytes,
    });
    return await service.importCatalogue({
      source,
      ...(confirmedReadOnlyRequest === true
        ? { confirmedReadOnlyRequest: true as const }
        : {}),
      environment: config.providerEnvironment,
      actor: value(request.options, "--actor"),
      restrictedReference: value(request.options, "--evidence-reference"),
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
  runMarketplaceCatalogueCommand()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error: unknown) => {
      const logger = pino({ base: { service: "dhumi-marketplace-catalogue-operator" } });
      logger.error(safeErrorLogContext(error), "Marketplace catalogue command failed");
      process.exitCode = 1;
    });
}
