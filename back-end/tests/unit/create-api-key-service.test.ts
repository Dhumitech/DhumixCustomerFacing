import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  apiKeyEnvelopeAad,
  serializeApiKeyCreated,
  type ApiKeyCreated,
} from "../../src/helpers/apiKeyCanonicalization.js";
import { createCsrfService } from "../../src/helpers/csrf.js";
import type { ResponseEnvelope } from "../../src/helpers/responseEnvelope.js";
import type {
  CreateApiKeyPersistenceInput,
  CreateApiKeyPersistenceOutcome,
  CreateApiKeyRepository,
} from "../../src/services/apiKeys/createApiKeyRepository.js";
import { createApiKeyService } from "../../src/services/apiKeys/createApiKeyService.js";

const identity = {
  userId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  tenantId: "33333333-3333-4333-8333-333333333333",
};
const csrf = createCsrfService("a-secret-long-enough-to-bind-csrf-sessions");
const validCsrf = csrf.issue(identity.sessionId);

class RecordingRepository implements CreateApiKeyRepository {
  public readonly calls: CreateApiKeyPersistenceInput[] = [];
  public outcome: CreateApiKeyPersistenceOutcome = { kind: "created" };

  public async persist(input: CreateApiKeyPersistenceInput) {
    this.calls.push(input);
    return this.outcome;
  }
}

function request() {
  return {
    identity,
    csrfToken: validCsrf,
    idempotencyKey: "create-key-unit-0001",
    body: { name: "  CI key  ", scopes: ["runs:write", "runs:read"] },
    schemaErrors: [],
    requestId: randomUUID(),
    ipFingerprint: null,
  } as const;
}

function envelope(opened?: Buffer): ResponseEnvelope {
  return {
    async seal() {
      return { ciphertext: Buffer.from("ciphertext"), keyReference: "test:v1" };
    },
    async open() {
      if (opened === undefined) throw new Error("open was not expected");
      return opened;
    },
  };
}

function service(repository: RecordingRepository, responseEnvelope = envelope()) {
  const ids = [
    "44444444-4444-4444-8444-444444444444",
    "55555555-5555-4555-8555-555555555555",
  ];
  return createApiKeyService({
    repository,
    csrf,
    responseEnvelope,
    now: () => new Date("2026-08-24T00:00:00.000Z"),
    createId: () => ids.shift() ?? randomUUID(),
    createMaterial: () => ({
      prefix: "dhk_v1_AAAAAAAAAAAAAAAA",
      secret: `dhk_v1_AAAAAAAAAAAAAAAA.${"B".repeat(43)}`,
      hash: Buffer.alloc(32, 9),
    }),
  });
}

describe("createApiKeyService", () => {
  it("creates the exact one-time response without passing plaintext to persistence", async () => {
    const repository = new RecordingRepository();
    const result = await service(repository).create(request());

    expect(result).toEqual({
      id: "55555555-5555-4555-8555-555555555555",
      name: "CI key",
      prefix: "dhk_v1_AAAAAAAAAAAAAAAA",
      scopes: ["runs:read", "runs:write"],
      state: "active",
      created_at: "2026-08-24T00:00:00.000Z",
      last_used_at: null,
      expires_at: null,
      revoked_at: null,
      secret: `dhk_v1_AAAAAAAAAAAAAAAA.${"B".repeat(43)}`,
    });
    expect(repository.calls).toHaveLength(1);
    expect(repository.calls[0]).not.toHaveProperty("secret");
    expect(JSON.stringify(repository.calls[0])).not.toContain(result.secret);
  });

  it("validates CSRF before schema/domain work", async () => {
    const repository = new RecordingRepository();
    await expect(
      service(repository).create({
        ...request(),
        csrfToken: "wrong-csrf-token-value",
        schemaErrors: [{ field: "body", message: "invalid" }],
      }),
    ).rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });
    expect(repository.calls).toHaveLength(0);
  });

  it("returns declared validation, conflict and expired outcomes", async () => {
    const invalidRepository = new RecordingRepository();
    await expect(
      service(invalidRepository).create({ ...request(), idempotencyKey: "short" }),
    ).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });

    const conflictRepository = new RecordingRepository();
    conflictRepository.outcome = { kind: "conflict" };
    await expect(service(conflictRepository).create(request())).rejects.toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
    });

    const expiredRepository = new RecordingRepository();
    expiredRepository.outcome = { kind: "expired" };
    await expect(service(expiredRepository).create(request())).rejects.toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_REPLAY_EXPIRED",
    });
  });

  it("opens an authorized replay and maps envelope failures to the declared 503", async () => {
    const replay: ApiKeyCreated = {
      id: "77777777-7777-4777-8777-777777777777",
      name: "Original",
      prefix: "dhk_v1_CCCCCCCCCCCCCCCC",
      scopes: ["catalog:read"],
      state: "active",
      created_at: "2026-08-23T00:00:00.000Z",
      last_used_at: null,
      expires_at: null,
      revoked_at: null,
      secret: `dhk_v1_CCCCCCCCCCCCCCCC.${"D".repeat(43)}`,
    };
    const repository = new RecordingRepository();
    repository.outcome = {
      kind: "replay",
      idempotencyRecordId: "66666666-6666-4666-8666-666666666666",
      apiKeyId: replay.id,
      envelopeCiphertext: Buffer.from("original-ciphertext"),
      envelopeKeyReference: "test:v1",
    };
    const contexts: Buffer[] = [];
    const responseEnvelope: ResponseEnvelope = {
      async seal() {
        return { ciphertext: Buffer.from("unused"), keyReference: "test:v1" };
      },
      async open(_ciphertext, _reference, context) {
        contexts.push(context);
        return serializeApiKeyCreated(replay);
      },
    };
    await expect(service(repository, responseEnvelope).create(request())).resolves.toEqual(replay);
    expect(contexts).toEqual([
      apiKeyEnvelopeAad({
        tenantId: identity.tenantId,
        idempotencyRecordId: "66666666-6666-4666-8666-666666666666",
        apiKeyId: replay.id,
      }),
    ]);

    const unavailable: ResponseEnvelope = {
      async seal() {
        throw new Error("kms unavailable");
      },
      async open() {
        throw new Error("not reached");
      },
    };
    await expect(service(new RecordingRepository(), unavailable).create(request())).rejects.toMatchObject({
      status: 503,
      code: "SERVICE_UNAVAILABLE",
    });
  });
});
