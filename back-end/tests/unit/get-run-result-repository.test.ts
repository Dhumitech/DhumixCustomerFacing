import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createGetRunResultRepository } from "../../src/services/runQuery/getRunResultRepository.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const artifactId = "33333333-3333-4333-8333-333333333333";
const userId = "44444444-4444-4444-8444-444444444444";

function auditPool(inserted: boolean) {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    .mockResolvedValueOnce({ rows: [{ tenant_id: tenantId }], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: inserted ? 1 : 0 })
    .mockResolvedValueOnce({ rows: [], rowCount: 0 });
  const release = vi.fn();
  return {
    instance: { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool,
    query,
    release,
  };
}

function findPool() {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    .mockResolvedValueOnce({ rows: [{ tenant_id: tenantId }], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [{ public_status: "ready" }], rowCount: 1 })
    .mockResolvedValueOnce({
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
    })
    .mockResolvedValueOnce({ rows: [], rowCount: 0 });
  const release = vi.fn();
  return {
    instance: { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool,
    query,
  };
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
        runId,
        representation,
      }),
    ).resolves.toMatchObject({ kind: "ready", artifact: { artifactId } });

    const artifactSql = String(fake.query.mock.calls[4]?.[0]);
    expect(artifactSql).toContain("kind = $3");
    expect(artifactSql).toContain("state = $4");
    expect(fake.query.mock.calls[4]?.[1]).toEqual([
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

    const auditSql = String(fake.query.mock.calls[3]?.[0]);
    expect(auditSql).toContain("INSERT INTO app.audit_events");
    expect(auditSql).toContain("'representation', $8::text");
    expect(auditSql).toContain("artifact.kind = $8");
    expect(auditSql).toContain("artifact.state = $9");
    expect(auditSql).not.toMatch(/\bRETURNING\b/i);
    expect(fake.query.mock.calls[3]?.[1]).toEqual([
      tenantId,
      runId,
      artifactId,
      userId,
      null,
      null,
      null,
      "raw",
      "durable",
    ]);
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
