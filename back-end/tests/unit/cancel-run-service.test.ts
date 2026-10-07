import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createCsrfService } from "../../src/helpers/csrf.js";
import {
  canonicalizeRunCancellation,
  runCancellationRequestHash,
} from "../../src/helpers/runActionCanonicalization.js";
import {
  RunCancellationNotFoundError,
  RunCancellationStateConflictError,
  RunCancellationUnavailableError,
  type CancelRunRepository,
} from "../../src/services/admission/cancelRunRepository.js";
import { createCancelRunService } from "../../src/services/admission/cancelRunService.js";

const tenantId = randomUUID();
const userId = randomUUID();
const sessionId = randomUUID();
const runId = randomUUID();
const serviceId = randomUUID();
const csrf = createCsrfService("test-access-token-secret-at-least-32-chars");
const accepted = {
  id: runId,
  service_id: serviceId,
  status: "queued" as const,
  error_code: null,
  retryable: false,
  created_at: "2026-08-25T12:00:00.000Z",
  updated_at: "2026-08-25T12:00:00.000Z",
  completed_at: null,
};

function request() {
  return {
    principal: { kind: "browser" as const, tenantId, userId, sessionId },
    csrfToken: csrf.issue(sessionId),
    idempotencyKey: "cancel-run-unit-key-0001",
    runId: runId.toUpperCase(),
    bodyPresent: false,
    schemaErrors: [],
    requestId: randomUUID(),
    ipFingerprint: Buffer.alloc(32, 2),
  };
}

function service(repository: CancelRunRepository) {
  return createCancelRunService({
    repository,
    csrf,
    createId: () => randomUUID(),
  });
}

describe("cancel Run service", () => {
  it("canonicalizes the Run and persists only trusted Tenant/actor context", async () => {
    const persist = vi.fn<CancelRunRepository["persist"]>(async () => ({
      kind: "accepted",
      run: accepted,
    }));

    await expect(service({ persist }).cancel(request())).resolves.toEqual(accepted);
    expect(persist).toHaveBeenCalledOnce();
    expect(persist.mock.calls[0]?.[0]).toMatchObject({
      tenantId,
      actor: { kind: "browser", userId },
      runId,
      idempotencyKey: "cancel-run-unit-key-0001",
    });
  });

  it.each([undefined, csrf.issue(sessionId)])("rejects API-key actors regardless of CSRF (%s)", async (csrfToken) => {
    const persist = vi.fn<CancelRunRepository["persist"]>();
    await expect(
      service({ persist }).cancel({
        ...request(),
        principal: { kind: "api_key", tenantId, apiKeyId: randomUUID() } as unknown as ReturnType<typeof request>["principal"],
        csrfToken,
      }),
    ).rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });
    expect(persist).not.toHaveBeenCalled();
  });

  it("rejects browser CSRF before body and resource validation", async () => {
    const persist = vi.fn<CancelRunRepository["persist"]>();
    await expect(
      service({ persist }).cancel({
        ...request(),
        csrfToken: undefined,
        bodyPresent: true,
        runId: "not-a-run",
      }),
    ).rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });
    expect(persist).not.toHaveBeenCalled();
  });

  it("rejects every supplied body and invalid idempotency input", async () => {
    const persist = vi.fn<CancelRunRepository["persist"]>();
    await expect(
      service({ persist }).cancel({ ...request(), bodyPresent: true }),
    ).rejects.toMatchObject({ status: 400, code: "BAD_REQUEST" });
    await expect(
      service({ persist }).cancel({ ...request(), idempotencyKey: "short" }),
    ).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });
    expect(persist).not.toHaveBeenCalled();
  });

  it("collapses malformed Run identifiers into the generic not-found response", async () => {
    const persist = vi.fn<CancelRunRepository["persist"]>();
    await expect(
      service({ persist }).cancel({
        ...request(),
        runId: "not-a-uuid",
        schemaErrors: [{ field: "/run_id", message: "must match format uuid" }],
      }),
    ).rejects.toMatchObject({ status: 404, code: "RESOURCE_NOT_FOUND" });
    expect(persist).not.toHaveBeenCalled();
  });

  it.each([
    [new RunCancellationNotFoundError(), 404, "RESOURCE_NOT_FOUND"],
    [new RunCancellationStateConflictError(), 409, "STATE_CONFLICT"],
    [new RunCancellationUnavailableError(), 503, "SERVICE_UNAVAILABLE"],
  ])("maps a repository domain failure to its public Problem", async (error, status, code) => {
    const target = service({ async persist() { throw error; } });
    await expect(target.cancel(request())).rejects.toMatchObject({ status, code });
  });

  it("maps an idempotency mismatch without manufacturing persistence", async () => {
    const target = service({ async persist() { return { kind: "conflict" }; } });
    await expect(target.cancel(request())).rejects.toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
    });
  });

  it("keeps cancellation hashes canonical and Run-sensitive", () => {
    const first = canonicalizeRunCancellation(runId.toUpperCase());
    const second = canonicalizeRunCancellation(runId);
    const other = canonicalizeRunCancellation(randomUUID());
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(other).toBeDefined();
    if (first === undefined || second === undefined || other === undefined) return;

    expect(runCancellationRequestHash(first)).toEqual(
      runCancellationRequestHash(second),
    );
    expect(runCancellationRequestHash(first)).not.toEqual(
      runCancellationRequestHash(other),
    );
  });
});
