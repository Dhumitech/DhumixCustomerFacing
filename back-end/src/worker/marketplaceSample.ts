import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { loadMarketplaceSampleConfig } from "../config/marketplaceSampleEnvironment.js";
import { createLoggerOptions, safeErrorLogContext } from "../config/logger.js";
import { createOperatorPool } from "../services/database/pools.js";
import { verifyOperatorPool } from "../services/database/roleVerification.js";
import { requireMarketplaceContraction } from "../services/database/refactorSchemaGate.js";
import { createConfiguredMarketplaceSampleStore } from
  "../services/marketplaceSample/azuriteMarketplaceSampleStore.js";
import { createMarketplaceSampleRepository } from
  "../services/marketplaceSample/marketplaceSampleRepository.js";
import {
  MarketplaceSampleError,
  createMarketplaceSampleService,
} from "../services/marketplaceSample/marketplaceSampleService.js";

type Options = Readonly<Record<string, string>>;
type Action =
  | "ingest-fixture"
  | "inspect-fixture"
  | "expire-fixtures";

interface Command {
  readonly action: Action;
  readonly options: Options;
}

const ACTION_OPTIONS: Readonly<Record<Action, ReadonlySet<string>>> = Object.freeze({
  "ingest-fixture": new Set([
    "--sample-file",
    "--metadata-file",
    "--sample-version",
    "--schema-version",
    "--masking-policy-version",
    "--retention-policy-version",
    "--provenance-reference",
    "--collected-at",
    "--expires-at",
    "--actor",
  ]),
  "inspect-fixture": new Set([
    "--metadata-file",
    "--sample-version",
    "--as-of",
  ]),
  "expire-fixtures": new Set([
    "--as-of",
    "--limit",
    "--actor",
  ]),
});

export function parseMarketplaceSampleCommand(values: readonly string[]): Command {
  const [action, ...tokens] = values;
  if (
    !(
      action === "ingest-fixture" ||
      action === "inspect-fixture" ||
      action === "expire-fixtures"
    ) ||
    tokens.length % 2 !== 0
  ) {
    throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_INPUT_INVALID");
  }
  const options: Record<string, string> = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index];
    const value = tokens[index + 1];
    if (
      name === undefined ||
      value === undefined ||
      !name.startsWith("--") ||
      value.startsWith("--") ||
      name in options
    ) {
      throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_INPUT_INVALID");
    }
    options[name] = value;
  }
  const allowed = ACTION_OPTIONS[action];
  if (
    Object.keys(options).length !== allowed.size ||
    Object.keys(options).some((name) => !allowed.has(name))
  ) {
    throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_INPUT_INVALID");
  }
  return Object.freeze({ action, options: Object.freeze(options) });
}

function value(options: Options, name: string): string {
  const result = options[name];
  if (result === undefined) {
    throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_INPUT_INVALID");
  }
  return result;
}

function integer(options: Options, name: string): number {
  const result = Number(value(options, name));
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_INPUT_INVALID");
  }
  return result;
}

function date(options: Options, name: string): Date {
  const source = value(options, name);
  const result = new Date(source);
  if (Number.isNaN(result.valueOf()) || result.toISOString() !== source) {
    throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_INPUT_INVALID");
  }
  return result;
}

async function bytes(options: Options, name: string, maximum: number): Promise<Buffer> {
  const path = value(options, name);
  if (!isAbsolute(path)) {
    throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_INPUT_INVALID");
  }
  const result = await readFile(path);
  if (result.byteLength < 2 || result.byteLength > maximum) {
    throw new MarketplaceSampleError("MARKETPLACE_SAMPLE_INPUT_INVALID");
  }
  return result;
}

export async function runMarketplaceSampleCommand(
  values = process.argv.slice(2),
): Promise<unknown> {
  const { action, options } = parseMarketplaceSampleCommand(values);
  const config = loadMarketplaceSampleConfig();
  const logger = pino(createLoggerOptions(config, "dhumi-marketplace-sample-operator"));
  const pool = createOperatorPool(
    config.database,
    (error) => logger.error(
      safeErrorLogContext(error),
      "Unexpected Marketplace sample database error",
    ),
    "dhumi-marketplace-sample-operator",
  );
  try {
    await verifyOperatorPool(pool, config.database.credential.user);
    await requireMarketplaceContraction(pool,"dhumi_operator");
    const repository = createMarketplaceSampleRepository(pool);
    const sampleStore = await createConfiguredMarketplaceSampleStore(config.storage);
    const service = createMarketplaceSampleService({
      repository,
      store: sampleStore,
      maxBytes: config.storage.maxBytes,
    });
    if (action === "inspect-fixture") {
      return await service.inspectFixture({
        templateSlug: "linkedin-posts",
        templateVersion: 1,
        sampleVersion: integer(options, "--sample-version"),
        metadataBytes: await bytes(options, "--metadata-file", config.storage.maxBytes),
        asOf: date(options, "--as-of"),
      });
    }
    if (action === "expire-fixtures") {
      return await service.expireFixtures({
        asOf: date(options, "--as-of"),
        limit: integer(options, "--limit"),
        actor: value(options, "--actor"),
      });
    }
    return await service.ingestFixture({
      templateSlug: "linkedin-posts",
      templateVersion: 1,
      sampleVersion: integer(options, "--sample-version"),
      schemaVersion: integer(options, "--schema-version"),
      sampleBytes: await bytes(options, "--sample-file", config.storage.maxBytes),
      metadataBytes: await bytes(options, "--metadata-file", config.storage.maxBytes),
      maskingPolicyVersion: value(options, "--masking-policy-version"),
      retentionPolicyVersion: value(options, "--retention-policy-version"),
      provenanceEvidenceReference: value(options, "--provenance-reference"),
      collectedAt: date(options, "--collected-at"),
      expiresAt: date(options, "--expires-at"),
      actor: value(options, "--actor"),
    });
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  runMarketplaceSampleCommand()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error: unknown) => {
      const logger = pino({ base: { service: "dhumi-marketplace-sample-operator" } });
      logger.error(safeErrorLogContext(error), "Marketplace sample command failed");
      process.exitCode = 1;
    });
}
