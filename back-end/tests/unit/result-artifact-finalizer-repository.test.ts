import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createResultArtifactFinalizerRepository } from "../../src/services/storage/resultArtifactFinalizerRepository.js";

const input = {
  identity: {
    tenantId: "11111111-1111-4111-8111-111111111111",
    runId: "22222222-2222-4222-8222-222222222222",
    attemptId: "33333333-3333-4333-8333-333333333333",
    kind: "normalized" as const,
    artifactVersion: 1,
  },
  receipt: {
    objectKey:
      "tenants/11111111-1111-4111-8111-111111111111/" +
      "runs/22222222-2222-4222-8222-222222222222/" +
      "attempts/33333333-3333-4333-8333-333333333333/normalized/v1/result",
    contentType: "application/json",
    contentEncoding: null,
    byteCount: 42,
    checksumHex: "ab".repeat(32),
    eTag: '"etag-1"',
  },
  artifactState: "validated" as const,
  schemaVersion: "amazon.synthetic.v1",
  recordCount: 2,
  expiresAt: new Date("2026-09-27T00:00:00.000Z"),
};

function artifactRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    object_key: input.receipt.objectKey,
    content_type: input.receipt.contentType,
    content_encoding: input.receipt.contentEncoding,
    byte_count: String(input.receipt.byteCount),
    checksum_hex: input.receipt.checksumHex,
    schema_version: input.schemaVersion,
    record_count: String(input.recordCount),
    state: input.artifactState,
    expires_at: input.expiresAt,
    ...overrides,
  };
}

function pool(inserted: boolean, row = artifactRow()) {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    .mockResolvedValueOnce({ rows: [{ tenant_id: input.identity.tenantId }], rowCount: 1 })
    .mockResolvedValueOnce({
      rows: inserted ? [{ id: row.id }] : [],
      rowCount: inserted ? 1 : 0,
    })
    .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 0 });
  const release = vi.fn();
  return {
    instance: { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool,
    query,
    release,
  };
}

describe("ResultArtifactFinalizerRepository", () => {
  it("inserts exact metadata through the result-recorder Tenant transaction", async () => {
    const fake = pool(true);

    await expect(
      createResultArtifactFinalizerRepository(fake.instance).finalize(input),
    ).resolves.toEqual({
      artifactId: "44444444-4444-4444-8444-444444444444",
      replayed: false,
    });

    expect(fake.query.mock.calls.map((call) => String(call[0]).trim().split(/\s+/).slice(0, 4).join(" "))).toEqual([
      "BEGIN",
      "SET LOCAL ROLE dhumi_result_recorder",
      "SELECT set_config('app.tenant_id', $1, true)",
      "INSERT INTO app.artifacts (",
      "SELECT id, object_key, content_type,",
      "COMMIT",
    ]);
    expect(fake.query.mock.calls[3]?.[1]).toEqual([
      input.identity.tenantId,
      input.identity.runId,
      input.identity.attemptId,
      input.identity.kind,
      input.identity.artifactVersion,
      input.receipt.objectKey,
      input.receipt.contentType,
      input.receipt.contentEncoding,
      input.receipt.byteCount,
      input.receipt.checksumHex,
      input.schemaVersion,
      input.recordCount,
      input.artifactState,
      input.expiresAt,
    ]);
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it("confirms an exact replay without updating the existing Artifact", async () => {
    const fake = pool(false);

    await expect(
      createResultArtifactFinalizerRepository(fake.instance).finalize(input),
    ).resolves.toMatchObject({ replayed: true });
  });

  it("rolls back a conflicting replay", async () => {
    const fake = pool(false, artifactRow({ checksum_hex: "cd".repeat(32) }));

    await expect(
      createResultArtifactFinalizerRepository(fake.instance).finalize(input),
    ).rejects.toMatchObject({ name: "ResultArtifactFinalizeConflictError" });
    expect(fake.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });
});
