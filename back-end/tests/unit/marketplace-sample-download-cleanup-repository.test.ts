import { customerContextFixture } from "../helpers/customerContextFixture.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createMarketplaceSampleDownloadRepository } from "../../src/services/marketplaceSampleDownload/marketplaceSampleDownloadRepository.js";
import { createMarketplaceSampleDownloadCleanupRepository } from "../../src/services/marketplaceSampleDownload/marketplaceSampleDownloadCleanupRepository.js";

function fakePool(row: unknown, commitError?: Error) {
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    const context = customerContextFixture(sql, values);
    if (context !== undefined) return context;
    if (sql === "COMMIT" && commitError) throw commitError;
    if (sql.startsWith("SELECT set_config")) return { rows: [{ organization_id: tenantId }] };
    return { rows: [row] };
  });
  const release = vi.fn();
  const pool = { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool;
  return { pool, query, release };
}
const userId = randomUUID();
const tenantId = randomUUID();
const authorizationId = randomUUID();
const candidate = { tenantId, authorizationId, objectKey: `marketplace/sample-downloads/${tenantId}/${authorizationId}/${Buffer.alloc(32,1).toString('hex')}.json` };
const stored = {state:'failed',object_key:candidate.objectKey,format:'json',content_type:'application/json; charset=utf-8',file_name:'linkedin-posts-sample-v3.json',byte_count:'20',checksum:Buffer.alloc(32,1),now:new Date(),created_at:new Date(),download_expires_at:null};

describe("sample-download cleanup database boundaries", () => {
  it.each([true, false])(
    "returns only the committed tenant-scoped fail outcome %s",
    async (allowed) => {
      const { pool, query } = fakePool({ state: allowed ? 'failed' : 'authorized' });
      expect(
        await createMarketplaceSampleDownloadRepository(pool).fail({
          tenantId,
          userId,
          authorizationId,
        }),
      ).toBe(allowed);
      expect(query).toHaveBeenCalledWith("SET LOCAL ROLE dhumi_customer_api");
      expect(query).toHaveBeenCalledWith(
        "SELECT state FROM app.marketplace_sample_downloads WHERE organization_id=$1 AND id=$2 FOR UPDATE",
        [tenantId,authorizationId],
      );
      expect(query).toHaveBeenLastCalledWith("COMMIT");
    },
  );

  it("does not return a cleanup permission after an uncertain fail COMMIT", async () => {
    const { pool } = fakePool({ state:'failed' }, new Error("commit response lost"));
    await expect(
      createMarketplaceSampleDownloadRepository(pool).fail({ tenantId, userId, authorizationId }),
    ).rejects.toThrow();
  });

  it("locks the scoped reservation and commits before exposing its immutable storage receipt", async () => {
    const { pool, query } = fakePool(stored);
    expect(
      await createMarketplaceSampleDownloadCleanupRepository(pool).claim(candidate),
    ).toMatchObject({
      kind: "eligible",
      receipt: { objectKey: candidate.objectKey, byteCount: 20 },
    });
    expect(query).toHaveBeenCalledWith("SET LOCAL ROLE dhumi_operator");
    expect(query).toHaveBeenCalledWith(
      "SELECT *,clock_timestamp() now FROM app.marketplace_sample_downloads WHERE organization_id=$1 AND id=$2 FOR UPDATE",
      [tenantId, authorizationId],
    );
    expect(query).toHaveBeenLastCalledWith("COMMIT");
  });

  it("rejects a malformed cleanup receipt and any uncertain claim COMMIT", async () => {
    const malformed = fakePool({ ...stored,byte_count:'0' });
    await expect(
      createMarketplaceSampleDownloadCleanupRepository(malformed.pool).claim(candidate),
    ).rejects.toThrow();
    const uncertain = fakePool({...stored,state:'authorized',download_expires_at:new Date(Date.now()+3600000)}, new Error("commit response lost"));
    await expect(
      createMarketplaceSampleDownloadCleanupRepository(uncertain.pool).claim(candidate),
    ).rejects.toThrow();
  });
});
