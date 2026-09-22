import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { TenantAuthorizationRepository } from "../../src/services/tenantAccess/tenantAuthorizationRepository.js";
import { createTenantAuthorizationService } from "../../src/services/tenantAccess/tenantAuthorizationService.js";

const identity = {
  userId: randomUUID(),
  sessionId: randomUUID(),
  issuedTenantId: randomUUID(),
};

function repository(
  tenantIds: readonly string[],
): TenantAuthorizationRepository & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async findActiveTenantCandidates(userId) {
      calls.push(userId);
      return tenantIds.map((tenantId) => ({ tenantId }));
    },
  };
}

describe("tenant authorization service", () => {
  it("creates resource authority only from one current matching Tenant relationship", async () => {
    const store = repository([identity.issuedTenantId]);
    const service = createTenantAuthorizationService({ repository: store });

    await expect(service.authorizeBrowserTenant(identity)).resolves.toEqual({
      userId: identity.userId,
      sessionId: identity.sessionId,
      tenantId: identity.issuedTenantId,
    });
    expect(store.calls).toEqual([identity.userId]);
  });

  it.each([
    ["no active relationship", []],
    ["ambiguous active relationships", [identity.issuedTenantId, randomUUID()]],
    ["a stale issuance claim", [randomUUID()]],
  ])("rejects %s with one non-enumerating 403", async (_caseName, tenantIds) => {
    const service = createTenantAuthorizationService({ repository: repository(tenantIds) });

    await expect(service.authorizeBrowserTenant(identity)).rejects.toMatchObject({
      status: 403,
      code: "ACCESS_DENIED",
    });
  });

  it("does not disguise an infrastructure failure as an authorization result", async () => {
    const failure = new Error("database unavailable");
    const service = createTenantAuthorizationService({
      repository: {
        async findActiveTenantCandidates() {
          throw failure;
        },
      },
    });

    await expect(service.authorizeBrowserTenant(identity)).rejects.toBe(failure);
  });
});
