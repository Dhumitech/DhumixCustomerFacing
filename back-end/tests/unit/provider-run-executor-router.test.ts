import { describe, expect, it, vi } from "vitest";
import type { ControlledRunExecutor } from "../../src/services/jobs/controlledRunExecutor.js";
import { createProviderRunExecutorRouter } from "../../src/services/brightdata/providerRunExecutorRouter.js";

const execution = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  runId: "22222222-2222-4222-8222-222222222222",
  attemptId: "33333333-3333-4333-8333-333333333333",
  fenceToken: "44444444-4444-4444-8444-444444444444",
  signal: new AbortController().signal,
} as const;

function executor(label: string): ControlledRunExecutor {
  return {
    completionOutcomeClass: `${label}_completed`,
    persistRaw: vi.fn(async () => ({ artifactId: `${label}-raw` })),
    persistNormalized: vi.fn(async () => ({ artifactId: `${label}-normalized`, usage: null })),
    recoverRaw: vi.fn(async () => true),
  };
}

describe("provider Run executor router", () => {
  it.each(["amazon", "marketplace"] as const)("routes %s from the pinned adapter identity", async (kind) => {
    const amazon = executor("amazon");
    const marketplace = executor("marketplace");
    const router = createProviderRunExecutorRouter({
      repository: { resolveExecutorKind: vi.fn(async () => kind as "amazon" | "marketplace") },
      amazon,
      marketplace,
    });
    await expect(router.persistRaw(execution)).resolves.toEqual({ artifactId: `${kind}-raw` });
    expect(kind === "amazon" ? amazon.persistRaw : marketplace.persistRaw).toHaveBeenCalledOnce();
  });

  it("fails closed when the customer-disabled Marketplace executor is not composed", async () => {
    const router = createProviderRunExecutorRouter({
      repository: { resolveExecutorKind: vi.fn(async () => "marketplace" as const) },
      amazon: executor("amazon"),
    });
    await expect(router.persistRaw(execution)).rejects.toMatchObject({
      customerErrorCode: "SERVICE_UNAVAILABLE",
      retryable: false,
      outcomeClass: "provider_configuration_unavailable",
    });
  });
});
