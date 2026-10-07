import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createAccessTokenService } from "../../src/helpers/accessToken.js";
import { createCsrfService } from "../../src/helpers/csrf.js";
import { createRefreshTokenService } from "../../src/helpers/refreshToken.js";
import {
  legacySignupRequestHash,
  canonicalRequestHash,
} from "../../src/helpers/signupCanonicalization.js";
import { createSignupService } from "../../src/services/identity/signupService.js";
import { createSignInService } from "../../src/services/identity/signInService.js";
import type {
  IdentityRecord,
  SignInRepository,
  SessionCreationOutcome,
} from "../../src/services/identity/signInRepository.js";

const userId = randomUUID();
const sessionId = randomUUID();
const secret = "auth-refactor-unit-secret-at-least-32-characters";
const accessToken = {
  secret,
  issuer: "https://dhumi.test",
  audience: "dhumi-browser",
  ttlSeconds: 900,
};
const accessTokens = createAccessTokenService(accessToken);
const csrf = createCsrfService(secret);
const legal = {
  documents: [{ documentType: "terms", documentVersion: "v1", contentHash: "a".repeat(64) }],
  requiredDocumentTypes: ["terms"],
  disclosureVersion: null,
};
const legalAcceptances = [
  {
    document_type: "terms",
    document_version: "v1",
    content_hash: "a".repeat(64),
    accepted: true as const,
  },
];

describe("0071 signup service", () => {
  it("hashes before persistence even for an existing email and ignores workspace in new claims", async () => {
    const order: string[] = [];
    const inputs: Array<
      Parameters<
        import("../../src/services/identity/signupRepository.js").SignupRepository["createSignup"]
      >[0]
    > = [];
    const service = createSignupService({
      legal,
      passwordHasher: {
        async hash() {
          order.push("hash");
          return "encoded-not-plaintext";
        },
        async verify() {
          return false;
        },
        needsRehash() {
          return false;
        },
      },
      repository: {
        async createSignup(input) {
          order.push("persist");
          inputs.push(input);
          return { kind: "completed", userId: null, replayed: false };
        },
      },
    });
    const request = {
      email: " Auth-Refactor@Example.TEST ",
      password: "a-sufficiently-long-password",
      legalAcceptances,
      idempotencyKey: "signup-service-unit",
      requestId: null,
    };
    await service.submit(request);
    await service.submit({ ...request, workspaceName: "  Historical Workspace  " });
    expect(order).toEqual(["hash", "persist", "hash", "persist"]);
    expect(inputs[0]?.requestHash).toEqual(inputs[1]?.requestHash);
    expect(inputs[0]).not.toHaveProperty("workspaceName");
    expect(inputs[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(inputs[0]?.emailNormalized).toBe("auth-refactor@example.test");
    expect(inputs[1]?.legacyRequestHash).toEqual(
      legacySignupRequestHash({
        emailNormalized: "auth-refactor@example.test",
        workspaceName: "Historical Workspace",
        legalAcceptances: legal.documents,
      }),
    );
    expect(inputs[0]?.legalAcceptances[0]).toEqual({
      document_type: "terms",
      document_version: "v1",
      document_hash_hex: "a".repeat(64),
      disclosure_version: null,
    });
  });
  it("validates legal consent before hashing or contacting persistence", async () => {
    const hash = vi.fn(async () => "encoded");
    const createSignup = vi.fn(async () => ({ kind: "in_progress" as const }));
    const service = createSignupService({
      legal,
      passwordHasher: {
        hash,
        async verify() {
          return false;
        },
        needsRehash() {
          return false;
        },
      },
      repository: { createSignup },
    });
    await expect(
      service.submit({
        email: "a@example.test",
        password: "long-password",
        legalAcceptances: [],
        idempotencyKey: "legal-unit",
        requestId: null,
      }),
    ).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });
    expect(hash).not.toHaveBeenCalled();
    expect(createSignup).not.toHaveBeenCalled();
  });
  it("keeps v1 replay hashes distinct from user-only v2 claims", () => {
    const request = {
      emailNormalized: "auth-refactor@example.test",
      workspaceName: "Workspace",
      legalAcceptances: legal.documents,
    };
    expect(legacySignupRequestHash(request)).not.toEqual(canonicalRequestHash(request));
    expect(legacySignupRequestHash({ ...request, workspaceName: "Other" })).not.toEqual(
      legacySignupRequestHash(request),
    );
    expect(canonicalRequestHash({ ...request, workspaceName: "Other" })).toEqual(
      canonicalRequestHash(request),
    );
  });
});

