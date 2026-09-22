import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  withAdmissionTenantTransaction,
  withIdentityTransaction,
  withJobManagerTenantTransaction,
  withOutboxDispatcherTransaction,
  withTenantTransaction,
} from "../../src/services/database/transactions.js";

interface FakeQueryResult {
  readonly rows: Record<string, unknown>[];
  readonly rowCount: number;
}

function fakePool(results: FakeQueryResult[] = []): {
  readonly pool: Pool;
  readonly query: ReturnType<typeof vi.fn>;
  readonly release: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async () => results.shift() ?? { rows: [], rowCount: 0 });
  const release = vi.fn();
  const client = { query, release };
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, query, release };
}

describe("database transactions", () => {
  it("runs identity work under the identity capability role", async () => {
    const { pool, query, release } = fakePool();

    const result = await withIdentityTransaction(pool, async (database) => {
      await database.query("SELECT 42");
      return "done";
    });

    expect(result).toBe("done");
    expect(query.mock.calls.map((call) => call[0])).toEqual([
      "BEGIN",
      "SET LOCAL ROLE dhumi_identity",
      "SELECT 42",
      "COMMIT",
    ]);
    expect(release).toHaveBeenCalledWith(undefined);
  });

  it("sets Tenant context inside the customer API transaction", async () => {
    const tenantId = "11111111-1111-4111-8111-111111111111";
    const { pool, query } = fakePool([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [{ tenant_id: tenantId }], rowCount: 1 },
      { rows: [{ visible: true }], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);

    await withTenantTransaction(pool, tenantId, async (database) => {
      await database.query("SELECT true AS visible");
    });

    expect(query.mock.calls[1]?.[0]).toBe("SET LOCAL ROLE dhumi_customer_api");
    expect(query.mock.calls[2]).toEqual([
      "SELECT set_config('app.tenant_id', $1, true) AS tenant_id",
      [tenantId],
    ]);
    expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("sets Tenant context under the dedicated admission capability", async () => {
    const tenantId = "11111111-1111-4111-8111-111111111111";
    const { pool, query } = fakePool([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [{ tenant_id: tenantId }], rowCount: 1 },
      { rows: [{ admitted: true }], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);

    await withAdmissionTenantTransaction(pool, tenantId, async (database) => {
      await database.query("SELECT true AS admitted");
    });

    expect(query.mock.calls[1]?.[0]).toBe("SET LOCAL ROLE dhumi_admission");
    expect(query.mock.calls[2]).toEqual([
      "SELECT set_config('app.tenant_id', $1, true) AS tenant_id",
      [tenantId],
    ]);
  });

  it("runs outbox claims under the dedicated dispatcher capability", async () => {
    const { pool, query } = fakePool();
    await withOutboxDispatcherTransaction(pool, async (database) => {
      await database.query("SELECT 1");
    });
    expect(query.mock.calls.map((call) => call[0])).toEqual([
      "BEGIN",
      "SET LOCAL ROLE dhumi_outbox_dispatcher",
      "SELECT 1",
      "COMMIT",
    ]);
  });

  it("sets Tenant context under the dedicated Job Manager capability", async () => {
    const tenantId = "11111111-1111-4111-8111-111111111111";
    const { pool, query } = fakePool([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [{ tenant_id: tenantId }], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);
    await withJobManagerTenantTransaction(pool, tenantId, async () => undefined);
    expect(query.mock.calls[1]?.[0]).toBe("SET LOCAL ROLE dhumi_job_manager");
    expect(query.mock.calls[2]).toEqual([
      "SELECT set_config('app.tenant_id', $1, true) AS tenant_id",
      [tenantId],
    ]);
  });

  it("rolls back and releases a connection when work fails", async () => {
    const { pool, query, release } = fakePool();

    await expect(
      withIdentityTransaction(pool, async () => {
        throw new Error("expected test failure");
      }),
    ).rejects.toThrow("expected test failure");

    expect(query.mock.calls.map((call) => call[0])).toEqual([
      "BEGIN",
      "SET LOCAL ROLE dhumi_identity",
      "ROLLBACK",
    ]);
    expect(release).toHaveBeenCalledWith(undefined);
  });

  it("rejects an invalid Tenant identifier before taking a connection", async () => {
    const { pool } = fakePool();

    await expect(withTenantTransaction(pool, "not-a-uuid", async () => undefined)).rejects.toThrow(
      "tenantId must be a valid UUID",
    );
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
