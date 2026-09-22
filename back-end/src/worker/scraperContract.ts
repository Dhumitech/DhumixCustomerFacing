import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { canonicalJson } from "../helpers/canonicalJson.js";
import { createScraperProcessing, ScraperContractError } from "../services/scrapers/scraperProcessing.js";
import { SHARED_SCRAPER_ADAPTER_CODE, SHARED_SCRAPER_ADAPTER_VERSION, SHARED_SCRAPER_ARTIFACT_DIGEST } from "../services/scrapers/sharedScraperVersion.js";

export class ScraperPackageCommandError extends Error {
  public constructor(message: string) { super(message); this.name = "ScraperPackageCommandError"; }
}

/** Offline-only. No environment loader, database, vault or provider client is imported. */
export async function validateScraperContractFile(packagePath: string) {
  const path = resolve(packagePath);
  let info;
  try { info = await stat(path); }
  catch { throw new ScraperPackageCommandError("Package file was not found. Pass an existing reviewed scraper-operation JSON package."); }
  if (!info.isFile() || info.size < 1 || info.size > 1_048_576) throw new ScraperContractError();
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text) > 1_048_576) throw new ScraperContractError();
  let packet: unknown;
  try { packet = JSON.parse(text); }
  catch { throw new ScraperPackageCommandError("Package file is not valid JSON."); }
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) throw new ScraperContractError();
  const value = packet as Record<string, unknown>;
  if (!value.input || typeof value.input !== "object" || Array.isArray(value.input) || !Array.isArray(value.records) ||
    !Array.isArray(value.expectedTargets) || !Array.isArray(value.expectedNormalized)) throw new ScraperContractError();
  const processing = createScraperProcessing();
  const processor = processing.prepare(value.contract);
  const targets = processor.serialize(value.input as Record<string, unknown>);
  if (canonicalJson(targets) !== canonicalJson(value.expectedTargets)) throw new ScraperContractError();
  const bytes = Buffer.from(JSON.stringify(value.records));
  const normalized = await processor.normalize({ bytes: Readable.from([bytes]), byteCount: bytes.length,
    maxBytes: 1_048_576, contentType: "application/json", contentEncoding: null });
  if (canonicalJson(JSON.parse(normalized.bytes.toString("utf8"))) !== canonicalJson(value.expectedNormalized)) throw new ScraperContractError();
  const report = {
    operationCode: processor.contract.operationCode, contractHash: processor.hash,
    adapter: { code: SHARED_SCRAPER_ADAPTER_CODE, version: SHARED_SCRAPER_ADAPTER_VERSION, digest: SHARED_SCRAPER_ARTIFACT_DIGEST },
    disposition: "offline_characterization_passed_not_publication",
    inputCount: targets.length, recordCount: normalized.recordCount,
    normalizedByteCount: normalized.bytes.length, compiledValidators: processing.stats().compilations,
    outputPolicy: { scraper_processing: processor.contract.processing, scraper_contract_sha256: processor.hash },
    providerCalls: 0, databaseWrites: 0, customerPublication: false,
    requiredReleaseEvidence: ["exact_provider_input_contract", "approved_output_contract", "request_and_error_fixtures",
      "continuation_capabilities", "account_and_commercial_approval", "protected_mapping", "independent_qualification"],
  };
  return { packet: value, report, packageSha256: createHash("sha256").update(text).digest("hex") };
}

export async function runScraperContractCommand(args: readonly string[]) {
  if (args.length !== 3 || args[0] !== "validate" || args[1] !== "--package" || !args[2]) {
    throw new Error("Usage: operator:scraper-contract -- validate --package <existing-operation-package.json>");
  }
  return (await validateScraperContractFile(args[2])).report;
}
const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  runScraperContractCommand(process.argv.slice(2)).then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }).catch((error: unknown) => {
    // Never echo arbitrary package contents, raw error records or private IDs.
    const message = error instanceof ScraperPackageCommandError ? error.message :
      "Offline scraper contract validation failed. Check the package/usage.";
    process.stderr.write(`${message} Provider calls: 0.\n`);
    process.exitCode = 1;
  });
}
