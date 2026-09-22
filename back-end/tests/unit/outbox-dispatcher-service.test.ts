import { describe, expect, it, vi } from "vitest";
import type { JobCommandEnvelope } from "../../src/services/jobs/jobCommand.js";
import { createOutboxDispatcherService } from "../../src/services/jobs/outboxDispatcherService.js";

function command(eventId: string): JobCommandEnvelope {
  const runId = "11111111-1111-4111-8111-111111111111";
  return {
    event_id: eventId,
    topic: "jobs.execute",
    schema_version: 1,
    aggregate_type: "run",
    aggregate_id: runId,
    tenant_id: "33333333-3333-4333-8333-333333333333",
    ordering_key: runId,
    payload: { run_id: runId },
  };
}

describe("OutboxDispatcherService", () => {
  it("publishes claimed commands and acknowledges each only after send success", async () => {
    const first = command("22222222-2222-4222-8222-222222222222");
    const second = command("44444444-4444-4444-8444-444444444444");
    const claim = vi.fn(async () => [
      { command: first, claimToken: "55555555-5555-4555-8555-555555555555" },
      { command: second, claimToken: "66666666-6666-4666-8666-666666666666" },
    ]);
    const markPublished = vi.fn(async () => true);
    const publish = vi.fn(async () => undefined);
    const service = createOutboxDispatcherService({
      repository: { claim, markPublished },
      publisher: { publish, close: vi.fn(async () => undefined) },
      consumerId: "dispatcher-1",
      batchSize: 20,
      claimTtlMs: 60_000,
    });

    await expect(service.dispatchOnce()).resolves.toBe(2);
    expect(claim).toHaveBeenCalledWith({
      consumerId: "dispatcher-1",
      batchSize: 20,
      claimTtlMs: 60_000,
    });
    expect(publish).toHaveBeenNthCalledWith(1, first);
    expect(markPublished).toHaveBeenNthCalledWith(
      1,
      first.event_id,
      "55555555-5555-4555-8555-555555555555",
    );
  });

  it("leaves the database claim unacknowledged when broker publish fails", async () => {
    const claimed = command("22222222-2222-4222-8222-222222222222");
    const markPublished = vi.fn(async () => true);
    const service = createOutboxDispatcherService({
      repository: {
        claim: vi.fn(async () => [
          { command: claimed, claimToken: "55555555-5555-4555-8555-555555555555" },
        ]),
        markPublished,
      },
      publisher: {
        publish: vi.fn(async () => {
          throw new Error("broker unavailable");
        }),
        close: vi.fn(async () => undefined),
      },
      consumerId: "dispatcher-1",
      batchSize: 20,
      claimTtlMs: 60_000,
    });

    await expect(service.dispatchOnce()).rejects.toThrow("broker unavailable");
    expect(markPublished).not.toHaveBeenCalled();
  });

  it("fails if a published command can no longer acknowledge its exact claim", async () => {
    const claimed = command("22222222-2222-4222-8222-222222222222");
    const service = createOutboxDispatcherService({
      repository: {
        claim: vi.fn(async () => [
          { command: claimed, claimToken: "55555555-5555-4555-8555-555555555555" },
        ]),
        markPublished: vi.fn(async () => false),
      },
      publisher: { publish: vi.fn(async () => undefined), close: vi.fn(async () => undefined) },
      consumerId: "dispatcher-1",
      batchSize: 20,
      claimTtlMs: 60_000,
    });

    await expect(service.dispatchOnce()).rejects.toThrow(
      "OUTBOX_PUBLISH_ACKNOWLEDGEMENT_REJECTED",
    );
  });
});
