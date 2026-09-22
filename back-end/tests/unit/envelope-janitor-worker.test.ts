import { describe, expect, it, vi } from "vitest";
import { runEnvelopeJanitorLoop } from "../../src/worker/envelopeJanitor.js";

function logger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  };
}

describe("runEnvelopeJanitorLoop", () => {
  it("drains a full batch immediately, then waits without overlapping polls", async () => {
    const abortController = new AbortController();
    const destroyDue = vi.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    const log = logger();
    const waitForNextPoll = vi.fn(async () => {
      abortController.abort();
    });

    await runEnvelopeJanitorLoop({
      repository: { destroyDue },
      batchSize: 2,
      intervalMs: 1_000,
      signal: abortController.signal,
      logger: log,
      waitForNextPoll,
    });

    expect(destroyDue).toHaveBeenCalledTimes(2);
    expect(waitForNextPoll).toHaveBeenCalledOnce();
    expect(log.info).toHaveBeenCalledWith(
      { destroyedCount: 2 },
      "Expired response envelopes destroyed",
    );
  });

  it("records a safe failure signal and retries only after the interval", async () => {
    const abortController = new AbortController();
    const failure = new Error("database unavailable");
    const destroyDue = vi.fn().mockRejectedValue(failure);
    const log = logger();
    const waitForNextPoll = vi.fn(async () => {
      abortController.abort();
    });

    await runEnvelopeJanitorLoop({
      repository: { destroyDue },
      batchSize: 100,
      intervalMs: 5_000,
      signal: abortController.signal,
      logger: log,
      waitForNextPoll,
    });

    expect(log.error).toHaveBeenCalledWith(
      {
        error: expect.objectContaining({
          type: "Error",
          stack: expect.stringContaining("envelope-janitor-worker.test.ts"),
        }),
      },
      "Envelope destruction poll failed",
    );
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(failure.message);
    expect(waitForNextPoll).toHaveBeenCalledWith(5_000, abortController.signal);
  });
});
