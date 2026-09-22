import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { loadOperationReleaseConfig } from "../config/releaseEnvironment.js";
import { createLoggerOptions, safeErrorLogContext } from "../config/logger.js";
import { createOperatorPool } from "../services/database/pools.js";
import { verifyOperatorPool } from "../services/database/roleVerification.js";
import { createAmazonOperationReleaseRepository } from "../services/release/amazonOperationReleaseRepository.js";
import { createAmazonOperationReleaseService } from "../services/release/amazonOperationReleaseService.js";

const CONFIRMATION = "I_UNDERSTAND_THIS_PUBLISHES_ONE_CUSTOMER_OPERATION";
type ReleaseAction = "publish" | "upgrade-input-v4";

function parseOptions(values: readonly string[]): Readonly<{
  action: ReleaseAction;
  options: Readonly<Record<string, string | true>>;
}> {
  const [action, ...tokens] = values;
  if (action !== "publish" && action !== "upgrade-input-v4") {
    throw new Error(
      "Usage: operator:amazon-release -- <publish|upgrade-input-v4> [approved options]",
    );
  }
  const options: Record<string, string | true> = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const option = tokens[index];
    if (option === undefined || !option.startsWith("--") || option in options) {
      throw new Error("AMAZON_RELEASE_ARGUMENT_INVALID");
    }
    if (option === "--confirm-publish") {
      options[option] = true;
      continue;
    }
    const optionValue = tokens[index + 1];
    if (optionValue === undefined || optionValue.startsWith("--")) {
      throw new Error("AMAZON_RELEASE_ARGUMENT_INVALID");
    }
    options[option] = optionValue;
    index += 1;
  }
  const shared = [
    "--confirm-publish",
    "--evidence-reference",
    "--evidence-hash",
    "--reviewer",
    "--reason",
    "--expires-at",
  ];
  const allowed = new Set(
    action === "publish" ? [...shared, "--qualification-id"] : shared,
  );
  if (Object.keys(options).some((option) => !allowed.has(option))) {
    throw new Error("AMAZON_RELEASE_ARGUMENT_INVALID");
  }
  return { action, options };
}

function required(options: Readonly<Record<string, string | true>>, name: string): string {
  const value = options[name];
  if (typeof value !== "string") throw new Error("AMAZON_RELEASE_ARGUMENT_INVALID");
  return value;
}

export async function publishAmazonOperation(values = process.argv.slice(2)): Promise<void> {
  const { action, options } = parseOptions(values);
  const config = loadOperationReleaseConfig();
  const logger = pino(createLoggerOptions(config, "dhumi-amazon-release-operator"));
  const pool = createOperatorPool(
    config.database,
    (error) => logger.error(safeErrorLogContext(error), "Unexpected release database client error"),
    "dhumi-amazon-release-operator",
  );
  try {
    await verifyOperatorPool(pool, config.database.credential.user);
    const expiryValue = options["--expires-at"];
    const expiresAt = typeof expiryValue === "string" ? new Date(expiryValue) : null;
    if (expiresAt !== null && Number.isNaN(expiresAt.valueOf())) {
      throw new Error("AMAZON_RELEASE_ARGUMENT_INVALID");
    }
    const confirmation = process.env.AMAZON_RELEASE_CONFIRMATION;
    const service = createAmazonOperationReleaseService({
      repository: createAmazonOperationReleaseRepository(pool),
    });
    const sharedInput = {
      confirmedPublication:
        options["--confirm-publish"] === true && confirmation === CONFIRMATION,
      expectedEnvironment: config.providerEnvironment,
      restrictedReference: required(options, "--evidence-reference"),
      evidenceHashHex: required(options, "--evidence-hash"),
      reviewer: required(options, "--reviewer"),
      reason: required(options, "--reason"),
      expiresAt,
    } as const;
    const result = action === "publish"
      ? await service.publish({
          ...sharedInput,
          qualificationId: required(options, "--qualification-id"),
        })
      : await service.upgradeProductsInputContract(sharedInput);
    logger.info(
      { ...result, action },
      "Amazon operation release completed",
    );
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  publishAmazonOperation().catch((error: unknown) => {
    const logger = pino({ base: { service: "dhumi-amazon-release-operator" } });
    logger.error(safeErrorLogContext(error), "Qualified Amazon operation release failed");
    process.exitCode = 1;
  });
}
