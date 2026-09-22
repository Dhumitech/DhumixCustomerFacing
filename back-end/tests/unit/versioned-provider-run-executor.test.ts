import { describe, expect, it, vi } from "vitest";
import { createVersionedProviderRunExecutor } from "../../src/services/brightdata/versionedProviderRunExecutor.js";
import type { ControlledRunExecutor } from "../../src/services/jobs/controlledRunExecutor.js";
const execution = { tenantId: "11111111-1111-4111-8111-111111111111", runId: "22222222-2222-4222-8222-222222222222",
  attemptId: "33333333-3333-4333-8333-333333333333", fenceToken: "44444444-4444-4444-8444-444444444444", signal: new AbortController().signal };
function port(label: string): ControlledRunExecutor {
  return { completionOutcomeClass: "provider_execution_completed", persistRaw: vi.fn(async () => ({ artifactId: label })),
    persistNormalized: vi.fn(async () => ({ artifactId: label, usage: null })), recoverRaw: vi.fn(async () => true) };
}
describe("version-pinned provider execution protocols", () => {
  it("selects the exact code, version and digest without selecting the latest version", async () => {
    const legacy = port("legacy"), shared = port("shared");
    const identity = { code: "bright_data.amazon.scraper_library", version: "legacy", digest: "ab".repeat(32) };
    const router = createVersionedProviderRunExecutor({ repository: { resolveIdentity: vi.fn(async () => identity) }, bindings: [
      { ...identity, executor: legacy }, { code: "bright_data.scraper_library.shared", version: "new", digest: "cd".repeat(32), executor: shared },
    ] });
    await expect(router.persistRaw(execution)).resolves.toEqual({ artifactId: "legacy" });
    await expect(router.persistNormalized(execution)).resolves.toEqual({ artifactId: "legacy", usage: null });
    await expect(router.recoverRaw!({ ...execution, sourceAttemptId: execution.attemptId })).resolves.toBe(true);
    expect(shared.persistRaw).not.toHaveBeenCalled();
    expect(shared.persistNormalized).not.toHaveBeenCalled();
  });
  it.each([
    { code: "unknown", version: "v1", digest: "ab".repeat(32) },
    { code: "known", version: "v2", digest: "ab".repeat(32) },
    { code: "known", version: "v1", digest: "cd".repeat(32) },
  ])("rejects mismatched identity before calling any executor", async (identity) => {
    const executor = port("must-not-call");
    const router = createVersionedProviderRunExecutor({ repository: { resolveIdentity: vi.fn(async () => identity) },
      bindings: [{ code: "known", version: "v1", digest: "ab".repeat(32), executor }] });
    await expect(router.persistRaw(execution)).rejects.toMatchObject({ customerErrorCode: "SERVICE_UNAVAILABLE" });
    expect(executor.persistRaw).not.toHaveBeenCalled();
  });
  it("has no fallback for a Marketplace protocol that is deliberately not composed", async () => {
    const router = createVersionedProviderRunExecutor({ repository: { resolveIdentity: vi.fn(async () => ({
      code: "bright_data.marketplace.filter", version: "1.0.0-m7-fixture", digest: "ab".repeat(32),
    })) }, bindings: [] });
    await expect(router.persistRaw(execution)).rejects.toMatchObject({ retryable: false, customerErrorCode: "SERVICE_UNAVAILABLE" });
  });
  it("rejects duplicate protocol versions at composition time", () => {
    const binding = { code: "known", version: "v1", digest: "ab".repeat(32), executor: port("no") };
    expect(() => createVersionedProviderRunExecutor({ repository: { resolveIdentity: vi.fn() }, bindings: [binding, binding] })).toThrow(TypeError);
  });
});