function signInHarness(
  identity: IdentityRecord | undefined,
  outcome: SessionCreationOutcome = { kind: "created", sessionId },
  correct = true,
  rehash = false,
) {
  const findIdentity = vi.fn(async () => identity);
  const recordFailure = vi.fn(async () => {});
  const createSession = vi.fn(
    async (..._input: Parameters<SignInRepository["createSession"]>) => outcome,
  );
  const updatePasswordHash = vi.fn(async () => {});
  const verify = vi.fn(async () => correct);
  const hash = vi.fn(async () => "encoded-hash");
  const repository: SignInRepository = {
    findIdentity,
    recordFailure,
    createSession,
    updatePasswordHash,
  };
  const service = createSignInService({
    repository,
    passwordHasher: { hash, verify, needsRehash: () => rehash },
    accessTokens,
    csrf,
    refreshTokens: createRefreshTokenService(),
    session: {
      accessToken,
      refreshTtlSeconds: 3600,
      cookie: {
        name: "dhumi_refresh",
        path: "/v1/auth",
        secure: true,
        sameSite: "strict",
        domain: undefined,
      },
    },
    lockout: { threshold: 5, windowMs: 60_000 },
  });
  return { service, findIdentity, recordFailure, createSession, updatePasswordHash, verify, hash };
}
const active: IdentityRecord = {
  userId,
  passwordHash: "existing-encoded-hash",
  state: "active",
  failedAuthCount: 0,
  lastFailedAuthAt: null,
};
const request = {
  email: " USER@Example.TEST ",
  password: "a-sufficiently-long-password",
  requestId: null,
  ipFingerprint: null,
};
describe("0071 sign-in service", () => {
  it("authenticates without organization membership and issues only user/session claims", async () => {
    const h = signInHarness(active);
    const result = await h.service.authenticate(request);
    expect(h.findIdentity).toHaveBeenCalledWith("user@example.test");
    expect(h.verify).toHaveBeenCalledWith(active.passwordHash, request.password);
    expect(h.createSession.mock.calls[0]?.[0]).not.toHaveProperty("deviceMetadata");
    expect(await accessTokens.verify(result.accessToken)).toEqual({ userId, sessionId });
    expect(result.csrfToken).toBe(csrf.issue(sessionId));
  });
  it("verifies the dummy hash and records a generic denial for unknown email", async () => {
    const h = signInHarness(undefined, undefined, false);
    await expect(h.service.authenticate(request)).rejects.toMatchObject({
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
    });
    expect(h.verify).toHaveBeenCalledWith("encoded-hash", request.password);
    expect(h.recordFailure).toHaveBeenCalled();
    expect(h.createSession).not.toHaveBeenCalled();
  });
  it.each(["suspended", "closed"])("does not issue a session for a %s user", async (state) => {
    const h = signInHarness({ ...active, state });
    await expect(h.service.authenticate(request)).rejects.toMatchObject({
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
    });
    expect(h.verify).toHaveBeenCalled();
    expect(h.createSession).not.toHaveBeenCalled();
  });
  it("rejects a state or lockout race reported by the authoritative session transaction", async () => {
    const h = signInHarness(active, { kind: "identity_unavailable" });
    await expect(h.service.authenticate(request)).rejects.toMatchObject({ status: 401 });
    expect(h.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "denied_state_race" }),
      userId,
      0,
    );
  });
  it("keeps successful authentication when an optional password rehash fails", async () => {
    const h = signInHarness(active, undefined, true, true);
    h.updatePasswordHash.mockRejectedValueOnce(Error("rehash storage unavailable"));
    await expect(h.service.authenticate(request)).resolves.toHaveProperty("accessToken");
    expect(h.updatePasswordHash).toHaveBeenCalled();
  });
});
