import { performance } from "node:perf_hooks";
import type { Pool } from "pg";
import type { DatabasePools } from "./pools.js";

export interface DatabaseHealthResult {
  readonly status: "healthy" | "unhealthy";
  readonly durationMs: number;
}

async function checkPool(pool: Pool): Promise<DatabaseHealthResult> {
  const startedAt = performance.now();
  try {
    await pool.query("SELECT 1");
    return {
      status: "healthy",
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    };
  } catch {
    return {
      status: "unhealthy",
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    };
  }
}

export async function checkDatabaseHealth(
  pools: DatabasePools,
): Promise<{ readonly identity: DatabaseHealthResult; readonly customerApi: DatabaseHealthResult }> {
  const [identity, customerApi] = await Promise.all([
    checkPool(pools.identity),
    checkPool(pools.customerApi),
  ]);
  return { identity, customerApi };
}
