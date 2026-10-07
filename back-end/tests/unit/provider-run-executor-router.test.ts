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
  it("routes the retained Amazon executor from the pinned adapter identity", async () => {
    const amazon = executor("amazon");
    const router = createProviderRunExecutorRouter({
      repository: { resolveExecutorKind: vi.fn(async () => "amazon" as const) },
      amazon,
    });
    await expect(router.persistRaw(execution)).resolves.toEqual({ artifactId: "amazon-raw" });
    await expect(router.persistNormalized(execution)).resolves.toEqual({ artifactId: "amazon-normalized", usage: null });
    await expect(router.recoverRaw?.({ ...execution, sourceAttemptId: execution.attemptId })).resolves.toBe(true);
    expect(amazon.persistRaw).toHaveBeenCalledOnce();
    expect(amazon.persistNormalized).toHaveBeenCalledOnce();
    expect(amazon.recoverRaw).toHaveBeenCalledOnce();
  });

  it("rejects retired Marketplace identities in every execution phase", async () => {
    const amazon = executor("amazon");
    const marketplace = executor("marketplace");
    // An old JavaScript caller cannot reactivate the removed optional binding.
    const legacyInput = {
      repository: { resolveExecutorKind: vi.fn(async () => "marketplace" as const) },
      amazon,
      marketplace,
    };
    const router = createProviderRunExecutorRouter(legacyInput);
    const rejection = {
      customerErrorCode: "SERVICE_UNAVAILABLE",
      retryable: false,
      outcomeClass: "provider_configuration_unavailable",
    };
    await expect(router.persistRaw(execution)).rejects.toMatchObject(rejection);
    await expect(router.persistNormalized(execution)).rejects.toMatchObject(rejection);
    await expect(router.recoverRaw?.({ ...execution, sourceAttemptId: execution.attemptId })).rejects.toMatchObject(rejection);
    expect(amazon.persistRaw).not.toHaveBeenCalled();
    expect(amazon.persistNormalized).not.toHaveBeenCalled();
    expect(amazon.recoverRaw).not.toHaveBeenCalled();
    expect(marketplace.persistRaw).not.toHaveBeenCalled();
    expect(marketplace.persistNormalized).not.toHaveBeenCalled();
    expect(marketplace.recoverRaw).not.toHaveBeenCalled();
  });

  it("fails closed without an old Marketplace binding", async () => {
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
