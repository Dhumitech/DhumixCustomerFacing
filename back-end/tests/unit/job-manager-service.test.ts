import { describe, expect, it, vi } from "vitest";
import type { CapacityLeaseStore } from "../../src/services/jobs/capacityLease.js";
import type { ControlledRunExecutor } from "../../src/services/jobs/controlledRunExecutor.js";
import {
  RunExecutionCancellationError,
  RunExecutionTerminalError,
  RunExecutionReconciliationError,
} from "../../src/services/jobs/controlledRunExecutor.js";
import type { JobCommandDelivery } from "../../src/services/jobs/executionQueue.js";
import type { JobCommandEnvelope } from "../../src/services/jobs/jobCommand.js";
import { createJobManagerService } from "../../src/services/jobs/jobManagerService.js";
import type {
  RunAttemptClaim,
  RunExecutionRepository,
} from "../../src/services/jobs/runExecutionRepository.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const fenceToken = "44444444-4444-4444-8444-444444444444";

function command(
  topic: "jobs.execute" | "jobs.cancel" | "jobs.reconcile" | "jobs.recover" = "jobs.execute",
): JobCommandEnvelope {
  return {
    event_id: "55555555-5555-4555-8555-555555555555",
    topic,
    schema_version: 1,
    aggregate_type: "run",
    aggregate_id: runId,
    tenant_id: tenantId,
    ordering_key: runId,
    payload: { run_id: runId },
  };
}

function delivery(
  topic: "jobs.execute" | "jobs.cancel" | "jobs.reconcile" | "jobs.recover" = "jobs.execute",
): JobCommandDelivery {
  return {
    command: command(topic),
    deliveryCount: 1,
    renewLock: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined),
    abandon: vi.fn(async () => undefined),
    deadLetter: vi.fn(async () => undefined),
  };
}

function claim(
  disposition: RunAttemptClaim["disposition"] = "claimed",
): RunAttemptClaim {
  const owns = disposition === "claimed" || disposition === "recovered";
  return {
    disposition,
    attemptId: owns ? attemptId : null,
    attemptNumber: owns ? 1 : null,
    fenceToken: owns ? fenceToken : null,
    leaseExpiresAt: owns ? new Date(Date.now() + 60_000) : null,
    runStateVersion: 0,
    runInternalStatus: disposition === "reconciliation_required" ? "SUBMITTED" : "QUEUED",
    executionEnabled: true,
    cancellationRequested: false,
  };
}

function dependencies(options: {
  readonly claim?: RunAttemptClaim;
  readonly reconciliationClaim?: RunAttemptClaim;
  readonly reconciliationEvidence?: {
    readonly sourceAttemptId: string;
    readonly hasRawArtifact: boolean;
    readonly hasNormalizedArtifact: boolean;
  };
  readonly events?: string[];
  readonly executorError?: Error;
  readonly recoverRaw?: boolean;
  readonly recoverRawError?: Error;
  readonly executorOutcomeClass?: string;
  readonly normalizedUsage?: {
    readonly meterCode: string;
    readonly unit: string;
  } | null;
} = {}): {
  readonly repository: RunExecutionRepository;
  readonly leaseStore: CapacityLeaseStore;
  readonly executor: ControlledRunExecutor;
} {
  const events = options.events ?? [];
  const repository: RunExecutionRepository = {
    claimSubmission: vi.fn(async () => options.claim ?? claim()),
    claimReconciliation: vi.fn(async () =>
      options.reconciliationClaim ?? { ...claim(), runInternalStatus: "SUBMITTED" },
    ),
    scheduleReconciliation: vi.fn(async () => ({
      commandEventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      scheduled: true,
    })),
    inspectReconciliation: vi.fn(async () =>
      options.reconciliationEvidence ?? {
        sourceAttemptId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        hasRawArtifact: false,
        hasNormalizedArtifact: false,
      },
    ),
    completeReconciliation: vi.fn(async (input) => {
      events.push(`transition:${input.toInternalStatus}`);
      events.push("finish:completed");
      return {
        stateVersion: input.expectedStateVersion + 1,
        internalStatus: input.toInternalStatus,
        publicStatus: input.toInternalStatus === "COMPLETED" ? "ready" : "failed",
      };
    }),
    completeSuccess: vi.fn(async (input) => {
      events.push("transition:COMPLETED");
      events.push("finish:completed");
      return {
        stateVersion: input.expectedStateVersion + 1,
        internalStatus: "COMPLETED",
        publicStatus: "ready",
      };
    }),
    completeReconciliationSuccess: vi.fn(async (input) => {
      events.push("transition:COMPLETED");
      events.push("finish:completed");
      return {
        stateVersion: input.expectedStateVersion + 1,
        internalStatus: "COMPLETED",
        publicStatus: "ready",
      };
    }),
    renew: vi.fn(async () => new Date(Date.now() + 60_000)),
    transition: vi.fn(async (input) => {
      events.push(`transition:${input.toInternalStatus}`);
      return {
        stateVersion: input.expectedStateVersion + 1,
        internalStatus: input.toInternalStatus,
        publicStatus: input.toInternalStatus === "COMPLETED" ? "ready" : "running",
      };
    }),
    finish: vi.fn(async (input) => {
      events.push(`finish:${input.state}`);
      return true;
    }),
  };
  const leaseStore: CapacityLeaseStore = {
    acquire: vi.fn(async () => ({ resourceId: runId, token: "lease-token" })),
    renew: vi.fn(async () => true),
    release: vi.fn(async () => true),
    close: vi.fn(async () => undefined),
  };
  const executor: ControlledRunExecutor = {
    completionOutcomeClass: options.executorOutcomeClass ?? "controlled_execution_completed",
    persistRaw: vi.fn(async () => {
      events.push("executor:raw");
      if (options.executorError !== undefined) throw options.executorError;
      return { artifactId: "99999999-9999-4999-8999-999999999999" };
    }),
    persistNormalized: vi.fn(async () => {
      events.push("executor:normalized");
      return {
        artifactId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        usage: options.normalizedUsage ?? null,
      };
    }),
    ...(options.recoverRaw === undefined && options.recoverRawError === undefined
      ? {}
      : {
          recoverRaw: vi.fn(async () => {
            events.push("executor:recover-raw");
            if (options.recoverRawError !== undefined) throw options.recoverRawError;
            return options.recoverRaw as boolean;
          }),
        }),
  };
  return { repository, leaseStore, executor };
}

