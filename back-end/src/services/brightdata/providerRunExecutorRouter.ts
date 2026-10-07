import type {
  ControlledRunExecutionInput,
  ControlledRunExecutor,
  ControlledRunNormalizationInput,
  ControlledRunRecoveryInput,
} from "../jobs/controlledRunExecutor.js";
import { RunExecutionTerminalError } from "../jobs/controlledRunExecutor.js";

export interface ProviderExecutorKindRepository {
  resolveExecutorKind(input: Omit<ControlledRunExecutionInput, "signal">): Promise<"amazon" | "marketplace">;
}

export function createProviderRunExecutorRouter(input: {
  readonly repository: ProviderExecutorKindRepository;
  readonly amazon: ControlledRunExecutor;
}): ControlledRunExecutor {
  async function resolve(execution: Omit<ControlledRunExecutionInput, "signal">): Promise<ControlledRunExecutor> {
    const kind = await input.repository.resolveExecutorKind(execution);
    if (kind !== "amazon") {
      throw new RunExecutionTerminalError({
        customerErrorCode: "SERVICE_UNAVAILABLE",
        retryable: false,
        outcomeClass: "provider_configuration_unavailable",
        attemptState: "failed",
      });
    }
    return input.amazon;
  }

  return Object.freeze({
    completionOutcomeClass: "provider_execution_completed",
    async persistRaw(execution: ControlledRunExecutionInput) {
      return (await resolve(execution)).persistRaw(execution);
    },
    async persistNormalized(execution: ControlledRunNormalizationInput) {
      return (await resolve(execution)).persistNormalized(execution);
    },
    async recoverRaw(execution: ControlledRunRecoveryInput) {
      const executor = await resolve(execution);
      return executor.recoverRaw === undefined ? false : executor.recoverRaw(execution);
    },
  });
}
