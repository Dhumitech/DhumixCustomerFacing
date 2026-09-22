import { describe, expect, it, vi } from "vitest";
import type { CsrfService } from "../../src/helpers/csrf.js";
import type { ServiceConfigurationValidator } from "../../src/helpers/serviceConfigurationValidator.js";
import type {
  CreateServicePersistenceInput,
  CreateServiceRepository,
  CreatedService,
} from "../../src/services/customerServices/createServiceRepository.js";
import { createServiceService } from "../../src/services/customerServices/createServiceService.js";
import { ApplicationError } from "../../src/utils/applicationError.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const API_KEY_ID = "44444444-4444-4444-8444-444444444444";
const IDS = [
  "55555555-5555-4555-8555-555555555555",
  "66666666-6666-4666-8666-666666666666",
  "77777777-7777-4777-8777-777777777777",
] as const;

const created: CreatedService = {
  id: IDS[1],
  name: "Saved service",
  template_slug: "marketplace-products",
  template_version: 3,
  version: 1,
  family: "marketplace_dataset",
  state: "active",
  configuration: { query: "laptop" },
  created_at: "2026-08-25T10:00:00.000Z",
};

function dependencies(outcome: "created" | "replay" | "conflict" = "created") {
  const persist = vi.fn<CreateServiceRepository["persist"]>(async () =>
    outcome === "conflict" ? { kind: "conflict" } : { kind: outcome, service: created },
  );
  const verify = vi.fn(() => true);
  const ids = [...IDS];
  return {
    persist,
    verify,
    service: createServiceService({
      repository: { persist },
      validator: {
        validate: vi.fn<ServiceConfigurationValidator["validate"]>(() => ({
          valid: true,
          schemaHash: Buffer.alloc(32, 7),
        })),
      },
      csrf: { issue: vi.fn(() => "csrf"), verify } as CsrfService,
      providerEnvironment: "test",
      createId: () => ids.shift() as string,
    }),
  };
}

function request(principal: "browser" | "api_key" = "browser") {
  return {
    principal:
      principal === "browser"
        ? ({ kind: "browser", tenantId: TENANT_ID, userId: USER_ID, sessionId: SESSION_ID } as const)
        : ({
            kind: "api_key",
            tenantId: TENANT_ID,
            apiKeyId: API_KEY_ID,
            scopes: ["services:write"],
          } as const),
    csrfToken: principal === "browser" ? "valid-csrf-token-value" : undefined,
    idempotencyKey: "service-create-key-0001",
    body: {
      template_slug: "marketplace-products",
      name: "Saved service",
      configuration: { query: "laptop" },
    },
    schemaErrors: [],
    requestId: "88888888-8888-4888-8888-888888888888",
    ipFingerprint: Buffer.alloc(32, 9),
  };
}

describe("create Service service", () => {
  it("attributes a browser actor, verifies CSRF, and passes only admission-safe input", async () => {
    const fixture = dependencies();
    await expect(fixture.service.create(request())).resolves.toEqual(created);
    expect(fixture.verify).toHaveBeenCalledWith(SESSION_ID, "valid-csrf-token-value");
    const persisted = fixture.persist.mock.calls[0]?.[0] as CreateServicePersistenceInput;
    expect(persisted).toMatchObject({
      idempotencyRecordId: IDS[0],
      serviceId: IDS[1],
      serviceVersionId: IDS[2],
      tenantId: TENANT_ID,
      actor: { kind: "browser", userId: USER_ID },
      templateSlug: "marketplace-products",
      name: "Saved service",
      providerEnvironment: "test",
    });
    expect(persisted.requestHash).toHaveLength(32);
    expect(persisted.actorFingerprint).toHaveLength(32);
  });

  it("accepts an authorized API-key principal without consulting CSRF", async () => {
    const fixture = dependencies("replay");
    await expect(fixture.service.create(request("api_key"))).resolves.toEqual(created);
    expect(fixture.verify).not.toHaveBeenCalled();
    expect(fixture.persist.mock.calls[0]?.[0].actor).toEqual({
      kind: "api_key",
      apiKeyId: API_KEY_ID,
    });
  });

  it("rejects browser CSRF and request shape before repository work", async () => {
    const fixture = dependencies();
    const missingCsrf = { ...request(), csrfToken: undefined };
    await expect(fixture.service.create(missingCsrf)).rejects.toMatchObject({
      status: 403,
      code: "ACCESS_DENIED",
    });
    expect(fixture.persist).not.toHaveBeenCalled();

    const malformed = {
      ...request("api_key"),
      idempotencyKey: "short",
      body: { template_slug: "Not Canonical", name: "  ", configuration: [] },
    };
    await expect(fixture.service.create(malformed)).rejects.toMatchObject({
      status: 422,
      code: "VALIDATION_ERROR",
    });
    expect(fixture.persist).not.toHaveBeenCalled();
  });

  it("maps a changed idempotent request to the public conflict", async () => {
    const fixture = dependencies("conflict");
    await expect(fixture.service.create(request("api_key"))).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.status === 409 &&
        error.code === "IDEMPOTENCY_CONFLICT",
    );
  });
});
