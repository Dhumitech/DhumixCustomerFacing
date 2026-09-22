import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { loadQualificationOperatorConfig } from "../config/qualificationEnvironment.js";
import { createLoggerOptions, safeErrorLogContext } from "../config/logger.js";
import { createOperatorPool } from "../services/database/pools.js";
import { verifyOperatorPool } from "../services/database/roleVerification.js";
import { createMarketplaceQualificationPreflightRepository } from
  "../services/marketplaceQualification/marketplaceQualificationPreflightRepository.js";
import {
  MarketplaceQualificationPreflightError,
  createMarketplaceQualificationPreflightService,
} from "../services/marketplaceQualification/marketplaceQualificationPreflightService.js";

type Options = Readonly<Record<string, string | true>>;

function parse(values: readonly string[]): {
  readonly action: "prepare" | "authorize";
  readonly options: Options;
} {
  const [action, ...tokens] = values;
  const request = { action, options: {} as Record<string, string | true> };
  if (request.action !== "prepare" && request.action !== "authorize") {
    throw new MarketplaceQualificationPreflightError();
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const option = tokens[index] as string;
    if (!option.startsWith("--") || option.length < 4 || option in request.options) {
      throw new MarketplaceQualificationPreflightError();
    }
    const next = tokens[index + 1];
    if (next === undefined || next.startsWith("--")) {
      request.options[option] = true;
      continue;
    }
    request.options[option] = next;
    index += 1;
  }
  return { action: request.action, options: Object.freeze(request.options) };
}

function only(options: Options, names: readonly string[]): void {
  const allowed = new Set(names);
  if (Object.keys(options).some((name) => !allowed.has(name))) {
    throw new MarketplaceQualificationPreflightError();
  }
}

function value(options: Options, name: string): string {
  const result = options[name];
  if (typeof result !== "string") throw new MarketplaceQualificationPreflightError();
  return result;
}

function integer(options: Options, name: string): number {
  const raw = value(options, name);
  if (!/^[1-9][0-9]*$/.test(raw)) throw new MarketplaceQualificationPreflightError();
  const result = Number(raw);
  if (!Number.isSafeInteger(result)) throw new MarketplaceQualificationPreflightError();
  return result;
}

function exactInteger(options: Options, name: string, expected: number): number {
  const raw = value(options, name);
  if (raw !== String(expected)) {
    throw new MarketplaceQualificationPreflightError();
  }
  return expected;
}

function date(options: Options, name: string): Date {
  const result = new Date(value(options, name));
  if (Number.isNaN(result.getTime()) || result.toISOString() !== value(options, name)) {
    throw new MarketplaceQualificationPreflightError();
  }
  return result;
}

async function filterFromFile(path: string): Promise<unknown> {
  if (!isAbsolute(path)) throw new MarketplaceQualificationPreflightError();
  const bytes = await readFile(path);
  if (bytes.byteLength < 2 || bytes.byteLength > 65_536) {
    throw new MarketplaceQualificationPreflightError();
  }
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new MarketplaceQualificationPreflightError();
  }
}

export async function runMarketplaceQualificationPreflightCommand(
  values = process.argv.slice(2),
): Promise<unknown> {
  const request = parse(values);
  const config = loadQualificationOperatorConfig();
  const logger = pino(createLoggerOptions(config, "dhumi-marketplace-qualification-preflight"));
  const pool = createOperatorPool(
    config.database,
    (error) => logger.error(safeErrorLogContext(error), "Unexpected M9 preflight database error"),
    "dhumi-marketplace-qualification-preflight",
  );
  try {
    await verifyOperatorPool(pool, config.database.credential.user);
    const service = createMarketplaceQualificationPreflightService(
      createMarketplaceQualificationPreflightRepository(pool),
    );
    if (request.action === "prepare") {
      only(request.options, [
        "--packet-id", "--candidate-id", "--environment", "--filter-file",
        "--selected-fields", "--records-limit", "--maximum-estimated-cost-micros",
        "--currency", "--maximum-provider-submissions",
        "--automatic-submission-retries", "--poll-deadline-ms", "--actor",
      ]);
      const environment = value(request.options, "--environment");
      if (environment !== config.providerEnvironment) {
        throw new MarketplaceQualificationPreflightError();
      }
      const selectedFields = value(request.options, "--selected-fields").split(",");
      if (selectedFields.some((field) => field.length < 1 || field.trim() !== field)) {
        throw new MarketplaceQualificationPreflightError();
      }
      return await service.prepare({
        packetId: value(request.options, "--packet-id"),
        candidateId: value(request.options, "--candidate-id"),
        environment,
        filter: await filterFromFile(value(request.options, "--filter-file")),
        selectedFields,
        recordsLimit: integer(request.options, "--records-limit"),
        maximumEstimatedCostMicros: integer(
          request.options,
          "--maximum-estimated-cost-micros",
        ),
        currencyCode: value(request.options, "--currency") as "USD",
        maximumProviderSubmissions: exactInteger(
          request.options,
          "--maximum-provider-submissions",
          1,
        ) as 1,
        automaticSubmissionRetries: exactInteger(
          request.options,
          "--automatic-submission-retries",
          0,
        ) as 0,
        pollDeadlineMs: integer(request.options, "--poll-deadline-ms"),
        actor: value(request.options, "--actor"),
      });
    }

    only(request.options, [
      "--packet-id", "--request-fingerprint", "--records-limit",
      "--maximum-estimated-cost-micros", "--currency",
      "--maximum-provider-submissions", "--automatic-submission-retries",
      "--authorization-reference", "--authorization-hash", "--issuer",
      "--effective-at", "--expires-at", "--confirm-one-billable-submission",
    ]);
    if (request.options["--confirm-one-billable-submission"] !== true) {
      throw new MarketplaceQualificationPreflightError();
    }
    return await service.authorize({
      packetId: value(request.options, "--packet-id"),
      requestFingerprint: value(request.options, "--request-fingerprint"),
      recordsLimit: integer(request.options, "--records-limit"),
      maximumEstimatedCostMicros: integer(
        request.options,
        "--maximum-estimated-cost-micros",
      ),
      currencyCode: value(request.options, "--currency") as "USD",
      maximumProviderSubmissions: exactInteger(
        request.options,
        "--maximum-provider-submissions",
        1,
      ) as 1,
      automaticSubmissionRetries: exactInteger(
        request.options,
        "--automatic-submission-retries",
        0,
      ) as 0,
      authorizationReference: value(request.options, "--authorization-reference"),
      authorizationHash: value(request.options, "--authorization-hash"),
      issuer: value(request.options, "--issuer"),
      effectiveAt: date(request.options, "--effective-at"),
      expiresAt: date(request.options, "--expires-at"),
    });
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  runMarketplaceQualificationPreflightCommand()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error: unknown) => {
      const logger = pino({ base: { service: "dhumi-marketplace-qualification-preflight" } });
      logger.error(safeErrorLogContext(error), "Marketplace qualification preflight failed");
      process.exitCode = 1;
    });
}
