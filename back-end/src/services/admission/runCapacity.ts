import type { DatabaseExecutor } from "../../types/database.js";
import type { ProviderEnvironment } from "../customerServices/createServiceRepository.js";
import { ScraperContractError } from "../scrapers/scraperProcessing.js";
import { SHARED_SCRAPER_ADAPTER_CODE, SHARED_SCRAPER_ADAPTER_VERSION } from "../scrapers/sharedScraperVersion.js";

export interface RunCapacityRow {
  readonly estimated_amount_micros: string | number;
  readonly currency_code: string;
  readonly unit: string;
  readonly evidence_reference: string;
}

/** One admission seam. Shared scrapers require a separately approved, bounded
 * commercial policy; legacy Runs retain their existing local/test profile. */
export async function selectRunCapacity(database: DatabaseExecutor, input: {
  readonly adapterCode: string | null;
  readonly adapterVersion: string | null;
  readonly providerEnvironment: ProviderEnvironment;
  readonly templateVersionId: string;
  readonly mappingId: string;
  readonly validatedInput: Readonly<Record<string, unknown>>;
}): Promise<RunCapacityRow | undefined> {
  if (input.adapterCode !== SHARED_SCRAPER_ADAPTER_CODE) {
    const result = await database.query<RunCapacityRow>(
      "SELECT estimated_amount_micros, currency_code, unit, evidence_reference FROM app.require_phase5_mock_run_capacity($1)",
      [input.providerEnvironment],
    );
    return result.rows[0];
  }
  if (input.adapterVersion !== SHARED_SCRAPER_ADAPTER_VERSION) throw new ScraperContractError();
  const targets = input.validatedInput.targets;
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 20) throw new ScraperContractError();
  const result = await database.query<RunCapacityRow>(
    `SELECT estimated_amount_micros, currency_code, unit, evidence_reference
     FROM app.require_shared_scraper_run_capacity($1,$2,$3,$4)`,
    [input.providerEnvironment, input.templateVersionId, input.mappingId, targets.length],
  );
  return result.rows[0];
}
