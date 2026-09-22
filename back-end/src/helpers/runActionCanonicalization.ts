import { canonicalSha256 } from "./canonicalJson.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CanonicalRunCancellation {
  readonly runId: string;
}

export interface CanonicalRunRetry {
  readonly runId: string;
}

export function canonicalizeRunCancellation(
  runId: unknown,
): CanonicalRunCancellation | undefined {
  return typeof runId === "string" && UUID_PATTERN.test(runId)
    ? { runId: runId.toLowerCase() }
    : undefined;
}

export function runCancellationRequestHash(
  request: CanonicalRunCancellation,
): Buffer {
  return canonicalSha256({
    operation: "runs.cancel.v1",
    run_id: request.runId,
  });
}

export function canonicalizeRunRetry(
  runId: unknown,
): CanonicalRunRetry | undefined {
  return typeof runId === "string" && UUID_PATTERN.test(runId)
    ? { runId: runId.toLowerCase() }
    : undefined;
}

export function runRetryRequestHash(request: CanonicalRunRetry): Buffer {
  return canonicalSha256({
    operation: "runs.retry.v1",
    run_id: request.runId,
  });
}
