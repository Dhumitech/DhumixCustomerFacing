import { setTimeout as wait } from "node:timers/promises";
import type { CapacityLease, CapacityLeaseStore } from "./capacityLease.js";
import {
  RunExecutionCancellationError,
  RunExecutionTerminalError,
  RunExecutionReconciliationError,
  type ControlledRunExecutor,
} from "./controlledRunExecutor.js";
import type { JobCommandDelivery } from "./executionQueue.js";
import type {
  RunAttemptClaim,
  RunExecutionRepository,
} from "./runExecutionRepository.js";

export interface JobManagerService {
  handle(delivery: JobCommandDelivery): Promise<void>;
}

interface JobManagerDependencies {
  readonly repository: RunExecutionRepository;
  readonly leaseStore: CapacityLeaseStore;
  readonly executor: ControlledRunExecutor;
  readonly attemptLeaseMs: number;
  readonly capacityLeaseMs: number;
  readonly renewIntervalMs: number;
}

function databaseCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const value = (error as { readonly code?: unknown }).code;
  return typeof value === "string" ? value : undefined;
}

function ownedClaim(claim: RunAttemptClaim): {
  readonly attemptId: string;
  readonly fenceToken: string;
} {
  if (
    !["claimed", "recovered"].includes(claim.disposition) ||
    claim.attemptId === null ||
    claim.fenceToken === null
  ) {
    throw new Error("Run Attempt ownership was not established");
  }
  return { attemptId: claim.attemptId, fenceToken: claim.fenceToken };
}

async function cancelOwnedRun(input: {
  readonly repository: RunExecutionRepository;
  readonly tenantId: string;
  readonly runId: string;
  readonly runStateVersion: number;
  readonly attemptId: string;
  readonly fenceToken: string;
}): Promise<void> {
  await input.repository.transition({
    tenantId: input.tenantId,
    runId: input.runId,
    expectedStateVersion: input.runStateVersion,
    toInternalStatus: "CANCELLED",
    eventType: "cancelled",
    eventIdempotencyKey: `job.cancelled.v1:${input.attemptId}`,
    attemptId: input.attemptId,
    fenceToken: input.fenceToken,
    safePayload: { status: "cancelled" },
  });
  if (
    !(await input.repository.finish({
      tenantId: input.tenantId,
      attemptId: input.attemptId,
      fenceToken: input.fenceToken,
      state: "completed",
      outcomeClass: "cancelled_before_execution",
    }))
  ) {
    throw new Error("RUN_ATTEMPT_FINISH_REJECTED");
  }
}

function reconciliationOutcomeClass(executor: ControlledRunExecutor): string {
  return executor.completionOutcomeClass === "provider_execution_completed"
    ? "provider_reconciliation_completed"
    : "controlled_reconciliation_completed";
}

async function runWithRenewal(input: {
  readonly work: (signal: AbortSignal) => Promise<void>;
  readonly delivery: JobCommandDelivery;
  readonly repository: RunExecutionRepository;
  readonly leaseStore: CapacityLeaseStore;
  readonly lease: CapacityLease;
  readonly tenantId: string;
  readonly attemptId: string;
  readonly fenceToken: string;
  readonly attemptLeaseMs: number;
  readonly capacityLeaseMs: number;
  readonly renewIntervalMs: number;
}): Promise<void> {
  const controller = new AbortController();
  let heartbeatFailure: unknown;
  const heartbeat = (async () => {
    try {
      while (!controller.signal.aborted) {
        await wait(input.renewIntervalMs, undefined, { signal: controller.signal });
        const [renewedUntil, redisRenewed] = await Promise.all([
          input.repository.renew({
            tenantId: input.tenantId,
            attemptId: input.attemptId,
            fenceToken: input.fenceToken,
            leaseTtlMs: input.attemptLeaseMs,
          }),
          input.leaseStore.renew(input.lease, input.capacityLeaseMs),
          input.delivery.renewLock(),
        ]);
        if (renewedUntil === null || !redisRenewed) {
          throw new Error("JOB_EXECUTION_LEASE_RENEWAL_REJECTED");
        }
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) {
        heartbeatFailure = error;
        controller.abort();
      }
    }
  })();

  try {
    await input.work(controller.signal);
  } finally {
    controller.abort();
    await heartbeat;
  }
  if (heartbeatFailure !== undefined) throw heartbeatFailure;
}

