import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCsrfService } from "../../src/helpers/csrf.js";
import type { LogoutInput, LogoutOutcome, LogoutRepository } from "../../src/services/identity/logoutRepository.js";
import { createLogoutService } from "../../src/services/identity/logoutService.js";

const csrf = createCsrfService("logout-unit-secret-at-least-32-characters");
const identity = {
  userId: randomUUID(),
  sessionId: randomUUID(),
  issuedTenantId: randomUUID(),
};

function repository(outcome: LogoutOutcome): LogoutRepository & { calls: LogoutInput[] } {
  const calls: LogoutInput[] = [];
  return {
    calls,
    async revoke(input) {
      calls.push(input);
      return outcome;
    },
  };
}

function request(csrfToken: string | undefined) {
  return {
    identity,
    csrfToken,
    requestId: randomUUID(),
    ipFingerprint: Buffer.from("safe-fingerprint"),
  };
}

describe("logout service", () => {
  it("verifies CSRF and forwards only trusted session identity", async () => {
    const store = repository("revoked");
    const service = createLogoutService({ repository: store, csrf });
    const input = request(csrf.issue(identity.sessionId));

    await expect(service.logout(input)).resolves.toBeUndefined();
    expect(store.calls).toEqual([
      {
        userId: identity.userId,
        sessionId: identity.sessionId,
        issuedTenantId: identity.issuedTenantId,
        requestId: input.requestId,
        ipFingerprint: input.ipFingerprint,
      },
    ]);
  });

  it("rejects missing, malformed, wrong-session, and oversized CSRF before persistence", async () => {
    for (const token of [
      undefined,
      "short",
      csrf.issue(randomUUID()),
      "x".repeat(513),
    ]) {
      const store = repository("revoked");
      const service = createLogoutService({ repository: store, csrf });

      await expect(service.logout(request(token))).rejects.toMatchObject({
        status: 403,
        code: "ACCESS_DENIED",
      });
      expect(store.calls).toHaveLength(0);
    }
  });

  it("treats a concurrently completed revocation as successful", async () => {
    const service = createLogoutService({ repository: repository("already_revoked"), csrf });

    await expect(service.logout(request(csrf.issue(identity.sessionId)))).resolves.toBeUndefined();
  });

  it("maps a session that became unavailable after middleware authentication to 401", async () => {
    const service = createLogoutService({ repository: repository("session_unavailable"), csrf });

    await expect(service.logout(request(csrf.issue(identity.sessionId)))).rejects.toMatchObject({
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
    });
  });
});
