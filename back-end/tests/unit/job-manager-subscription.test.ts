import { describe, expect, it, vi } from "vitest";
import type { JobCommandDelivery, JobCommandReceiver } from "../../src/services/jobs/executionQueue.js";
import type { JobManagerService } from "../../src/services/jobs/jobManagerService.js";
import { runJobManagerSubscription } from "../../src/worker/jobManagerSubscription.js";

describe("Job Manager subscription lifecycle", () => {
  it("stops intake and waits for an in-flight handler before shutdown resolves", async () => {
    let handler: ((delivery: JobCommandDelivery) => Promise<void>) | undefined;
    let releaseHandler: (() => void) | undefined;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let handlerFinished = false;
    const service: JobManagerService = {
      handle: vi.fn(async () => {
        await handlerGate;
        handlerFinished = true;
      }),
    };
    const close = vi.fn(async () => {
      await handlerGate;
      expect(handlerFinished).toBe(true);
    });
    const receiver: JobCommandReceiver = {
      subscribe: vi.fn(async (receivedHandler) => {
        handler = receivedHandler;
        return { close };
      }),
      close: vi.fn(async () => undefined),
    };
    const controller = new AbortController();
    const running = runJobManagerSubscription({
      receiver,
      service,
      signal: controller.signal,
      logger: { error: vi.fn() },
    });
    await vi.waitFor(() => expect(handler).toBeTypeOf("function"));

    const inFlight = handler?.({} as JobCommandDelivery);
    controller.abort();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    let stopped = false;
    void running.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    releaseHandler?.();
    await inFlight;
    await running;
    expect(handlerFinished).toBe(true);
  });
});
