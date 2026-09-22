import { describe, expect, it, vi } from "vitest";
import type { DeadLetterRecoveryRepository } from "../../src/services/jobs/deadLetterRecoveryRepository.js";
import { createDeadLetterRecoveryService } from "../../src/services/jobs/deadLetterRecoveryService.js";
import type { DeadLetterCommandReceiver } from "../../src/services/jobs/executionQueue.js";
import { parseJobCommandEnvelope } from "../../src/services/jobs/jobCommand.js";

const eventId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const command = parseJobCommandEnvelope({
  event_id: eventId,
  topic: "jobs.execute",
  schema_version: 1,
  aggregate_type: "run",
  aggregate_id: runId,
  tenant_id: "33333333-3333-4333-8333-333333333333",
  ordering_key: runId,
  payload: { run_id: runId },
});

function dependencies() {
  const complete = vi.fn(async () => undefined);
  const abandon = vi.fn(async () => undefined);
  const receiver: DeadLetterCommandReceiver = {
    receiveByEventId: vi.fn(async () => ({
      command,
      deadLetterReason: "MaxDeliveryCountExceeded",
      deliveryCount: 5,
      complete,
      abandon,
    })),
    close: vi.fn(async () => undefined),
  };
  const repository: DeadLetterRecoveryRepository = {
    requestRecovery: vi.fn(async () => ({
      recoveryEventId: "44444444-4444-4444-8444-444444444444",
      scheduled: true,
      terminal: false,
    })),
  };
  return { receiver, repository, complete, abandon };
}

describe("controlled dead-letter recovery", () => {
  it("commits a durable recovery command before completing the DLQ message", async () => {
    const parts = dependencies();
    const result = await createDeadLetterRecoveryService(parts).recover({
      eventId,
      reasonCode: "transient_infrastructure_recovered",
      maxWaitTimeMs: 1_000,
    });

    expect(parts.repository.requestRecovery).toHaveBeenCalledWith({
      originalEventId: eventId,
      reasonCode: "transient_infrastructure_recovered",
    });
    expect(parts.complete).toHaveBeenCalledOnce();
    expect(parts.abandon).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scheduled: true, terminal: false });
  });

  it("abandons the DLQ lock if the authoritative database operation fails", async () => {
    const parts = dependencies();
    vi.mocked(parts.repository.requestRecovery).mockRejectedValue(new Error("database unavailable"));

    await expect(
      createDeadLetterRecoveryService(parts).recover({
        eventId,
        reasonCode: "configuration_repaired",
        maxWaitTimeMs: 1_000,
      }),
    ).rejects.toThrow("database unavailable");

    expect(parts.complete).not.toHaveBeenCalled();
    expect(parts.abandon).toHaveBeenCalledOnce();
  });
});
