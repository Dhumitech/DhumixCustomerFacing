import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { loadQualificationOperatorConfig } from "../config/qualificationEnvironment.js";
import { createLoggerOptions, safeErrorLogContext } from "../config/logger.js";
import { createOperatorPool } from "../services/database/pools.js";
import { verifyOperatorPool } from "../services/database/roleVerification.js";
import { createConfiguredMarketplaceSampleStore } from
  "../services/marketplaceSample/azuriteMarketplaceSampleStore.js";
import { createMarketplacePeopleSampleRepository } from
  "../services/marketplacePeople/marketplacePeopleSampleRepository.js";
import {
  MarketplacePeopleSampleError,
  createMarketplacePeopleSampleService,
} from "../services/marketplacePeople/marketplacePeopleSampleService.js";
import { createConfiguredQualificationEvidenceReader } from
  "../services/qualification/qualificationEvidenceReader.js";

type Options = Readonly<Record<string, string>>;

function parse(values: readonly string[]): Options {
  if (values.length % 2 !== 0) {
    throw new MarketplacePeopleSampleError("MARKETPLACE_PEOPLE_SAMPLE_INPUT_INVALID");
  }
  const options: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (
      name === undefined || value === undefined || !name.startsWith("--") ||
      value.startsWith("--") || name in options
    ) {
      throw new MarketplacePeopleSampleError("MARKETPLACE_PEOPLE_SAMPLE_INPUT_INVALID");
    }
    options[name] = value;
  }
  const allowed = new Set(["--sample-file", "--sample-version", "--actor"]);
  if (Object.keys(options).length !== allowed.size ||
      Object.keys(options).some((name) => !allowed.has(name))) {
    throw new MarketplacePeopleSampleError("MARKETPLACE_PEOPLE_SAMPLE_INPUT_INVALID");
  }
  return Object.freeze(options);
}

function value(options: Options, name: string): string {
  const result = options[name];
  if (result === undefined) {
    throw new MarketplacePeopleSampleError("MARKETPLACE_PEOPLE_SAMPLE_INPUT_INVALID");
  }
  return result;
}

export async function runMarketplacePeopleSampleCommand(
  values = process.argv.slice(2),
): Promise<unknown> {
  const options = parse(values);
  const sampleVersion = Number(value(options, "--sample-version"));
  const sampleFile = value(options, "--sample-file");
  if (sampleVersion !== 1 || !isAbsolute(sampleFile)) {
    throw new MarketplacePeopleSampleError("MARKETPLACE_PEOPLE_SAMPLE_INPUT_INVALID");
  }
  const config = loadQualificationOperatorConfig();
  const logger = pino(createLoggerOptions(config, "dhumi-marketplace-people-sample-operator"));
  const pool = createOperatorPool(
    config.database,
    (error) => logger.error(
      safeErrorLogContext(error),
      "Unexpected LinkedIn People sample database error",
    ),
    "dhumi-marketplace-people-sample-operator",
  );
  try {
    const sampleBytes = await readFile(sampleFile);
    if (sampleBytes.byteLength < 2 || sampleBytes.byteLength > config.storage.maxBytes) {
      throw new MarketplacePeopleSampleError("MARKETPLACE_PEOPLE_SAMPLE_INPUT_INVALID");
    }
    await verifyOperatorPool(pool, config.database.credential.user);
    const service = createMarketplacePeopleSampleService({
      repository: createMarketplacePeopleSampleRepository(pool),
      evidenceReader: await createConfiguredQualificationEvidenceReader(config.storage),
      sampleStore: await createConfiguredMarketplaceSampleStore(config.storage),
      maxBytes: config.storage.maxBytes,
    });
    return await service.ingest({
      sampleBytes,
      sampleVersion: 1,
      actor: value(options, "--actor"),
    });
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  runMarketplacePeopleSampleCommand()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error: unknown) => {
      const logger = pino({ base: { service: "dhumi-marketplace-people-sample-operator" } });
      logger.error(safeErrorLogContext(error), "LinkedIn People sample command failed");
      process.exitCode = 1;
    });
}