async function handleReconciliation(
  input: JobManagerDependencies,
  delivery: JobCommandDelivery,
): Promise<void> {
  const { command } = delivery;
  let settled = false;
  let lease: CapacityLease | null = null;
  try {
    let claim: RunAttemptClaim;
    try {
      claim = await input.repository.claimReconciliation({
        tenantId: command.tenant_id,
        runId: command.payload.run_id,
        leaseTtlMs: input.attemptLeaseMs,
      });
    } catch (error) {
      if (databaseCode(error) === "P0002") {
        await delivery.deadLetter("RUN_COMMAND_NOT_FOUND");
        settled = true;
        return;
      }
      throw error;
    }

    if (claim.disposition === "terminal") {
      await delivery.complete();
      settled = true;
      return;
    }
    if (
      claim.disposition === "busy" ||
      claim.disposition === "not_claimable" ||
      claim.disposition === "reconciliation_required"
    ) {
      await delivery.abandon();
      settled = true;
      return;
    }

    const ownership = ownedClaim(claim);
    let evidence = await input.repository.inspectReconciliation({
      tenantId: command.tenant_id,
      runId: command.payload.run_id,
    });

    if (claim.cancellationRequested && claim.runInternalStatus === "SUBMITTED") {
      await input.repository.completeReconciliation({
        tenantId: command.tenant_id,
        runId: command.payload.run_id,
        expectedStateVersion: claim.runStateVersion,
        toInternalStatus: "CANCELLED",
        eventType: "cancelled",
        eventIdempotencyKey: `job.reconciled-cancelled.v1:${ownership.attemptId}`,
        reconciliationAttemptId: ownership.attemptId,
        reconciliationFenceToken: ownership.fenceToken,
        sourceAttemptId: evidence.sourceAttemptId,
        sourceAttemptState: "failed",
        sourceOutcomeClass: "cancelled_during_reconciliation",
        reconciliationOutcomeClass: "cancelled_during_reconciliation",
        safePayload: { status: "cancelled" },
      });
      await delivery.complete();
      settled = true;
      return;
    }

    lease = await input.leaseStore.acquire(command.payload.run_id, input.capacityLeaseMs);
    if (lease === null) {
      await delivery.abandon();
      settled = true;
      return;
    }

    let stateVersion = claim.runStateVersion;
    await runWithRenewal({
      work: async (signal) => {
        if (evidence.hasNormalizedArtifact && !evidence.hasRawArtifact) {
          throw new Error("RUN_RECONCILIATION_ARTIFACT_INVARIANT_VIOLATION");
        }

        if (!evidence.hasRawArtifact && input.executor.recoverRaw !== undefined) {
          try {
            const recovered = await input.executor.recoverRaw({
              tenantId: command.tenant_id,
              runId: command.payload.run_id,
              attemptId: ownership.attemptId,
              fenceToken: ownership.fenceToken,
              sourceAttemptId: evidence.sourceAttemptId,
              signal,
            });
            if (recovered) evidence = { ...evidence, hasRawArtifact: true };
          } catch (error) {
            if (error instanceof RunExecutionCancellationError) {
              const cancelled = await input.repository.completeReconciliation({
                tenantId: command.tenant_id,
                runId: command.payload.run_id,
                expectedStateVersion: stateVersion,
                toInternalStatus: "CANCELLED",
                eventType: "cancelled",
                eventIdempotencyKey: `job.reconciled-provider-cancelled.v1:${ownership.attemptId}`,
                reconciliationAttemptId: ownership.attemptId,
                reconciliationFenceToken: ownership.fenceToken,
                sourceAttemptId: evidence.sourceAttemptId,
                sourceAttemptState: "failed",
                sourceOutcomeClass: "provider_snapshot_cancelled",
                reconciliationOutcomeClass: "provider_reconciliation_cancelled",
                safePayload: { status: "cancelled" },
              });
              stateVersion = cancelled.stateVersion;
              return;
            }
            if (error instanceof RunExecutionTerminalError) {
              const failed = await input.repository.completeReconciliation({
                tenantId: command.tenant_id,
                runId: command.payload.run_id,
                expectedStateVersion: stateVersion,
                toInternalStatus: "UPSTREAM_FAILED",
                eventType: "failed",
                eventIdempotencyKey: `job.reconciled-provider-failed.v1:${ownership.attemptId}`,
                reconciliationAttemptId: ownership.attemptId,
                reconciliationFenceToken: ownership.fenceToken,
                sourceAttemptId: evidence.sourceAttemptId,
                sourceAttemptState: "failed",
                sourceOutcomeClass: error.outcomeClass,
                reconciliationOutcomeClass: "provider_reconciliation_failed",
                customerErrorCode: error.customerErrorCode,
                retryable: error.retryable,
                safePayload: { status: "failed", code: error.customerErrorCode },
              });
              stateVersion = failed.stateVersion;
              return;
            }
            throw error;
          }
        }

        if (!evidence.hasRawArtifact) {
          if (claim.runInternalStatus !== "SUBMITTED") {
            throw new Error("RUN_RECONCILIATION_ARTIFACT_INVARIANT_VIOLATION");
          }
          const completed = await input.repository.completeReconciliation({
            tenantId: command.tenant_id,
            runId: command.payload.run_id,
            expectedStateVersion: stateVersion,
            toInternalStatus: "UPSTREAM_FAILED",
            eventType: "failed",
            eventIdempotencyKey: `job.reconciled-failed.v1:${ownership.attemptId}`,
            reconciliationAttemptId: ownership.attemptId,
            reconciliationFenceToken: ownership.fenceToken,
            sourceAttemptId: evidence.sourceAttemptId,
            sourceAttemptState: "failed",
            sourceOutcomeClass: "reconciled_no_durable_result",
            reconciliationOutcomeClass: reconciliationOutcomeClass(input.executor),
            customerErrorCode: "EXECUTION_OUTCOME_UNCERTAIN",
            retryable: true,
            safePayload: { status: "failed", code: "EXECUTION_OUTCOME_UNCERTAIN" },
          });
          stateVersion = completed.stateVersion;
          return;
        }

        let currentInternalStatus = claim.runInternalStatus;
        if (currentInternalStatus === "SUBMITTED") {
          const transition = await input.repository.transition({
            tenantId: command.tenant_id,
            runId: command.payload.run_id,
            expectedStateVersion: stateVersion,
            toInternalStatus: "RESULT_RECEIVED",
            eventType: "result_received",
            eventIdempotencyKey: `job.reconciled-result-received.v1:${ownership.attemptId}`,
            attemptId: ownership.attemptId,
            fenceToken: ownership.fenceToken,
            safePayload: { status: "running" },
          });
          stateVersion = transition.stateVersion;
          currentInternalStatus = transition.internalStatus;
        }

        if (currentInternalStatus === "RESULT_RECEIVED") {
          const transition = await input.repository.transition({
            tenantId: command.tenant_id,
            runId: command.payload.run_id,
            expectedStateVersion: stateVersion,
            toInternalStatus: "PROCESSING",
            eventType: "processing",
            eventIdempotencyKey: `job.reconciled-processing.v1:${ownership.attemptId}`,
            attemptId: ownership.attemptId,
            fenceToken: ownership.fenceToken,
            safePayload: { status: "running" },
          });
          stateVersion = transition.stateVersion;
          currentInternalStatus = transition.internalStatus;
        }

        if (currentInternalStatus !== "PROCESSING") {
          throw new Error("RUN_RECONCILIATION_STATE_NOT_RECOVERABLE");
        }

        // Re-run deterministic normalization even when the immutable Artifact
        // already exists. The ingestion/finalizer replay verifies identical
        // metadata and returns the usage observation lost by a prior crash.
        let normalized;
        try {
          normalized = await input.executor.persistNormalized({
            tenantId: command.tenant_id,
            runId: command.payload.run_id,
            attemptId: ownership.attemptId,
            fenceToken: ownership.fenceToken,
            sourceAttemptId: evidence.sourceAttemptId,
            signal,
          });
        } catch (error) {
          if (!(error instanceof RunExecutionTerminalError)) throw error;
          const failed = await input.repository.completeReconciliation({
            tenantId: command.tenant_id,
            runId: command.payload.run_id,
            expectedStateVersion: stateVersion,
            toInternalStatus: "PROCESSING_FAILED",
            eventType: "failed",
            eventIdempotencyKey: `job.reconciled-processing-failed.v1:${ownership.attemptId}`,
            reconciliationAttemptId: ownership.attemptId,
            reconciliationFenceToken: ownership.fenceToken,
            sourceAttemptId: evidence.sourceAttemptId,
            sourceAttemptState: "failed",
            sourceOutcomeClass: error.outcomeClass,
            reconciliationOutcomeClass: "provider_reconciliation_failed",
            customerErrorCode: error.customerErrorCode,
            retryable: error.retryable,
            safePayload: { status: "failed", code: error.customerErrorCode },
          });
          stateVersion = failed.stateVersion;
          return;
        }

        const completed = await input.repository.completeReconciliationSuccess({
          tenantId: command.tenant_id,
          runId: command.payload.run_id,
          expectedStateVersion: stateVersion,
          eventIdempotencyKey: `job.reconciled-completed.v1:${ownership.attemptId}`,
          reconciliationAttemptId: ownership.attemptId,
          reconciliationFenceToken: ownership.fenceToken,
          sourceAttemptId: evidence.sourceAttemptId,
          reconciliationOutcomeClass: reconciliationOutcomeClass(input.executor),
          normalizedArtifactId: normalized.artifactId,
          usage: normalized.usage,
          safePayload: { status: "ready" },
        });
        stateVersion = completed.stateVersion;
      },
      delivery,
      repository: input.repository,
      leaseStore: input.leaseStore,
      lease,
      tenantId: command.tenant_id,
      attemptId: ownership.attemptId,
      fenceToken: ownership.fenceToken,
      attemptLeaseMs: input.attemptLeaseMs,
      capacityLeaseMs: input.capacityLeaseMs,
      renewIntervalMs: input.renewIntervalMs,
    });
    await delivery.complete();
    settled = true;
  } catch (error) {
    if (!settled) {
      await delivery.abandon();
      settled = true;
    }
    throw error;
  } finally {
    if (lease !== null) await input.leaseStore.release(lease);
  }
}

