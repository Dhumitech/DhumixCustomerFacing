import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createCsrfService } from "../../src/helpers/csrf.js";
import {
  canonicalizeRunCancellation,
  canonicalizeRunRetry,
  runCancellationRequestHash,
  runRetryRequestHash,
} from "../../src/helpers/runActionCanonicalization.js";
import type { RunAccepted } from "../../src/services/admission/createRunRepository.js";
import {
  RunRetryCapacityExceededError,
  RunRetryInputRejectedError,
  RunRetryNotFoundError,
  RunRetryStateConflictError,
  RunRetryUnavailableError,
  type RetryRunRepository,
} from "../../src/services/admission/retryRunRepository.js";
import { createRetryRunService } from "../../src/services/admission/retryRunService.js";

const tenantId = randomUUID();
const userId = randomUUID();
const sessionId = randomUUID();
const sourceRunId = randomUUID();
const csrf = createCsrfService("test-access-token-secret-at-least-32-chars");
const accepted: RunAccepted = {
  run_id: randomUUID(),
  status: "queued",
  accepted_at: "2026-08-25T12:00:00.000Z",
};

function request() {
  return {
    principal: { kind: "browser" as const, tenantId, userId, sessionId },
    csrfToken: csrf.issue(sessionId),
    idempotencyKey: "retry-run-unit-key-0001",
    runId: sourceRunId.toUpperCase(),
    bodyPresent: false,
    schemaErrors: [],
    requestId: randomUUID(),
    ipFingerprint: Buffer.alloc(32, 3),
  };
}

function service(repository: RetryRunRepository) {
  return createRetryRunService({
    repository,
    validator: {
      validate() {
        return { valid: true, schemaHash: Buffer.alloc(32, 7) };
      },
    },
    csrf,
    providerEnvironment: "test",
    createId: () => randomUUID(),
  });
}

describe("retry Run service", () => {
  it("canonicalizes the source and persists only trusted Tenant/actor context", async () => {
    const persist = vi.fn<RetryRunRepository["persist"]>(async () => ({
      kind: "created",
      run: accepted,
    }));

    await expect(service({ persist }).retry(request())).resolves.toEqual(accepted);
    expect(persist).toHaveBeenCalledOnce();
    expect(persist.mock.calls[0]?.[0]).toMatchObject({
      tenantId,
      sourceRunId,
      actor: { kind: "browser", userId },
      idempotencyKey: "retry-run-unit-key-0001",
      providerEnvironment: "test",
    });
  });

  it("allows a scoped API-key principal without browser CSRF", async () => {
    const apiKeyId = randomUUID();
    const persist = vi.fn<RetryRunRepository["persist"]>(async () => ({
      kind: "replay",
      run: accepted,
    }));
    await expect(
      service({ persist }).retry({
        ...request(),
        principal: { kind: "api_key", tenantId, apiKeyId, scopes: ["runs:write"] },
        csrfToken: undefined,
      }),
    ).resolves.toEqual(accepted);
    expect(persist.mock.calls[0]?.[0].actor).toEqual({ kind: "api_key", apiKeyId });
  });

  it("rejects browser CSRF before body and resource semantics", async () => {
    const persist = vi.fn<RetryRunRepository["persist"]>();
    await expect(
      service({ persist }).retry({
        ...request(),
        csrfToken: undefined,
        bodyPresent: true,
        runId: "not-a-run",
      }),
    ).rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });
    expect(persist).not.toHaveBeenCalled();
  });

  it("rejects a body, invalid key and malformed source before persistence", async () => {
    const persist = vi.fn<RetryRunRepository["persist"]>();
    await expect(
      service({ persist }).retry({ ...request(), bodyPresent: true }),
    ).rejects.toMatchObject({ status: 400, code: "BAD_REQUEST" });
    await expect(
      service({ persist }).retry({ ...request(), idempotencyKey: "short" }),
    ).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });
    await expect(
      service({ persist }).retry({
        ...request(),
        runId: "not-a-uuid",
        schemaErrors: [{ field: "/run_id", message: "must match format uuid" }],
      }),
    ).rejects.toMatchObject({ status: 404, code: "RESOURCE_NOT_FOUND" });
    expect(persist).not.toHaveBeenCalled();
  });

  it.each([
    [new RunRetryNotFoundError(), 404, "RESOURCE_NOT_FOUND"],
    [new RunRetryStateConflictError(), 409, "STATE_CONFLICT"],
    [new RunRetryInputRejectedError([{ field: "/query", message: "is required" }]), 422, "SERVICE_INPUT_INVALID"],
    [new RunRetryCapacityExceededError(), 429, "PLATFORM_CAPACITY_LIMIT"],
    [new RunRetryUnavailableError(), 503, "SERVICE_UNAVAILABLE"],
  ])("maps a repository domain failure to its public Problem", async (error, status, code) => {
    const target = service({ async persist() { throw error; } });
    await expect(target.retry(request())).rejects.toMatchObject({ status, code });
  });

  it("maps an idempotency mismatch to the stable conflict", async () => {
    const target = service({ async persist() { return { kind: "conflict" }; } });
    await expect(target.retry(request())).rejects.toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
    });
  });

  it("keeps retry hashes canonical, source-sensitive and distinct from cancel", () => {
    const first = canonicalizeRunRetry(sourceRunId.toUpperCase());
    const second = canonicalizeRunRetry(sourceRunId);
    const other = canonicalizeRunRetry(randomUUID());
    const cancellation = canonicalizeRunCancellation(sourceRunId);
    expect(first && second && other && cancellation).toBeDefined();
    if (first === undefined || second === undefined || other === undefined || cancellation === undefined) return;

    expect(runRetryRequestHash(first)).toEqual(runRetryRequestHash(second));
    expect(runRetryRequestHash(first)).not.toEqual(runRetryRequestHash(other));
    expect(runRetryRequestHash(first)).not.toEqual(
      runCancellationRequestHash(cancellation),
    );
  });
});
