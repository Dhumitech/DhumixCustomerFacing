import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { loadQualificationOperatorConfig } from "../config/qualificationEnvironment.js";
import { createLoggerOptions, safeErrorLogContext } from "../config/logger.js";
import { createLocalProviderReferenceProtector } from
  "../services/brightdata/providerReferenceProtector.js";
import { createOperatorPool } from "../services/database/pools.js";
import { verifyOperatorPool } from "../services/database/roleVerification.js";
import { createMarketplaceExportCandidateRepository } from
  "../services/marketplaceExportCandidate/marketplaceExportCandidateRepository.js";
import {
  createMarketplaceExportCandidateService,
  MarketplaceExportCandidateError,
} from "../services/marketplaceExportCandidate/marketplaceExportCandidateService.js";

type Options = Readonly<Record<string, string>>;

function parse(values: readonly string[]): Options {
  const [action, ...tokens] = values;
  if (action !== "register" || tokens.length !== 10) {
    throw new MarketplaceExportCandidateError("MARKETPLACE_EXPORT_CANDIDATE_INPUT_INVALID");
  }
  const options: Record<string, string> = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index];
    const value = tokens[index + 1];
    if (name === undefined || value === undefined || !name.startsWith("--") ||
        value.startsWith("--") || name in options) {
      throw new MarketplaceExportCandidateError("MARKETPLACE_EXPORT_CANDIDATE_INPUT_INVALID");
    }
    options[name] = value;
  }
  const allowed = new Set([
    "--packet-id", "--mapping-id", "--actor", "--evidence-reference", "--reason",
  ]);
  if (Object.keys(options).some((name) => !allowed.has(name)) ||
      Object.keys(options).length !== allowed.size) {
    throw new MarketplaceExportCandidateError("MARKETPLACE_EXPORT_CANDIDATE_INPUT_INVALID");
  }
  return Object.freeze(options);
}

function value(options: Options, name: string): string {
  const result = options[name];
  if (result === undefined) {
    throw new MarketplaceExportCandidateError("MARKETPLACE_EXPORT_CANDIDATE_INPUT_INVALID");
  }
  return result;
}

export async function runMarketplaceExportCandidateCommand(
  values = process.argv.slice(2),
): Promise<unknown> {
  if (process.env.RUN_EXECUTOR_DRIVER !== "controlled") {
    throw new MarketplaceExportCandidateError("MARKETPLACE_EXPORT_CANDIDATE_INPUT_INVALID");
  }
  const options = parse(values);
  const config = loadQualificationOperatorConfig();
  const logger = pino(createLoggerOptions(config, "dhumi-marketplace-export-candidate"));
  const pool = createOperatorPool(
    config.database,
    (error) => logger.error(safeErrorLogContext(error), "Unexpected M10 database error"),
    "dhumi-marketplace-export-candidate",
  );
  try {
    await verifyOperatorPool(pool, config.database.credential.user);
    const service = createMarketplaceExportCandidateService({
      repository: createMarketplaceExportCandidateRepository(pool),
      protector: createLocalProviderReferenceProtector(
        config.nodeEnv,
        config.providerReferenceLocalKey,
      ),
      expectedEnvironment: config.providerEnvironment,
    });
    return await service.register({
      packetId: value(options, "--packet-id"),
      mappingId: value(options, "--mapping-id"),
      actor: value(options, "--actor"),
      evidenceReference: value(options, "--evidence-reference"),
      reason: value(options, "--reason"),
    });
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  runMarketplaceExportCandidateCommand()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error: unknown) => {
      const logger = pino({ base: { service: "dhumi-marketplace-export-candidate" } });
      logger.error(safeErrorLogContext(error), "Marketplace export candidate command failed");
      process.exitCode = 1;
    });
}