function service(parts: ReturnType<typeof dependencies>) {
  return createJobManagerService({
    ...parts,
    attemptLeaseMs: 60_000,
    capacityLeaseMs: 60_000,
    renewIntervalMs: 20_000,
  });
}

describe("JobManagerService", () => {
  it("durably marks an ambiguous submission and schedules recovery without normalization", async () => {
    const parts = dependencies({ executorError: new RunExecutionReconciliationError() });
    const message = delivery();
    await service(parts).handle(message);
    expect(parts.repository.finish).toHaveBeenCalledWith(expect.objectContaining({ state: "ambiguous" }));
    expect(parts.repository.scheduleReconciliation).toHaveBeenCalledOnce();
    expect(parts.executor.persistRaw).toHaveBeenCalledOnce();
    expect(parts.executor.persistNormalized).not.toHaveBeenCalled();
    expect(message.complete).toHaveBeenCalledOnce();
  });
  it.each(["jobs.execute", "jobs.reconcile"] as const)(
    "terminalizes error-only normalization during %s without admitting more work",
    async (topic) => {
      const parts = dependencies({
        reconciliationClaim: { ...claim(), runInternalStatus: "PROCESSING" },
        reconciliationEvidence: { sourceAttemptId: attemptId, hasRawArtifact: true, hasNormalizedArtifact: false },
      });
      vi.mocked(parts.executor.persistNormalized).mockRejectedValue(new RunExecutionTerminalError({
        customerErrorCode: "UPSTREAM_FAILED", retryable: false,
        outcomeClass: "provider_response_invalid", attemptState: "failed",
      }));
      const message = delivery(topic);
      await expect(service(parts).handle(message)).resolves.toBeUndefined();
      const finalizer = topic === "jobs.execute"
        ? parts.repository.transition : parts.repository.completeReconciliation;
      expect(finalizer).toHaveBeenCalledWith(expect.objectContaining({
        toInternalStatus: "PROCESSING_FAILED", customerErrorCode: "UPSTREAM_FAILED", retryable: false,
      }));
      expect(parts.repository.completeSuccess).not.toHaveBeenCalled();
      expect(parts.repository.completeReconciliationSuccess).not.toHaveBeenCalled();
      expect(message.complete).toHaveBeenCalledOnce();
      expect(message.abandon).not.toHaveBeenCalled();
      expect(parts.leaseStore.release).toHaveBeenCalledOnce();
    },
  );
  it("stores raw bytes before RESULT_RECEIVED and normalized bytes during PROCESSING", async () => {
    const events: string[] = [];
    const parts = dependencies({ events });
    const message = delivery();

    await service(parts).handle(message);

    expect(events).toEqual([
      "transition:SUBMITTED",
      "executor:raw",
      "transition:RESULT_RECEIVED",
      "transition:PROCESSING",
      "executor:normalized",
      "transition:COMPLETED",
      "finish:completed",
    ]);
    expect(parts.repository.completeSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        normalizedArtifactId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        usage: null,
      }),
    );
    expect(parts.repository.transition).not.toHaveBeenCalledWith(
      expect.objectContaining({ toInternalStatus: "COMPLETED" }),
    );
    expect(message.complete).toHaveBeenCalledOnce();
    expect(message.abandon).not.toHaveBeenCalled();
    expect(parts.leaseStore.release).toHaveBeenCalledOnce();
  });

  it.each(["terminal", "busy", "not_claimable"] as const)(
    "settles a %s duplicate safely without executing it",
    async (disposition) => {
      const parts = dependencies({ claim: claim(disposition) });
      const message = delivery();

      await service(parts).handle(message);

      if (disposition === "terminal") expect(message.complete).toHaveBeenCalledOnce();
      else expect(message.abandon).toHaveBeenCalledOnce();
      expect(parts.executor.persistRaw).not.toHaveBeenCalled();
      expect(parts.leaseStore.acquire).not.toHaveBeenCalled();
    },
  );

  it("honors durable cancellation before controlled execution", async () => {
    const cancellation = { ...claim(), cancellationRequested: true };
    const parts = dependencies({ claim: cancellation });
    const message = delivery("jobs.cancel");

    await service(parts).handle(message);

    expect(parts.repository.transition).toHaveBeenCalledWith(
      expect.objectContaining({ toInternalStatus: "CANCELLED", fenceToken }),
    );
    expect(parts.executor.persistRaw).not.toHaveBeenCalled();
    expect(parts.repository.finish).toHaveBeenCalledWith(
      expect.objectContaining({ state: "completed", outcomeClass: "cancelled_before_execution" }),
    );
    expect(message.complete).toHaveBeenCalledOnce();
  });

  it("honors cancellation that wins after claim but before SUBMITTED", async () => {
    const parts = dependencies();
    const cancelled = Object.assign(new Error("RUN_CANCELLATION_REQUESTED"), { code: "P0001" });
    vi.mocked(parts.repository.transition)
      .mockRejectedValueOnce(cancelled)
      .mockResolvedValueOnce({
        stateVersion: 1,
        internalStatus: "CANCELLED",
        publicStatus: "cancelled",
      });
    const message = delivery();

    await service(parts).handle(message);

    expect(parts.repository.transition).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ toInternalStatus: "CANCELLED", fenceToken }),
    );
    expect(parts.executor.persistRaw).not.toHaveBeenCalled();
    expect(parts.repository.finish).toHaveBeenCalledWith(
      expect.objectContaining({ outcomeClass: "cancelled_before_execution" }),
    );
    expect(message.complete).toHaveBeenCalledOnce();
    expect(parts.leaseStore.release).toHaveBeenCalledOnce();
  });

  it("abandons transient execution failure and always releases the Redis lease", async () => {
    const parts = dependencies({ executorError: new Error("storage unavailable") });
    const message = delivery();

    await expect(service(parts).handle(message)).rejects.toThrow("storage unavailable");

    expect(message.abandon).toHaveBeenCalledOnce();
    expect(message.complete).not.toHaveBeenCalled();
    expect(parts.leaseStore.release).toHaveBeenCalledOnce();
  });

  it("commits a safe terminal provider failure without queue redelivery", async () => {
    const parts = dependencies({
      executorError: new RunExecutionTerminalError({
        customerErrorCode: "UPSTREAM_REJECTED",
        retryable: false,
        outcomeClass: "provider_request_rejected",
        attemptState: "rejected",
      }),
    });
    const message = delivery();

    await service(parts).handle(message);

    expect(parts.repository.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        toInternalStatus: "UPSTREAM_FAILED",
        customerErrorCode: "UPSTREAM_REJECTED",
        safePayload: { status: "failed", code: "UPSTREAM_REJECTED" },
      }),
    );
    expect(parts.repository.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "rejected",
        outcomeClass: "provider_request_rejected",
      }),
    );
    expect(message.complete).toHaveBeenCalledOnce();
    expect(message.abandon).not.toHaveBeenCalled();
  });

  it("abandons safely when Redis is unavailable before execution authority is used", async () => {
    const parts = dependencies();
    vi.mocked(parts.leaseStore.acquire).mockRejectedValue(new Error("redis unavailable"));
    const message = delivery();

    await expect(service(parts).handle(message)).rejects.toThrow("redis unavailable");

    expect(parts.repository.transition).not.toHaveBeenCalled();
    expect(parts.executor.persistRaw).not.toHaveBeenCalled();
    expect(message.abandon).toHaveBeenCalledOnce();
    expect(message.complete).not.toHaveBeenCalled();
  });

  it("lets a completed Run settle a redelivery after message completion fails", async () => {
    const parts = dependencies();
    const first = delivery();
    vi.mocked(first.complete).mockRejectedValueOnce(new Error("queue settlement unavailable"));

    await expect(service(parts).handle(first)).rejects.toThrow("queue settlement unavailable");
    expect(parts.repository.completeSuccess).toHaveBeenCalledOnce();
    expect(first.abandon).toHaveBeenCalledOnce();

    const terminalParts = dependencies({ claim: claim("terminal") });
    const redelivery = delivery();
    await service(terminalParts).handle(redelivery);

    expect(redelivery.complete).toHaveBeenCalledOnce();
    expect(terminalParts.executor.persistRaw).not.toHaveBeenCalled();
  });

  it("dead-letters forged or stale Run identity without disclosing the resource", async () => {
    const parts = dependencies();
    const notFound = Object.assign(new Error("RUN_NOT_FOUND"), { code: "P0002" });
    vi.mocked(parts.repository.claimSubmission).mockRejectedValue(notFound);
    const message = delivery();

    await service(parts).handle(message);

    expect(message.deadLetter).toHaveBeenCalledWith("RUN_COMMAND_NOT_FOUND");
    expect(parts.executor.persistRaw).not.toHaveBeenCalled();
  });

  it("does not blindly re-execute a submitted Run that requires reconciliation", async () => {
    const parts = dependencies({ claim: claim("reconciliation_required") });
    const message = delivery();

    await service(parts).handle(message);

    expect(parts.repository.scheduleReconciliation).toHaveBeenCalledWith({
      tenantId,
      runId,
      reasonCode: "submission_outcome_uncertain",
    });
    expect(message.complete).toHaveBeenCalledOnce();
    expect(message.deadLetter).not.toHaveBeenCalled();
    expect(parts.executor.persistRaw).not.toHaveBeenCalled();
  });

  it("recovers a submitted Run from a durable raw Artifact without repeating submission", async () => {
    const events: string[] = [];
    const parts = dependencies({
      events,
      reconciliationEvidence: {
        sourceAttemptId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        hasRawArtifact: true,
        hasNormalizedArtifact: false,
      },
    });
    const message = delivery("jobs.reconcile");

    await service(parts).handle(message);

    expect(parts.repository.claimSubmission).not.toHaveBeenCalled();
    expect(parts.repository.claimReconciliation).toHaveBeenCalledOnce();
    expect(parts.executor.persistRaw).not.toHaveBeenCalled();
    expect(parts.executor.persistNormalized).toHaveBeenCalledOnce();
    expect(events).toEqual([
      "transition:RESULT_RECEIVED",
      "transition:PROCESSING",
      "executor:normalized",
      "transition:COMPLETED",
      "finish:completed",
    ]);
    expect(parts.repository.completeReconciliationSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        normalizedArtifactId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        sourceAttemptId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        usage: null,
      }),
    );
    expect(message.complete).toHaveBeenCalledOnce();
  });

  it("resumes a protected provider snapshot during reconciliation without another submission", async () => {
    const events: string[] = [];
    const parts = dependencies({ events, recoverRaw: true });
    const message = delivery("jobs.reconcile");

    await service(parts).handle(message);

    expect(parts.executor.recoverRaw).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        runId,
        attemptId,
        fenceToken,
        sourceAttemptId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      }),
    );
    expect(parts.executor.persistRaw).not.toHaveBeenCalled();
    expect(events).toEqual([
      "executor:recover-raw",
      "transition:RESULT_RECEIVED",
      "transition:PROCESSING",
      "executor:normalized",
      "transition:COMPLETED",
      "finish:completed",
    ]);
    expect(message.complete).toHaveBeenCalledOnce();
  });

  it("closes reconciliation when the provider confirms a terminal snapshot failure", async () => {
    const terminal = new RunExecutionTerminalError({
      customerErrorCode: "UPSTREAM_FAILED",
      retryable: true,
      outcomeClass: "provider_snapshot_timeout",
      attemptState: "failed",
    });
    const parts = dependencies({
      recoverRawError: terminal,
      executorOutcomeClass: "provider_execution_completed",
    });
    const message = delivery("jobs.reconcile");

    await service(parts).handle(message);

    expect(parts.repository.completeReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        toInternalStatus: "UPSTREAM_FAILED",
        sourceOutcomeClass: "provider_snapshot_timeout",
        reconciliationOutcomeClass: "provider_reconciliation_failed",
        customerErrorCode: "UPSTREAM_FAILED",
        retryable: true,
      }),
    );
    expect(message.complete).toHaveBeenCalledOnce();
    expect(message.abandon).not.toHaveBeenCalled();
  });

  it("closes reconciliation when provider cancellation is observed during polling", async () => {
    const parts = dependencies({
      recoverRawError: new RunExecutionCancellationError(),
      executorOutcomeClass: "provider_execution_completed",
    });
    const message = delivery("jobs.reconcile");

    await service(parts).handle(message);

    expect(parts.repository.completeReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        toInternalStatus: "CANCELLED",
        sourceOutcomeClass: "provider_snapshot_cancelled",
        reconciliationOutcomeClass: "provider_reconciliation_cancelled",
      }),
    );
    expect(message.complete).toHaveBeenCalledOnce();
    expect(message.abandon).not.toHaveBeenCalled();
  });

  it("resumes reconciliation from RESULT_RECEIVED without repeating that transition", async () => {
    const events: string[] = [];
    const parts = dependencies({
      events,
      reconciliationClaim: { ...claim(), runInternalStatus: "RESULT_RECEIVED", runStateVersion: 2 },
      reconciliationEvidence: {
        sourceAttemptId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        hasRawArtifact: true,
        hasNormalizedArtifact: false,
      },
    });
    const message = delivery("jobs.reconcile");

    await service(parts).handle(message);

    expect(events).toEqual([
      "transition:PROCESSING",
      "executor:normalized",
      "transition:COMPLETED",
      "finish:completed",
    ]);
    expect(message.complete).toHaveBeenCalledOnce();
  });

  it("resumes reconciliation from PROCESSING and deterministically verifies existing normalization", async () => {
    const events: string[] = [];
    const parts = dependencies({
      events,
      reconciliationClaim: { ...claim(), runInternalStatus: "PROCESSING", runStateVersion: 3 },
      reconciliationEvidence: {
        sourceAttemptId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        hasRawArtifact: true,
        hasNormalizedArtifact: true,
      },
    });
    const message = delivery("jobs.reconcile");

    await service(parts).handle(message);

    expect(parts.executor.persistRaw).not.toHaveBeenCalled();
    expect(parts.executor.persistNormalized).toHaveBeenCalledOnce();
    expect(events).toEqual([
      "executor:normalized",
      "transition:COMPLETED",
      "finish:completed",
    ]);
    expect(message.complete).toHaveBeenCalledOnce();
  });

  it("passes the normalized usage observation into atomic completion", async () => {
    const parts = dependencies({
      normalizedUsage: {
        meterCode: "amazon.result_records.observed",
        unit: "records",
      },
    });

    await service(parts).handle(delivery());

    expect(parts.repository.completeSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        normalizedArtifactId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        usage: {
          meterCode: "amazon.result_records.observed",
          unit: "records",
        },
      }),
    );
    expect(parts.repository.finish).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: "completed" }),
    );
  });

  it("fails safely and retryably when controlled reconciliation confirms no durable result", async () => {
    const events: string[] = [];
    const parts = dependencies({ events });
    const message = delivery("jobs.reconcile");

    await service(parts).handle(message);

    expect(parts.executor.persistRaw).not.toHaveBeenCalled();
    expect(parts.executor.persistNormalized).not.toHaveBeenCalled();
    expect(parts.repository.completeReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceAttemptState: "failed",
        sourceOutcomeClass: "reconciled_no_durable_result",
        toInternalStatus: "UPSTREAM_FAILED",
        customerErrorCode: "EXECUTION_OUTCOME_UNCERTAIN",
        retryable: true,
      }),
    );
    expect(message.complete).toHaveBeenCalledOnce();
  });

  it("honors cancellation intent during reconciliation", async () => {
    const parts = dependencies({
      reconciliationClaim: { ...claim(), cancellationRequested: true, runInternalStatus: "SUBMITTED" },
    });
    const message = delivery("jobs.reconcile");

    await service(parts).handle(message);

    expect(parts.repository.completeReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        toInternalStatus: "CANCELLED",
        sourceAttemptState: "failed",
        sourceOutcomeClass: "cancelled_during_reconciliation",
      }),
    );
    expect(parts.executor.persistRaw).not.toHaveBeenCalled();
    expect(message.complete).toHaveBeenCalledOnce();
  });
});
