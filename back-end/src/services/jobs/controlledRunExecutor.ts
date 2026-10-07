import { Readable } from "node:stream";
import type { ResultIngestionService } from "../storage/resultIngestionService.js";

export interface ControlledRunExecutionInput {
  readonly tenantId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly fenceToken: string;
  readonly signal: AbortSignal;
  readonly cancellationRequesterUserId?: string;
}

export interface ControlledRunNormalizationInput extends ControlledRunExecutionInput {
  readonly sourceAttemptId?: string;
}

export interface ControlledRunRecoveryInput extends ControlledRunExecutionInput {
  readonly sourceAttemptId: string;
}

export interface NormalizedUsageObservation {
  readonly meterCode: string;
  readonly unit: string;
}

export interface PersistedNormalizedResult {
  readonly artifactId: string;
  readonly usage: NormalizedUsageObservation | null;
}

export interface ControlledRunExecutor {
  readonly completionOutcomeClass: string;
  persistRaw(input: ControlledRunExecutionInput): Promise<{ readonly artifactId: string }>;
  persistNormalized(input: ControlledRunNormalizationInput): Promise<PersistedNormalizedResult>;
  recoverRaw?(input: ControlledRunRecoveryInput): Promise<boolean>;
}

export class RunExecutionTerminalError extends Error {
  public readonly customerErrorCode: string;
  public readonly retryable: boolean;
  public readonly outcomeClass: string;
  public readonly attemptState: "rejected" | "failed";

  public constructor(input: {
    readonly customerErrorCode: string;
    readonly retryable: boolean;
    readonly outcomeClass: string;
    readonly attemptState: "rejected" | "failed";
    readonly cause?: unknown;
  }) {
    super(
      "Run execution failed with a terminal safe outcome",
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.name = "RunExecutionTerminalError";
    this.customerErrorCode = input.customerErrorCode;
    this.retryable = input.retryable;
    this.outcomeClass = input.outcomeClass;
    this.attemptState = input.attemptState;
  }
}

export class RunExecutionCancellationError extends Error {
  public constructor(cause?: unknown) {
    super(
      "Run execution observed cancellation",
      cause === undefined ? undefined : { cause },
    );
    this.name = "RunExecutionCancellationError";
  }
}

export class RunExecutionReconciliationError extends Error {
  public constructor(cause?: unknown) {
    super("Run execution requires durable reconciliation", cause === undefined ? undefined : { cause });
    this.name = "RunExecutionReconciliationError";
  }
}

function controlledBytes(runId: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      source: "dhumi_pattern4_controlled_executor",
      run_id: runId,
      status: "succeeded",
      items: [],
    }),
    "utf8",
  );
}

export function createSyntheticControlledRunExecutor(
  ingestion: ResultIngestionService,
): ControlledRunExecutor {
  return {
    completionOutcomeClass: "controlled_execution_completed",
    async persistRaw(input): Promise<{ readonly artifactId: string }> {
      input.signal.throwIfAborted();
      const common = {
        tenantId: input.tenantId,
        runId: input.runId,
        attemptId: input.attemptId,
        artifactVersion: 1,
      } as const;
      const raw = await ingestion.ingest({
        identity: { ...common, kind: "raw" },
        bytes: Readable.from([controlledBytes(input.runId)]),
        contentType: "application/json",
        contentEncoding: null,
        schemaVersion: null,
        recordCount: null,
        expiresAt: null,
      });
      return { artifactId: raw.artifactId };
    },
    async persistNormalized(input): Promise<PersistedNormalizedResult> {
      input.signal.throwIfAborted();
      const common = {
        tenantId: input.tenantId,
        runId: input.runId,
        attemptId: input.sourceAttemptId ?? input.attemptId,
        artifactVersion: 1,
      } as const;
      const normalized = await ingestion.ingest({
        identity: { ...common, kind: "normalized" },
        bytes: Readable.from([controlledBytes(input.runId)]),
        contentType: "application/json",
        contentEncoding: null,
        schemaVersion: "pattern4-controlled-v1",
        recordCount: 0,
        expiresAt: null,
      });
      return { artifactId: normalized.artifactId, usage: null };
    },
  };
}
