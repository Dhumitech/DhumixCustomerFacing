import type { DatabaseExecutor } from "../../types/database.js";
import { createScraperProcessing, ScraperContractError } from "../scrapers/scraperProcessing.js";
import { SHARED_SCRAPER_ADAPTER_CODE, SHARED_SCRAPER_ADAPTER_VERSION, SHARED_SCRAPER_ARTIFACT_DIGEST } from "../scrapers/sharedScraperVersion.js";

// One bounded cache per API process, not per Tenant, scraper or request.
const processing = createScraperProcessing();
export async function validateSharedScraperAdmission(database: DatabaseExecutor, input: {
  readonly adapterCode: string | null;
  readonly adapterVersion: string | null;
  readonly templateVersionId: string;
  readonly mappingId: string;
  readonly value: Readonly<Record<string, unknown>>;
}) {
  // Published non-shared contracts keep their original validation behavior.
  if (input.adapterCode !== SHARED_SCRAPER_ADAPTER_CODE) return { valid: true, issues: [] };
  // A shared adapter never falls back to a legacy validator merely because a
  // newer/unknown version appears in the database.
  if (input.adapterVersion !== SHARED_SCRAPER_ADAPTER_VERSION) throw new ScraperContractError();
  let result;
  try { result = await database.query<{
    readonly adapter_code: string; readonly adapter_digest: string;
    readonly operation_code: string; readonly input_schema: unknown; readonly output_schema: unknown;
    readonly processing: unknown; readonly contract_hash: string;
  }>("SELECT * FROM app.resolve_shared_scraper_admission_contract($1,$2)", [input.templateVersionId, input.mappingId]); }
  catch (error) {
    // An unavailable/revoked pin or an unactivated reader is a release gate,
    // not permission to fall back to a less strict input path.
    if (error && typeof error === "object" && "code" in error &&
      ["P0002", "42883", "42501"].includes(String(error.code))) throw new ScraperContractError();
    throw error;
  }
  const row = result.rows[0];
  if (!row || row.adapter_code !== SHARED_SCRAPER_ADAPTER_CODE || row.adapter_digest !== SHARED_SCRAPER_ARTIFACT_DIGEST) throw new ScraperContractError();
  return processing.prepare({ operationCode: row.operation_code, inputSchema: row.input_schema,
    outputSchema: row.output_schema, processing: row.processing }, row.contract_hash).validateInput(input.value);
}
