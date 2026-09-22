import { describe, expect, it } from "vitest";
import { parseJobCommandEnvelope } from "../../src/services/jobs/jobCommand.js";

const runId = "11111111-1111-4111-8111-111111111111";

function command(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: "22222222-2222-4222-8222-222222222222",
    topic: "jobs.execute",
    schema_version: 1,
    aggregate_type: "run",
    aggregate_id: runId,
    tenant_id: "33333333-3333-4333-8333-333333333333",
    ordering_key: runId,
    payload: { run_id: runId },
    ...overrides,
  };
}

describe("job command envelope", () => {
  it("accepts one minimal consistent v1 command", () => {
    expect(parseJobCommandEnvelope(command())).toMatchObject({
      topic: "jobs.execute",
      payload: { run_id: runId },
    });
  });

  it("accepts the private reconciliation topic with the same minimal Run-only payload", () => {
    expect(parseJobCommandEnvelope(command({ topic: "jobs.reconcile" }))).toMatchObject({
      topic: "jobs.reconcile",
      payload: { run_id: runId },
    });
  });

  it("accepts the private operator-recovery topic without expanding its payload", () => {
    expect(parseJobCommandEnvelope(command({ topic: "jobs.recover" }))).toMatchObject({
      topic: "jobs.recover",
      payload: { run_id: runId },
    });
  });

  it("rejects unknown fields and provider/customer input", () => {
    expect(() => parseJobCommandEnvelope(command({ dataset_id: "gd_private" }))).toThrow();
    expect(() =>
      parseJobCommandEnvelope(command({ payload: { run_id: runId, url: "https://example.test" } })),
    ).toThrow();
  });

  it("rejects conflicting Run identifiers and unsupported topics or versions", () => {
    expect(() =>
      parseJobCommandEnvelope(
        command({ payload: { run_id: "44444444-4444-4444-8444-444444444444" } }),
      ),
    ).toThrow(/must agree/);
    expect(() => parseJobCommandEnvelope(command({ topic: "notifications.email" }))).toThrow();
    expect(() => parseJobCommandEnvelope(command({ schema_version: 2 }))).toThrow();
  });
});
