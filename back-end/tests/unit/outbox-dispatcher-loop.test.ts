import { describe, expect, it, vi } from "vitest";
import type { OutboxDispatcherService } from "../../src/services/jobs/outboxDispatcherService.js";
import { runOutboxDispatcherLoop } from "../../src/worker/outboxDispatcher.js";

describe("Outbox Dispatcher loop", () => {
  it("finishes the active database-to-broker dispatch before shutdown resolves", async () => {
    let releaseDispatch: (() => void) | undefined;
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const service: OutboxDispatcherService = {
      dispatchOnce: vi.fn(async () => {
        await dispatchGate;
        return 1;
      }),
    };
    const controller = new AbortController();
    const running = runOutboxDispatcherLoop({
      service,
      intervalMs: 100,
      batchSize: 20,
      signal: controller.signal,
      logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn() },
      waitForNextPoll: vi.fn(async () => undefined),
    });
    await vi.waitFor(() => expect(service.dispatchOnce).toHaveBeenCalledOnce());

    controller.abort();
    let stopped = false;
    void running.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    releaseDispatch?.();
    await running;
    expect(service.dispatchOnce).toHaveBeenCalledOnce();
  });
});
