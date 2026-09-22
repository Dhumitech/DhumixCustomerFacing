import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  sessionStorage.clear();
  vi.resetModules();
});

describe("mutation idempotency persistence", () => {
  it("survives an application-module reload without storing request data", async () => {
    const firstModule = await import("./mutationIdempotency");
    const request = {
      serviceId: "service-1",
      body: {
        input: {
          targets: [{ url: "https://www.amazon.com/dp/B00TEST001" }],
        },
      },
    };
    const first = await firstModule.acquireMutationIdempotency(
      "run.create",
      request,
    );

    vi.resetModules();
    const reloadedModule = await import("./mutationIdempotency");
    const afterReload = await reloadedModule.acquireMutationIdempotency(
      "run.create",
      request,
    );

    expect(afterReload.headerValue).toBe(first.headerValue);
    expect(JSON.stringify(sessionStorage)).not.toContain("amazon.com");
  });

  it("uses canonical object ordering for one logical request", async () => {
    const idempotency = await import("./mutationIdempotency");
    const first = await idempotency.acquireMutationIdempotency(
      "service.create",
      { name: "Research", configuration: {}, template: "amazon" },
    );
    const reordered = await idempotency.acquireMutationIdempotency(
      "service.create",
      { template: "amazon", name: "Research", configuration: {} },
    );

    expect(reordered.headerValue).toBe(first.headerValue);
  });
});
