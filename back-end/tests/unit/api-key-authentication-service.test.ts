import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApiKeyMaterial } from "../../src/helpers/apiKeyMaterial.js";
import type {
  ApiKeyAuthenticationRepository,
  ApiKeyFinalizationOutcome,
  ApiKeyVerifierCandidate,
} from "../../src/services/apiKeys/apiKeyAuthenticationRepository.js";
import { createApiKeyAuthenticationService } from "../../src/services/apiKeys/apiKeyAuthenticationService.js";

function material() {
  let call = 0;
  return createApiKeyMaterial((size) => {
    call += 1;
    return Buffer.alloc(size, call + 10);
  });
}

interface RecordingRepository extends ApiKeyAuthenticationRepository {
  readonly lookupCalls: string[];
  readonly finalizeCalls: Array<{
    readonly keyId: string;
    readonly prefix: string;
    readonly presentedHash: Buffer;
  }>;
}

function repository(options: {
  readonly candidate?: ApiKeyVerifierCandidate;
  readonly finalization?: ApiKeyFinalizationOutcome;
}): RecordingRepository {
  const lookupCalls: string[] = [];
  const finalizeCalls: Array<{
    readonly keyId: string;
    readonly prefix: string;
    readonly presentedHash: Buffer;
  }> = [];
  return {
    lookupCalls,
    finalizeCalls,
    async findVerifierCandidate(prefix) {
      lookupCalls.push(prefix);
      return options.candidate;
    },
    async finalizeAuthentication(input) {
      finalizeCalls.push(input);
      return options.finalization ?? { status: "credential_unavailable" };
    },
  };
}

describe("Dhumi API-key authentication service", () => {
  it("returns a trusted key/Tenant/scope principal only after both repository phases", async () => {
    const key = material();
    const keyId = randomUUID();
    const tenantId = randomUUID();
    const store = repository({
      candidate: { keyId, keyHash: key.hash },
      finalization: {
        status: "authenticated",
        tenantId,
        scopes: ["catalog:read", "runs:read"],
      },
    });
    const service = createApiKeyAuthenticationService({ repository: store });

    await expect(service.authenticate(`bearer ${key.secret}`)).resolves.toEqual({
      kind: "api_key",
      apiKeyId: keyId,
      tenantId,
      scopes: ["catalog:read", "runs:read"],
    });
    expect(store.lookupCalls).toEqual([key.prefix]);
    expect(store.finalizeCalls).toEqual([
      { keyId, prefix: key.prefix, presentedHash: key.hash },
    ]);
  });

  it("maps malformed credentials to one generic 401 without database lookup", async () => {
    const store = repository({});
    const service = createApiKeyAuthenticationService({ repository: store });

    for (const authorization of [
      undefined,
      "Basic value",
      "Bearer",
      "Bearer dhk_v1_bad",
      "Bearer dhk_v1_bad value",
    ]) {
      await expect(service.authenticate(authorization)).rejects.toMatchObject({
        status: 401,
        code: "AUTHENTICATION_REQUIRED",
      });
    }
    expect(store.lookupCalls).toHaveLength(0);
    expect(store.finalizeCalls).toHaveLength(0);
  });

  it("does not finalize a missing candidate or same-prefix wrong secret", async () => {
    const key = material();
    const wrong = createApiKeyMaterial((size) => Buffer.alloc(size, 27));
    const missing = repository({});
    const mismatch = repository({
      candidate: { keyId: randomUUID(), keyHash: wrong.hash },
    });

    await expect(
      createApiKeyAuthenticationService({ repository: missing }).authenticate(
        `Bearer ${key.secret}`,
      ),
    ).rejects.toMatchObject({ status: 401, code: "AUTHENTICATION_REQUIRED" });
    await expect(
      createApiKeyAuthenticationService({ repository: mismatch }).authenticate(
        `Bearer ${key.secret}`,
      ),
    ).rejects.toMatchObject({ status: 401, code: "AUTHENTICATION_REQUIRED" });
    expect(missing.finalizeCalls).toHaveLength(0);
    expect(mismatch.finalizeCalls).toHaveLength(0);
  });

  it("maps a revoked/expired final state to 401 and an unavailable Tenant to 403", async () => {
    const key = material();
    const candidate = { keyId: randomUUID(), keyHash: key.hash };

    await expect(
      createApiKeyAuthenticationService({
        repository: repository({
          candidate,
          finalization: { status: "credential_unavailable" },
        }),
      }).authenticate(`Bearer ${key.secret}`),
    ).rejects.toMatchObject({ status: 401, code: "AUTHENTICATION_REQUIRED" });

    await expect(
      createApiKeyAuthenticationService({
        repository: repository({ candidate, finalization: { status: "access_denied" } }),
      }).authenticate(`Bearer ${key.secret}`),
    ).rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });
  });

  it("preserves repository failures for centralized safe error handling", async () => {
    const key = material();
    const failure = new Error("database unavailable");
    const service = createApiKeyAuthenticationService({
      repository: {
        async findVerifierCandidate() {
          throw failure;
        },
        async finalizeAuthentication() {
          throw new Error("not reached");
        },
      },
    });

    await expect(service.authenticate(`Bearer ${key.secret}`)).rejects.toBe(failure);
  });
});
