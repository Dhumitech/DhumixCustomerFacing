import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { TenantAuthorizationRepository } from "../../src/services/tenantAccess/tenantAuthorizationRepository.js";
import { createTenantAuthorizationService } from "../../src/services/tenantAccess/tenantAuthorizationService.js";

const identity = { userId: randomUUID(), sessionId: randomUUID() };
const first = randomUUID();
const second = randomUUID();
function repository(tenantIds: readonly string[]) {
  const calls: Array<{ userId: string; organizationId: string | undefined }> = [];
  const store: TenantAuthorizationRepository = {
    async findActiveTenantCandidates(userId, organizationId) {
      calls.push({ userId, organizationId });
      return tenantIds
        .filter((id) => organizationId === undefined || organizationId === id)
        .map((tenantId) => ({ tenantId }));
    },
  };
  return { store, calls };
}
describe("per-request organization authorization", () => {
  it("falls back to one active membership without an organization claim", async () => {
    const { store, calls } = repository([first]);
    const service = createTenantAuthorizationService({ repository: store });
    await expect(service.authorizeBrowserTenant(identity)).resolves.toEqual({
      ...identity,
      tenantId: first,
    });
    expect(calls).toEqual([{ userId: identity.userId, organizationId: undefined }]);
  });
  it("requires membership when there are no candidates", async () => {
    const { store } = repository([]);
    await expect(
      createTenantAuthorizationService({ repository: store }).authorizeBrowserTenant(identity),
    ).rejects.toMatchObject({ status: 403, code: "ORGANIZATION_MEMBERSHIP_REQUIRED" });
  });
  it("requires a selector with multiple memberships", async () => {
    const { store } = repository([first, second]);
    await expect(
      createTenantAuthorizationService({ repository: store }).authorizeBrowserTenant(identity),
    ).rejects.toMatchObject({ status: 400, code: "ORGANIZATION_REQUIRED" });
  });
  it("allows two tabs to select different organizations using one session", async () => {
    const { store } = repository([first, second]);
    const service = createTenantAuthorizationService({ repository: store });
    const results = await Promise.all([
      service.authorizeBrowserTenant(identity, first),
      service.authorizeBrowserTenant(identity, second.toUpperCase()),
    ]);
    expect(results.map((result) => result.tenantId)).toEqual([first, second]);
    expect(results.map((result) => result.sessionId)).toEqual([
      identity.sessionId,
      identity.sessionId,
    ]);
  });
  it("returns the same not-found for nonexistent or inaccessible selectors", async () => {
    const { store } = repository([first]);
    const service = createTenantAuthorizationService({ repository: store });
    for (const id of [second, randomUUID()]) {
      await expect(service.authorizeBrowserTenant(identity, id)).rejects.toMatchObject({
        status: 404,
        code: "RESOURCE_NOT_FOUND",
      });
    }
  });
  it("rejects malformed or repeated selectors before a database lookup", async () => {
    const { store, calls } = repository([first]);
    const service = createTenantAuthorizationService({ repository: store });
    for (const selector of ["", "not-a-uuid", [first, second]]) {
      await expect(service.authorizeBrowserTenant(identity, selector)).rejects.toMatchObject({
        status: 400,
        code: "BAD_REQUEST",
      });
    }
    expect(calls).toEqual([]);
  });
  it("does not disguise infrastructure failures as access denials", async () => {
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
