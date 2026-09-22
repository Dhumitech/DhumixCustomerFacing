import type { MarketplaceSampleDownloadCleanupRepository } from
  "./marketplaceSampleDownloadCleanupRepository.js";
import type { MarketplaceSampleDownloadCleanupStore } from "./marketplaceSampleDownloadStore.js";

export interface MarketplaceSampleDownloadCleanupSummary {
  readonly pages: number;
  readonly examined: number;
  readonly deleted: number;
  readonly absent: number;
  readonly protected: number;
  readonly untracked: number;
  readonly ignored: number;
  readonly failures: number;
  readonly complete: boolean;
}

/** A bounded, repeatable storage-only job. Never terminally mark an object as
 * cleaned: the next inventory also finds delayed uploads after crash recovery. */
export async function cleanupMarketplaceSampleDownloads(input: {
  readonly repository: MarketplaceSampleDownloadCleanupRepository;
  readonly store: MarketplaceSampleDownloadCleanupStore;
  readonly pageSize: number;
  readonly maxPages: number;
}): Promise<MarketplaceSampleDownloadCleanupSummary> {
  if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 1000 ||
      !Number.isSafeInteger(input.maxPages) || input.maxPages < 1 || input.maxPages > 10000) {
    throw new TypeError("Sample-download cleanup bounds are invalid");
  }
  const counts = { pages: 0, examined: 0, deleted: 0, absent: 0, protected: 0,
    untracked: 0, ignored: 0, failures: 0 };
  let cursor: string | undefined;
  do {
    const page = await input.store.listCleanupPage({ limit: input.pageSize, ...(cursor ? { cursor } : {}) });
    counts.pages += 1;
    counts.ignored += page.ignored;
    for (const candidate of page.candidates) {
      counts.examined += 1;
      try {
        // A claim is returned only after COMMIT. If COMMIT is uncertain, never
        // delete on an unconfirmed result; a later inventory retries safely.
        const claim = await input.repository.claim(candidate);
        if (claim.kind !== "eligible") {
          counts[claim.kind] += 1;
          continue;
        }
        const result = await input.store.deleteIfMatching({
          receipt: claim.receipt,
          tenantId: candidate.tenantId,
          authorizationId: candidate.authorizationId,
        });
        counts[result] += 1;
      } catch {
        counts.failures += 1;
      }
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined && counts.pages < input.maxPages);
  // No private object key, cursor, SAS URL, or sample value in the report.
  return { ...counts, complete: cursor === undefined };
}
