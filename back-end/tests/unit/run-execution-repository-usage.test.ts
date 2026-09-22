import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createRunExecutionRepository } from "../../src/services/jobs/runExecutionRepository.js";

const tenantId = "11111111-1111-4111-8111-111111111111";

function pool() {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    .mockResolvedValueOnce({ rows: [{ tenant_id: tenantId }], rowCount: 1 })
    .mockResolvedValueOnce({
      rows: [{ state_version: "4", internal_status: "COMPLETED", public_status: "ready" }],
      rowCount: 1,
    })
    .mockResolvedValueOnce({ rows: [], rowCount: 0 });
  return {
    instance: {
      connect: vi.fn(async () => ({ query, release: vi.fn() })),
    } as unknown as Pool,
    query,
  };
}

describe("RunExecutionRepository usage completion", () => {
  it("passes only the Artifact identity and fixed observation dimensions", async () => {
    const fake = pool();
    const repository = createRunExecutionRepository(fake.instance);

    await expect(repository.completeSuccess({
      tenantId,
      runId: "22222222-2222-4222-8222-222222222222",
      expectedStateVersion: 3,
      eventIdempotencyKey: "job.completed.v1:attempt",
      attemptId: "33333333-3333-4333-8333-333333333333",
      fenceToken: "44444444-4444-4444-8444-444444444444",
      outcomeClass: "provider_execution_completed",
      normalizedArtifactId: "55555555-5555-4555-8555-555555555555",
      usage: {
        meterCode: "amazon.result_records.observed",
        unit: "records",
      },
      safePayload: { status: "ready" },
    })).resolves.toEqual({
      stateVersion: 4,
      internalStatus: "COMPLETED",
      publicStatus: "ready",
    });

    expect(String(fake.query.mock.calls[3]?.[0])).toContain(
      "app.complete_run_execution_with_usage",
    );
    expect(fake.query.mock.calls[3]?.[1]).toEqual([
      "22222222-2222-4222-8222-222222222222",
      3,
      "job.completed.v1:attempt",
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
      "provider_execution_completed",
      "55555555-5555-4555-8555-555555555555",
      "amazon.result_records.observed",
      "records",
      { status: "ready" },
    ]);
  });
});
