import { describe, expect, it } from "vitest";
import type { CsrfService } from "../../src/helpers/csrf.js";
import type {
  RevokeApiKeyRepository,
  RevokeApiKeyRepositoryInput,
  RevokeApiKeyOutcome,
} from "../../src/services/apiKeys/revokeApiKeyRepository.js";
import { createRevokeApiKeyService } from "../../src/services/apiKeys/revokeApiKeyService.js";
import { ApplicationError } from "../../src/utils/applicationError.js";

const VALID_CSRF = "valid-csrf-token-value";
const KEY_ID = "44444444-4444-4444-8444-444444444444";
const identity = {
  userId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  tenantId: "33333333-3333-4333-8333-333333333333",
};

class RecordingRepository implements RevokeApiKeyRepository {
  public readonly calls: RevokeApiKeyRepositoryInput[] = [];
  public outcome: RevokeApiKeyOutcome = "revoked";
  public failure: Error | undefined;

  public async revoke(input: RevokeApiKeyRepositoryInput): Promise<RevokeApiKeyOutcome> {
    this.calls.push(input);
    if (this.failure !== undefined) throw this.failure;
    return this.outcome;
  }
}

function csrf(): CsrfService {
  return {
    issue() {
      return VALID_CSRF;
    },
    verify(sessionId, presented) {
      return sessionId === identity.sessionId && presented === VALID_CSRF;
    },
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    identity,
    keyId: KEY_ID,
    csrfToken: VALID_CSRF,
    schemaErrors: [],
    requestId: "55555555-5555-4555-8555-555555555555",
    ipFingerprint: Buffer.from("fingerprint"),
    ...overrides,
  };
}

describe("revokeApiKeyService", () => {
  it.each(["revoked", "already_inactive"] as const)(
    "accepts the repository %s outcome with trusted metadata",
    async (outcome) => {
      const repository = new RecordingRepository();
      repository.outcome = outcome;
      const service = createRevokeApiKeyService({ repository, csrf: csrf() });

      await expect(service.revoke(request())).resolves.toBeUndefined();
      expect(repository.calls).toEqual([
        {
          tenantId: identity.tenantId,
          userId: identity.userId,
          keyId: KEY_ID,
          requestId: "55555555-5555-4555-8555-555555555555",
          ipFingerprint: Buffer.from("fingerprint"),
        },
      ]);
    },
  );

  it("maps an invisible repository target to the generic 404", async () => {
    const repository = new RecordingRepository();
    repository.outcome = "not_found";

    await expect(
      createRevokeApiKeyService({ repository, csrf: csrf() }).revoke(request()),
    ).rejects.toMatchObject({
      status: 404,
      code: "RESOURCE_NOT_FOUND",
      title: "Resource not found",
      detail: null,
    });
  });

  it.each([
    ["missing", undefined],
    ["short", "too-short"],
    ["long", "x".repeat(513)],
    ["wrong", "wrong-csrf-token-value"],
  ])("rejects %s CSRF before path interpretation or persistence", async (_label, token) => {
    const repository = new RecordingRepository();

    await expect(
      createRevokeApiKeyService({ repository, csrf: csrf() }).revoke(
        request({ csrfToken: token, keyId: "not-a-uuid" }),
      ),
    ).rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });
    expect(repository.calls).toHaveLength(0);
  });

  it.each([
    ["non-string", [KEY_ID], []],
    ["malformed", "not-a-uuid", []],
    ["attached schema error", KEY_ID, [{ field: "/key_id", message: "must match format" }]],
  ])("maps %s path input to the same generic 404", async (_label, keyId, schemaErrors) => {
    const repository = new RecordingRepository();

    await expect(
      createRevokeApiKeyService({ repository, csrf: csrf() }).revoke(
        request({ keyId, schemaErrors }),
      ),
    ).rejects.toMatchObject({ status: 404, code: "RESOURCE_NOT_FOUND", detail: null });
    expect(repository.calls).toHaveLength(0);
  });

  it("preserves a safe application failure from the repository", async () => {
    const repository = new RecordingRepository();
    repository.failure = new ApplicationError({
      status: 500,
      code: "INTERNAL_ERROR",
      title: "Internal server error",
    });

    await expect(
      createRevokeApiKeyService({ repository, csrf: csrf() }).revoke(request()),
    ).rejects.toMatchObject({ status: 500, code: "INTERNAL_ERROR" });
  });
});
