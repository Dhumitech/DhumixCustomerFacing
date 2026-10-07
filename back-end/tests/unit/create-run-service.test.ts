import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createCsrfService } from "../../src/helpers/csrf.js";
import {
  canonicalizeRunCreate,
  runRequestHash,
} from "../../src/helpers/runCanonicalization.js";
import { serviceActorFingerprint } from "../../src/helpers/serviceCanonicalization.js";
import { tenantActorFingerprint } from "../../src/helpers/tenantActorFingerprint.js";
import {
  RunAdmissionUnavailableError,
  RunCapacityExceededError,
  RunInputRejectedError,
  RunServiceNotFoundError,
  RunServiceStateConflictError,
  type CreateRunRepository,
  type RunAccepted,
} from "../../src/services/admission/createRunRepository.js";
import { createRunService } from "../../src/services/admission/createRunService.js";

const tenantId = randomUUID();
const userId = randomUUID();
const sessionId = randomUUID();
const serviceId = randomUUID();
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
    idempotencyKey: "create-run-unit-key-0001",
    serviceId,
    body: { input: { query: "laptop", country: "US" } },
    schemaErrors: [],
    requestId: randomUUID(),
    ipFingerprint: Buffer.alloc(32, 2),
  };
}

function service(repository: CreateRunRepository) {
  return createRunService({
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

describe("create Run service", () => {
  it.each([undefined, csrf.issue(sessionId)])("rejects API-key actors regardless of CSRF (%s)", async (csrfToken) => {
    const persist = vi.fn<CreateRunRepository["persist"]>();
    await expect(
      service({ persist }).create({
        ...request(),
        principal: { kind: "api_key", tenantId, apiKeyId: randomUUID() } as unknown as ReturnType<typeof request>["principal"],
        csrfToken,
      }),
    ).rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });
    expect(persist).not.toHaveBeenCalled();
  });

  it("canonicalizes path plus input and passes only trusted actor context", async () => {
    const persist = vi.fn<CreateRunRepository["persist"]>(async () => ({
      kind: "created",
      run: accepted,
    }));
    await expect(service({ persist }).create(request())).resolves.toEqual(accepted);

    expect(persist).toHaveBeenCalledOnce();
    expect(persist.mock.calls[0]?.[0]).toMatchObject({
      tenantId,
      actor: { kind: "browser", userId },
      serviceId,
      providerEnvironment: "test",
      input: { query: "laptop", country: "US" },
    });
  });

  it("rejects CSRF and semantic request defects before persistence", async () => {
    const persist = vi.fn<CreateRunRepository["persist"]>();
    await expect(
      service({ persist }).create({ ...request(), csrfToken: undefined }),
    ).rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });
    await expect(
      service({ persist }).create({ ...request(), body: { input: [] } }),
    ).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });
    await expect(
      service({ persist }).create({ ...request(), idempotencyKey: "short" }),
    ).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });
    expect(persist).not.toHaveBeenCalled();
  });

  it.each([
    [new RunServiceNotFoundError(), 404, "RESOURCE_NOT_FOUND"],
    [new RunServiceStateConflictError(), 409, "STATE_CONFLICT"],
    [new RunInputRejectedError([{ field: "/query", message: "is required" }]), 422, "SERVICE_INPUT_INVALID"],
    [new RunCapacityExceededError(), 429, "PLATFORM_CAPACITY_LIMIT"],
    [new RunAdmissionUnavailableError(), 503, "SERVICE_UNAVAILABLE"],
  ])("maps a repository domain failure to its public Problem", async (error, status, code) => {
    const target = service({ async persist() { throw error; } });
    await expect(target.create(request())).rejects.toMatchObject({ status, code });
  });

  it("keeps request hashes canonical and preserves legacy Service fingerprints", () => {
    const first = canonicalizeRunCreate(serviceId.toUpperCase(), {
      input: { b: 2, a: 1 },
    });
    const second = canonicalizeRunCreate(serviceId, {
      input: { a: 1, b: 2 },
    });
    expect(first.valid && second.valid).toBe(true);
    if (!first.valid || !second.valid) return;
    expect(runRequestHash(first.value)).toEqual(runRequestHash(second.value));

    const principal = request().principal;
    const legacyExpected = createHash("sha256")
      .update(`dhumi:service-actor:v1:browser:${userId}`, "utf8")
      .digest();
    expect(serviceActorFingerprint(principal)).toEqual(legacyExpected);
    expect(tenantActorFingerprint(principal)).not.toEqual(legacyExpected);
  });
});
