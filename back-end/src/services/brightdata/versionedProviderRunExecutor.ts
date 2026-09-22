import type { ControlledRunExecutor, ControlledRunExecutionInput } from "../jobs/controlledRunExecutor.js";
import { RunExecutionTerminalError } from "../jobs/controlledRunExecutor.js";
import type { ScraperAdapterIdentity } from "./scrapers/scraperExecutionRepository.js";

/** A closed registry of execution protocols/versions, never one executor per retailer. */
export function createVersionedProviderRunExecutor(input: {
  readonly repository: { resolveIdentity(input: ControlledRunExecutionInput): Promise<ScraperAdapterIdentity> };
  readonly bindings: readonly (ScraperAdapterIdentity & { readonly executor: ControlledRunExecutor })[];
}): ControlledRunExecutor {
  const bindings = new Map<string, ScraperAdapterIdentity & { readonly executor: ControlledRunExecutor }>();
  for (const binding of input.bindings) {
    const key = `${binding.code}:${binding.version}`;
    if (bindings.has(key) || !/^[a-f0-9]{64}$/.test(binding.digest)) throw new TypeError("Invalid or duplicate provider executor binding");
    bindings.set(key, Object.freeze({ ...binding }));
  }
  async function resolve(execution: ControlledRunExecutionInput): Promise<ControlledRunExecutor> {
    execution.signal.throwIfAborted();
    const identity = await input.repository.resolveIdentity(execution);
    const binding = bindings.get(`${identity.code}:${identity.version}`);
    if (!binding || identity.digest !== binding.digest) throw new RunExecutionTerminalError({
      customerErrorCode: "SERVICE_UNAVAILABLE", retryable: false,
      outcomeClass: "provider_configuration_unavailable", attemptState: "failed",
    });
    return binding.executor;
  }
  return {
    completionOutcomeClass: "provider_execution_completed",
    async persistRaw(execution) { return (await resolve(execution)).persistRaw(execution); },
    async persistNormalized(execution) { return (await resolve(execution)).persistNormalized(execution); },
    async recoverRaw(execution) { return (await resolve(execution)).recoverRaw?.(execution) ?? false; },
  };
}
