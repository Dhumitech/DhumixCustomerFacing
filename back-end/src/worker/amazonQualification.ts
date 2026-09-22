import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { loadQualificationOperatorConfig } from "../config/qualificationEnvironment.js";
import { createLoggerOptions, safeErrorLogContext } from "../config/logger.js";
import { createBrightDataIntegrationClient } from "../services/brightdata/brightDataIntegrationClient.js";
import type { BrightDataExecutionMode } from "../services/brightdata/brightDataIntegrationClient.js";
import { createLocalProviderReferenceProtector } from "../services/brightdata/providerReferenceProtector.js";
import { createOperatorPool } from "../services/database/pools.js";
import { verifyOperatorPool } from "../services/database/roleVerification.js";
import { createLocalEnvironmentSecretProvider } from "../services/secrets/localEnvironmentSecretProvider.js";
import { createAmazonQualificationRepository } from "../services/qualification/amazonQualificationRepository.js";
import {
  AmazonQualificationError,
  createAmazonQualificationService,
} from "../services/qualification/amazonQualificationService.js";
import { createConfiguredQualificationEvidenceStore } from "../services/qualification/qualificationEvidenceStore.js";
import { createQualificationProviderRequestBudgetClient } from
  "../services/qualification/providerRequestBudgetClient.js";

type Options = Readonly<Record<string, string | true>>;

function parseOptions(values: readonly string[]): { readonly action: string; readonly options: Options } {
  const [action, ...tokens] = values;
  if (action === undefined || !["discover", "review", "qualify", "accept", "reject"].includes(action)) {
    throw new AmazonQualificationError("QUALIFICATION_ACTION_INVALID");
  }
  const options: Record<string, string | true> = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (!token.startsWith("--") || token.length < 4 || token in options) {
      throw new AmazonQualificationError("QUALIFICATION_ARGUMENT_INVALID");
    }
    const next = tokens[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options[token] = true;
      continue;
    }
    options[token] = next;
    index += 1;
  }
  return { action, options: Object.freeze(options) };
}

function only(options: Options, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  for (const option of Object.keys(options)) {
    if (!accepted.has(option)) throw new AmazonQualificationError("QUALIFICATION_ARGUMENT_INVALID");
  }
}

function value(options: Options, name: string): string {
  const resolvedValue = options[name];
  if (typeof resolvedValue !== "string") {
    throw new AmazonQualificationError("QUALIFICATION_ARGUMENT_REQUIRED");
  }
  return resolvedValue;
}

function flag(options: Options, name: string): true {
  if (options[name] !== true) throw new AmazonQualificationError("QUALIFICATION_CONFIRMATION_REQUIRED");
  return true;
}

function executionMode(options: Options): BrightDataExecutionMode {
  const mode = value(options, "--execution-mode");
  if (mode !== "scrape" && mode !== "trigger") {
    throw new AmazonQualificationError("QUALIFICATION_ARGUMENT_INVALID");
  }
  return mode;
}

function optionalPositiveInteger(options: Options, name: string): number | undefined {
  const raw = options[name];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw)) {
    throw new AmazonQualificationError("QUALIFICATION_ARGUMENT_INVALID");
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new AmazonQualificationError("QUALIFICATION_ARGUMENT_INVALID");
  }
  return parsed;
}

