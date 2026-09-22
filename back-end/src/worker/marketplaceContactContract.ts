import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { loadQualificationOperatorConfig } from "../config/qualificationEnvironment.js";
import { createLoggerOptions, safeErrorLogContext } from "../config/logger.js";
import { createLocalProviderReferenceProtector } from
  "../services/brightdata/providerReferenceProtector.js";
import { createOperatorPool } from "../services/database/pools.js";
import { verifyOperatorPool } from "../services/database/roleVerification.js";
import { createMarketplaceContactContractRepository } from
  "../services/marketplacePeople/marketplaceContactContractRepository.js";
import {
  MarketplaceContactContractError,
  createMarketplaceContactContractService,
} from "../services/marketplacePeople/marketplaceContactContractService.js";
import { createConfiguredQualificationEvidenceStore } from
  "../services/qualification/qualificationEvidenceStore.js";

type Options = Readonly<Record<string, string | true>>;

function parse(values: readonly string[]): Options {
  const options: Record<string, string | true> = {};
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index] as string;
    if (!option.startsWith("--") || option in options) {
      throw new MarketplaceContactContractError(
        "MARKETPLACE_CONTACT_CONTRACT_INPUT_INVALID",
      );
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
    "--faq-file",
    "--search-file",
    "--actor",
    "--evidence-reference",
    "--confirm-offline-evidence",
  ]);
  if (Object.keys(options).some((name) => !allowed.has(name))) {
    throw new MarketplaceContactContractError(
      "MARKETPLACE_CONTACT_CONTRACT_INPUT_INVALID",
    );
  }
  return Object.freeze(options);
}

function value(options: Options, name: string): string {
  const result = options[name];
  if (typeof result !== "string") {
    throw new MarketplaceContactContractError(
      "MARKETPLACE_CONTACT_CONTRACT_INPUT_INVALID",
    );
  }
  return result;
}

async function evidenceFile(path: string, maximumBytes: number): Promise<Buffer> {
  if (!isAbsolute(path)) {
    throw new MarketplaceContactContractError(
      "MARKETPLACE_CONTACT_CONTRACT_INPUT_INVALID",
    );
  }
  const bytes = await readFile(path);
  if (bytes.byteLength < 2 || bytes.byteLength > maximumBytes) {
    throw new MarketplaceContactContractError(
      "MARKETPLACE_CONTACT_CONTRACT_EVIDENCE_INVALID",
    );
  }
  return bytes;
}

export async function runMarketplaceContactContractCommand(
  values = process.argv.slice(2),
): Promise<unknown> {
  const options = parse(values);
  if (options["--confirm-offline-evidence"] !== true) {
    throw new MarketplaceContactContractError(
      "MARKETPLACE_CONTACT_CONTRACT_CONFIRMATION_REQUIRED",
    );
  }
  const config = loadQualificationOperatorConfig();
  const logger = pino(createLoggerOptions(
    config,
    "dhumi-marketplace-contact-contract-operator",
  ));
  const pool = createOperatorPool(
    config.database,
    (error) => logger.error(
      safeErrorLogContext(error),
      "Unexpected Marketplace contact-contract database error",
    ),
    "dhumi-marketplace-contact-contract-operator",
  );
  try {
    await verifyOperatorPool(pool, config.database.credential.user);
    const [faqBytes, searchBytes] = await Promise.all([
      evidenceFile(value(options, "--faq-file"), config.storage.maxBytes),
      evidenceFile(value(options, "--search-file"), config.storage.maxBytes),
    ]);
    const service = createMarketplaceContactContractService({
      repository: createMarketplaceContactContractRepository(pool),
      evidenceStore: await createConfiguredQualificationEvidenceStore(config.storage),
      protector: createLocalProviderReferenceProtector(
        config.nodeEnv,
        config.providerReferenceLocalKey,
      ),
      evidenceMaxBytes: config.storage.maxBytes,
    });
    return await service.register({
      standardPeopleCandidateId: value(options, "--candidate-id"),
      actor: value(options, "--actor"),
      restrictedReference: value(options, "--evidence-reference"),
      faq: {
        sourceUri: "https://docs.brightdata.com/products/marketplace/faqs",
        bytes: faqBytes,
      },
      search: {
        sourceUri:
          "https://docs.brightdata.com/api-reference/marketplace-dataset-api/search-dataset",
        bytes: searchBytes,
      },
      confirmedOfflineEvidence: true,
    });
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  runMarketplaceContactContractCommand()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error: unknown) => {
      const logger = pino({
        base: { service: "dhumi-marketplace-contact-contract-operator" },
      });
      logger.error(safeErrorLogContext(error), "Marketplace contact-contract command failed");
      process.exitCode = 1;
    });
}