export function createJobManagerService(input: JobManagerDependencies): JobManagerService {
  return {
    async handle(delivery): Promise<void> {
      const { command } = delivery;
      if (command.topic === "jobs.reconcile") {
        await handleReconciliation(input, delivery);
        return;
      }
      let settled = false;
      let lease: CapacityLease | null = null;
      try {
        let claim: RunAttemptClaim;
        try {
          claim = await input.repository.claimSubmission({
            tenantId: command.tenant_id,
            runId: command.payload.run_id,
            leaseTtlMs: input.attemptLeaseMs,
          });
        } catch (error) {
          if (databaseCode(error) === "P0002") {
            await delivery.deadLetter("RUN_COMMAND_NOT_FOUND");
            settled = true;
            return;
          }
          throw error;
        }

        if (claim.disposition === "terminal") {
          await delivery.complete();
          settled = true;
          return;
        }
        if (claim.disposition === "busy" || claim.disposition === "not_claimable") {
          await delivery.abandon();
          settled = true;
          return;
        }
        if (claim.disposition === "reconciliation_required") {
          await input.repository.scheduleReconciliation({
            tenantId: command.tenant_id,
            runId: command.payload.run_id,
            reasonCode:
              command.topic === "jobs.cancel"
                ? "cancellation_requested"
                : "submission_outcome_uncertain",
          });
          await delivery.complete();
          settled = true;
          return;
        }

        const ownership = ownedClaim(claim);
        const cancellationRequested = claim.cancellationRequested || command.topic === "jobs.cancel";
        if (cancellationRequested) {
          await cancelOwnedRun({
            repository: input.repository,
            tenantId: command.tenant_id,
            runId: command.payload.run_id,
            runStateVersion: claim.runStateVersion,
            attemptId: ownership.attemptId,
            fenceToken: ownership.fenceToken,
          });
          await delivery.complete();
          settled = true;
          return;
        }

        lease = await input.leaseStore.acquire(command.payload.run_id, input.capacityLeaseMs);
        if (lease === null) {
          await delivery.abandon();
          settled = true;
          return;
        }

        let stateVersion = claim.runStateVersion;
        let submitted;
        try {
          submitted = await input.repository.transition({
            tenantId: command.tenant_id,
            runId: command.payload.run_id,
            expectedStateVersion: stateVersion,
            toInternalStatus: "SUBMITTED",
            eventType: "submitted",
            eventIdempotencyKey: `job.submitted.v1:${ownership.attemptId}`,
            attemptId: ownership.attemptId,
            fenceToken: ownership.fenceToken,
            safePayload: { status: "running" },
          });
        } catch (error) {
          if (databaseCode(error) !== "P0001") throw error;
          await cancelOwnedRun({
            repository: input.repository,
            tenantId: command.tenant_id,
            runId: command.payload.run_id,
            runStateVersion: stateVersion,
            attemptId: ownership.attemptId,
            fenceToken: ownership.fenceToken,
          });
          await delivery.complete();
          settled = true;
          return;
        }
        stateVersion = submitted.stateVersion;

        await runWithRenewal({
          work: async (signal) => {
            const executionInput = {
              tenantId: command.tenant_id,
              runId: command.payload.run_id,
              attemptId: ownership.attemptId,
              fenceToken: ownership.fenceToken,
              signal,
            } as const;
            try {
              await input.executor.persistRaw(executionInput);
            } catch (error) {
              if (error instanceof RunExecutionReconciliationError) {
                if (!(await input.repository.finish({
                  tenantId: command.tenant_id, attemptId: ownership.attemptId,
                  fenceToken: ownership.fenceToken, state: "ambiguous",
                  outcomeClass: "submission_outcome_uncertain",
                }))) throw new Error("RUN_ATTEMPT_FINISH_REJECTED");
                await input.repository.scheduleReconciliation({
                  tenantId: command.tenant_id, runId: command.payload.run_id,
                  reasonCode: "submission_outcome_uncertain",
                });
                return;
              }
              if (error instanceof RunExecutionCancellationError) {
                await cancelOwnedRun({
                  repository: input.repository,
                  tenantId: command.tenant_id,
                  runId: command.payload.run_id,
                  runStateVersion: stateVersion,
                  attemptId: ownership.attemptId,
                  fenceToken: ownership.fenceToken,
                });
                return;
              }
              if (error instanceof RunExecutionTerminalError) {
                const failed = await input.repository.transition({
                  tenantId: command.tenant_id,
                  runId: command.payload.run_id,
                  expectedStateVersion: stateVersion,
                  toInternalStatus: "UPSTREAM_FAILED",
                  eventType: "failed",
                  eventIdempotencyKey: `job.provider-failed.v1:${ownership.attemptId}`,
                  attemptId: ownership.attemptId,
                  fenceToken: ownership.fenceToken,
                  customerErrorCode: error.customerErrorCode,
                  retryable: error.retryable,
                  safePayload: { status: "failed", code: error.customerErrorCode },
                });
                stateVersion = failed.stateVersion;
                if (
                  !(await input.repository.finish({
                    tenantId: command.tenant_id,
                    attemptId: ownership.attemptId,
                    fenceToken: ownership.fenceToken,
                    state: error.attemptState,
                    outcomeClass: error.outcomeClass,
                  }))
                ) {
                  throw new Error("RUN_ATTEMPT_FINISH_REJECTED");
                }
                return;
              }
              throw error;
            }

            let transition = await input.repository.transition({
              tenantId: command.tenant_id,
              runId: command.payload.run_id,
              expectedStateVersion: stateVersion,
              toInternalStatus: "RESULT_RECEIVED",
              eventType: "result_received",
              eventIdempotencyKey: `job.result-received.v1:${ownership.attemptId}`,
              attemptId: ownership.attemptId,
              fenceToken: ownership.fenceToken,
              safePayload: { status: "running" },
            });
            stateVersion = transition.stateVersion;

            transition = await input.repository.transition({
              tenantId: command.tenant_id,
              runId: command.payload.run_id,
              expectedStateVersion: stateVersion,
              toInternalStatus: "PROCESSING",
              eventType: "processing",
              eventIdempotencyKey: `job.processing.v1:${ownership.attemptId}`,
              attemptId: ownership.attemptId,
              fenceToken: ownership.fenceToken,
              safePayload: { status: "running" },
            });
            stateVersion = transition.stateVersion;

            let normalized;
            try {
              normalized = await input.executor.persistNormalized(executionInput);
            } catch (error) {
              if (!(error instanceof RunExecutionTerminalError)) throw error;
              const failed = await input.repository.transition({
                tenantId: command.tenant_id,
                runId: command.payload.run_id,
                expectedStateVersion: stateVersion,
                toInternalStatus: "PROCESSING_FAILED",
                eventType: "failed",
                eventIdempotencyKey: `job.processing-failed.v1:${ownership.attemptId}`,
                attemptId: ownership.attemptId,
                fenceToken: ownership.fenceToken,
                customerErrorCode: error.customerErrorCode,
                retryable: error.retryable,
                safePayload: { status: "failed", code: error.customerErrorCode },
              });
              stateVersion = failed.stateVersion;
              if (!(await input.repository.finish({
                tenantId: command.tenant_id,
                attemptId: ownership.attemptId,
                fenceToken: ownership.fenceToken,
                state: "failed",
                outcomeClass: error.outcomeClass,
              }))) throw new Error("RUN_ATTEMPT_FINISH_REJECTED");
              return;
            }

            transition = await input.repository.completeSuccess({
              tenantId: command.tenant_id,
              runId: command.payload.run_id,
              expectedStateVersion: stateVersion,
              eventIdempotencyKey: `job.completed.v1:${ownership.attemptId}`,
              attemptId: ownership.attemptId,
              fenceToken: ownership.fenceToken,
              outcomeClass: input.executor.completionOutcomeClass,
              normalizedArtifactId: normalized.artifactId,
              usage: normalized.usage,
              safePayload: { status: "ready" },
            });
            stateVersion = transition.stateVersion;
          },
          delivery,
          repository: input.repository,
          leaseStore: input.leaseStore,
          lease,
          tenantId: command.tenant_id,
          attemptId: ownership.attemptId,
          fenceToken: ownership.fenceToken,
          attemptLeaseMs: input.attemptLeaseMs,
          capacityLeaseMs: input.capacityLeaseMs,
          renewIntervalMs: input.renewIntervalMs,
        });
        await delivery.complete();
        settled = true;
      } catch (error) {
        if (!settled) {
          await delivery.abandon();
          settled = true;
        }
        throw error;
      } finally {
        if (lease !== null) await input.leaseStore.release(lease);
      }
    },
  };
}
