import { customerContextFixture } from "../helpers/customerContextFixture.js";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createGetRunResultRepository } from "../../src/services/runQuery/getRunResultRepository.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const artifactId = "33333333-3333-4333-8333-333333333333";
const userId = "44444444-4444-4444-8444-444444444444";

function fakePool(inserted = true) {
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    const context = customerContextFixture(sql, values);
    if (context !== undefined) return context;
    if (sql.includes("INSERT INTO app.audit_events"))
      return { rows: [], rowCount: inserted ? 1 : 0 };
    if (sql.includes("FROM app.runs")) return { rows: [{ public_status: "ready" }], rowCount: 1 };
    if (sql.includes("FROM app.artifacts"))
      return {
        rows: [
          {
            id: artifactId,
            object_key: "private/object",
            content_type: "application/json",
            byte_count: "42",
            checksum: Buffer.from("ab".repeat(32), "hex"),
          },
        ],
        rowCount: 1,
      };
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  return {
    instance: { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool,
    query,
    release,
  };
}
function auditPool(inserted: boolean) {
  return fakePool(inserted);
}
function findPool() {
  return fakePool();
}

describe("GetRunResultRepository", () => {
  it.each([
    ["normalized", "validated"],
    ["raw", "durable"],
  ] as const)("selects only the %s Artifact in state %s", async (representation, state) => {
    const fake = findPool();

    await expect(
      createGetRunResultRepository(fake.instance).findResult({
        tenantId,
        userId,
        runId,
        representation,
      }),
    ).resolves.toMatchObject({ kind: "ready", artifact: { artifactId } });

    const artifactSql = String(
      fake.query.mock.calls.find(([sql]) => sql.includes("FROM app.artifacts"))?.[0],
    );
    expect(artifactSql).toContain("kind = $3");
    expect(artifactSql).toContain("state = $4");
    expect(fake.query.mock.calls.find(([sql]) => sql.includes("FROM app.artifacts"))?.[1]).toEqual([
      tenantId,
      runId,
      representation,
      state,
    ]);
  });

  it("records authorization without reading from the append-only audit table", async () => {
    const fake = auditPool(true);

    await expect(
      createGetRunResultRepository(fake.instance).recordDownloadAuthorization({
        tenantId,
        runId,
        artifactId,
        representation: "raw",
        actor: { kind: "browser", userId },
        requestId: null,
        ipFingerprint: null,
      }),
    ).resolves.toBeUndefined();

    const auditSql = String(
      fake.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO app.audit_events"))?.[0],
    );
    expect(auditSql).toContain("INSERT INTO app.audit_events");
    expect(auditSql).toContain("'representation', $7::text");
    expect(auditSql).toContain("artifact.kind = $7");
    expect(auditSql).toContain("artifact.state = $8");
    expect(auditSql).not.toContain("actor_api_key_id");
    expect(auditSql).not.toMatch(/\bRETURNING\b/i);
    expect(
      fake.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO app.audit_events"))?.[1],
    ).toEqual([tenantId, runId, artifactId, userId, null, null, "raw", "durable"]);
    expect(fake.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it("fails closed when the result becomes stale before audit insertion", async () => {
    const fake = auditPool(false);

    await expect(
      createGetRunResultRepository(fake.instance).recordDownloadAuthorization({
        tenantId,
        runId,
        artifactId,
        representation: "normalized",
        actor: { kind: "browser", userId },
        requestId: null,
        ipFingerprint: null,
      }),
    ).rejects.toMatchObject({ status: 500, code: "INTERNAL_ERROR" });
    expect(fake.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });
});
