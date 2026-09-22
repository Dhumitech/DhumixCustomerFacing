import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createMarketplaceSampleDownloadRepository } from
  "../../src/services/marketplaceSampleDownload/marketplaceSampleDownloadRepository.js";
import { createMarketplaceSampleDownloadCleanupRepository } from
  "../../src/services/marketplaceSampleDownload/marketplaceSampleDownloadCleanupRepository.js";

function fakePool(row: unknown, commitError?: Error) {
  const query = vi.fn(async (sql: string) => {
    if (sql === "COMMIT" && commitError) throw commitError;
    if (sql.startsWith("SELECT set_config")) return { rows: [{ tenant_id: tenantId }] };
    return { rows: [row] };
  });
  const release = vi.fn();
  const pool = { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool;
  return { pool, query, release };
}
const tenantId = randomUUID();
const authorizationId = randomUUID();
const candidate = { tenantId, authorizationId, objectKey: "private-key" };

describe("sample-download cleanup database boundaries", () => {
  it.each([true, false])("returns only the committed tenant-scoped fail outcome %s", async (allowed) => {
    const { pool, query } = fakePool({ cleanup_allowed: allowed });
    expect(await createMarketplaceSampleDownloadRepository(pool).fail({ tenantId, authorizationId })).toBe(allowed);
    expect(query).toHaveBeenCalledWith("SET LOCAL ROLE dhumi_customer_api");
    expect(query).toHaveBeenCalledWith(
      "SELECT app.fail_marketplace_sample_download_for_cleanup($1) AS cleanup_allowed", [authorizationId],
    );
    expect(query).toHaveBeenLastCalledWith("COMMIT");
  });

  it("does not return a cleanup permission after an uncertain fail COMMIT", async () => {
    const { pool } = fakePool({ cleanup_allowed: true }, new Error("commit response lost"));
    await expect(createMarketplaceSampleDownloadRepository(pool).fail({ tenantId, authorizationId })).rejects.toThrow();
  });

  it("uses only the narrow operator claim function and commits before exposing a receipt", async () => {
    const { pool, query } = fakePool({ disposition: "eligible", stored_content_type: "application/json; charset=utf-8",
      stored_file_name: "linkedin-posts-sample-v3.json", stored_byte_count: "20", stored_checksum: Buffer.alloc(32, 1) });
    expect(await createMarketplaceSampleDownloadCleanupRepository(pool).claim(candidate)).toMatchObject({
      kind: "eligible", receipt: { objectKey: candidate.objectKey, byteCount: 20 },
    });
    expect(query).toHaveBeenCalledWith("SET LOCAL ROLE dhumi_operator");
    expect(query).toHaveBeenCalledWith("SELECT * FROM app.claim_marketplace_sample_download_cleanup($1, $2, $3)",
      [tenantId, authorizationId, candidate.objectKey]);
    expect(query).toHaveBeenLastCalledWith("COMMIT");
  });

  it("rejects a malformed cleanup receipt and any uncertain claim COMMIT", async () => {
    const malformed = fakePool({ disposition: "eligible", stored_byte_count: "0" });
    await expect(createMarketplaceSampleDownloadCleanupRepository(malformed.pool).claim(candidate)).rejects.toThrow();
    const uncertain = fakePool({ disposition: "protected" }, new Error("commit response lost"));
    await expect(createMarketplaceSampleDownloadCleanupRepository(uncertain.pool).claim(candidate)).rejects.toThrow();
  });
});