async function inputDocument(path: string, maxBytes: number): Promise<Readonly<Record<string, unknown>>> {
  if (!isAbsolute(path)) throw new AmazonQualificationError("QUALIFICATION_INPUT_PATH_NOT_ABSOLUTE");
  const bytes = await readFile(path);
  if (bytes.byteLength < 2 || bytes.byteLength > maxBytes) {
    throw new AmazonQualificationError("QUALIFICATION_INPUT_FILE_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new AmazonQualificationError("QUALIFICATION_INPUT_FILE_INVALID", "failed", error);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AmazonQualificationError("QUALIFICATION_INPUT_FILE_INVALID");
  }
  return parsed as Readonly<Record<string, unknown>>;
}

export async function runAmazonQualificationCommand(
  values = process.argv.slice(2),
): Promise<unknown> {
  const request = parseOptions(values);
  const config = loadQualificationOperatorConfig();
  const logger = pino(createLoggerOptions(config, "dhumi-amazon-qualification-operator"));
  const pool = createOperatorPool(config.database, (error) => {
    logger.error(safeErrorLogContext(error), "Unexpected qualification operator database error");
  });
  const abort = new AbortController();
  const stop = (): void => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await verifyOperatorPool(pool, config.database.credential.user);
    const providerClient = createBrightDataIntegrationClient({
      requestTimeoutMs: config.requestTimeoutMs,
      controlResponseMaxBytes: config.controlResponseMaxBytes,
      catalogueResponseMaxBytes: config.catalogueResponseMaxBytes,
      resultMaxBytes: config.storage.maxBytes,
    });
    const maximumProviderRequests = request.action === "qualify"
      ? optionalPositiveInteger(request.options, "--max-provider-requests")
      : undefined;
    const service = createAmazonQualificationService({
      repository: createAmazonQualificationRepository(pool),
      evidenceStore: await createConfiguredQualificationEvidenceStore(config.storage),
      client: maximumProviderRequests === undefined
        ? providerClient
        : createQualificationProviderRequestBudgetClient(
            providerClient,
            maximumProviderRequests,
          ),
      secretProvider: createLocalEnvironmentSecretProvider(config.nodeEnv),
      protector: createLocalProviderReferenceProtector(
        config.nodeEnv,
        config.providerReferenceLocalKey,
      ),
      evidenceMaxBytes: config.storage.maxBytes,
      pollIntervalMs: config.pollIntervalMs,
      pollMaxElapsedMs: config.pollMaxElapsedMs,
    });

    switch (request.action) {
      case "discover":
        only(request.options, ["--confirm-live", "--actor", "--evidence-reference"]);
        return await service.discover({
          confirmedLiveRequest: flag(request.options, "--confirm-live"),
          environment: config.providerEnvironment,
          actor: value(request.options, "--actor"),
          restrictedReference: value(request.options, "--evidence-reference"),
          signal: abort.signal,
        });
      case "review": {
        only(request.options, ["--candidate-id", "--decision", "--actor"]);
        const decision = value(request.options, "--decision");
        if (decision !== "approve" && decision !== "reject") {
          throw new AmazonQualificationError("QUALIFICATION_ARGUMENT_INVALID");
        }
        await service.reviewCandidate({
          candidateId: value(request.options, "--candidate-id"),
          decision,
          actor: value(request.options, "--actor"),
        });
        return { candidateId: value(request.options, "--candidate-id"), decision };
      }
      case "qualify":
        only(request.options, [
          "--confirm-billable",
          "--candidate-id",
          "--operation-code",
          "--execution-mode",
          "--input-file",
          "--actor",
          "--max-provider-requests",
        ]);
        return await service.qualify({
          confirmedBillableRequest: flag(request.options, "--confirm-billable"),
          environment: config.providerEnvironment,
          candidateId: value(request.options, "--candidate-id"),
          operationCode: value(request.options, "--operation-code"),
          executionMode: executionMode(request.options),
          validatedInput: await inputDocument(
            value(request.options, "--input-file"),
            config.storage.maxBytes,
          ),
          actor: value(request.options, "--actor"),
          signal: abort.signal,
        });
      case "accept": {
        only(request.options, [
          "--qualification-id",
          "--commercial-config-version",
          "--config-version",
          "--evidence-reference",
          "--evidence-hash",
          "--reviewer",
          "--expires-at",
        ]);
        const expires = request.options["--expires-at"];
        const expiresAt = typeof expires === "string" ? new Date(expires) : null;
        if (expiresAt !== null && Number.isNaN(expiresAt.valueOf())) {
          throw new AmazonQualificationError("QUALIFICATION_ARGUMENT_INVALID");
        }
        return await service.accept({
          qualificationId: value(request.options, "--qualification-id"),
          commercialConfigVersion: value(request.options, "--commercial-config-version"),
          configVersion: value(request.options, "--config-version"),
          restrictedReference: value(request.options, "--evidence-reference"),
          evidenceHashHex: value(request.options, "--evidence-hash"),
          reviewer: value(request.options, "--reviewer"),
          expiresAt,
        });
      }
      case "reject":
        only(request.options, ["--qualification-id", "--reason", "--reviewer"]);
        await service.reject({
          qualificationId: value(request.options, "--qualification-id"),
          reason: value(request.options, "--reason"),
          reviewer: value(request.options, "--reviewer"),
        });
        return { qualificationId: value(request.options, "--qualification-id"), reviewState: "rejected" };
    }
    throw new AmazonQualificationError("QUALIFICATION_ACTION_INVALID");
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await pool.end();
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  runAmazonQualificationCommand()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error: unknown) => {
      const logger = pino({ base: { service: "dhumi-amazon-qualification-operator" } });
      logger.error(safeErrorLogContext(error), "Amazon qualification command failed");
      process.exitCode = 1;
    });
}
