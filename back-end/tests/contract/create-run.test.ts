import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import { createCsrfService } from "../../src/helpers/csrf.js";
import {
  RunCapacityExceededError,
  type CreateRunRepository,
} from "../../src/services/admission/createRunRepository.js";
import { createRunService } from "../../src/services/admission/createRunService.js";
import type {
  BrowserAuthenticationService,
  TrustedSessionIdentity,
} from "../../src/services/identity/browserAuthenticationService.js";
import { authenticationRequired } from "../../src/services/identity/sessionErrors.js";
import type { TenantAuthorizationService } from "../../src/services/tenantAccess/tenantAuthorizationService.js";
import {
  stubGetCatalogTemplateService,
  stubListCatalogTemplatesService,
} from "../support/catalogueStub.js";
import {
  stubCreateServiceService,
  stubGetServiceService,
  stubListServicesService,
} from "../support/serviceStub.js";

const TOKEN_SECRET = "test-access-token-secret-at-least-32-chars";
const ACCESS_TOKEN = "header.payload.signature";
const API_KEY = `dhk_v1_${"A".repeat(16)}.${"A".repeat(43)}`;
const tenantId = randomUUID();
const serviceId = randomUUID();
const session: TrustedSessionIdentity = {
  userId: randomUUID(),
  sessionId: randomUUID(),
};
const accepted = {
  run_id: randomUUID(),
  status: "queued" as const,
  accepted_at: "2026-08-25T12:00:00.000Z",
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function config() {
  return loadRuntimeConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    FRONTEND_ORIGIN: "http://localhost:5173",
    DATABASE_HOST: "localhost",
    DATABASE_NAME: "dhumi_test",
    DATABASE_IDENTITY_USER: "dhumi_test_identity_login",
    DATABASE_IDENTITY_PASSWORD: "identity-password-at-least-20-characters",
    DATABASE_CUSTOMER_API_USER: "dhumi_test_customer_api_login",
    DATABASE_CUSTOMER_API_PASSWORD: "customer-password-at-least-20-characters",
    DATABASE_ADMISSION_USER: "dhumi_test_admission_login",
    DATABASE_ADMISSION_PASSWORD: "admission-password-at-least-20-characters",
    ACCESS_TOKEN_SECRET: TOKEN_SECRET,
    ACCESS_TOKEN_ISSUER: "https://dhumi.test",
    ACCESS_TOKEN_AUDIENCE: "dhumi-browser",
  });
}

function browserAuthentication(): BrowserAuthenticationService {
  return {
    async authenticate(authorization) {
      if (authorization !== `Bearer ${ACCESS_TOKEN}`) throw authenticationRequired();
      return session;
    },
  };
}

async function build(
  repository: CreateRunRepository,
): Promise<FastifyInstance> {
  const browser = browserAuthentication();
  const tenantAuthorization: TenantAuthorizationService = {
    async authorizeBrowserTenant(identity) {
      return {
        userId: identity.userId,
        sessionId: identity.sessionId,
        tenantId,
      };
    },
  };
  app = await buildApp(config(), {
    signupService: { async submit() { throw new Error("unexpected"); } },
    signInService: { async authenticate() { throw new Error("unexpected"); } },
    refreshService: { async refresh() { throw new Error("unexpected"); } },
    browserAuthenticationService: browser,
    logoutService: { async logout() { throw new Error("unexpected"); } },
    tenantAuthorizationService: tenantAuthorization,
    workspaceService: { async getWorkspace() { throw new Error("unexpected"); } },
    listCatalogTemplatesService: stubListCatalogTemplatesService,
    getCatalogTemplateService: stubGetCatalogTemplateService,
    listServicesService: stubListServicesService,
    createServiceService: stubCreateServiceService,
    getServiceService: stubGetServiceService,
    createRunService: createRunService({
      repository,
      validator: {
        validate() {
          return { valid: true, schemaHash: Buffer.alloc(32, 1) };
        },
      },
      csrf: createCsrfService(TOKEN_SECRET),
      providerEnvironment: "test",
    }),
  });
  return app;
}

describe("POST /v1/services/{service_id}/runs contract", () => {
  it("rejects a retired customer API key before persistence even with a CSRF header", async () => {
    const persist = vi.fn<CreateRunRepository["persist"]>();
    const response = await (await build({ persist })).inject({
      method: "POST",
      url: `/v1/services/${serviceId}/runs`,
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "x-csrf-token": createCsrfService(TOKEN_SECRET).issue(session.sessionId),
        "idempotency-key": "create-run-api-key-denied",
      },
      payload: { input: {} },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    expect(persist).not.toHaveBeenCalled();
  });

  it("accepts a browser session and emits only the exact 202 projection", async () => {
    const persist = vi.fn<CreateRunRepository["persist"]>(async () => ({
      kind: "created",
      run: { ...accepted, validated_input: "must-be-stripped" } as typeof accepted,
    }));
    const response = await (await build({ persist })).inject({
      method: "POST",
      url: `/v1/services/${serviceId}/runs`,
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "x-csrf-token": createCsrfService(TOKEN_SECRET).issue(session.sessionId),
        "idempotency-key": "create-run-contract-0001",
      },
      payload: { input: { query: "laptop" } },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual(accepted);
    expect(response.body).not.toContain("must-be-stripped");
    expect(persist.mock.calls[0]?.[0]).toMatchObject({
      tenantId,
      serviceId,
      actor: { kind: "browser", userId: session.userId },
    });
  });

  it("requires browser CSRF and allows a valid browser request", async () => {
    const persist = vi.fn<CreateRunRepository["persist"]>(async () => ({
      kind: "replay",
      run: accepted,
    }));
    const missing = await (await build({ persist })).inject({
      method: "POST",
      url: `/v1/services/${serviceId}/runs`,
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "idempotency-key": "create-run-contract-0002",
      },
      payload: { input: {} },
    });
    expect(missing.statusCode).toBe(403);
    await app?.close();
    app = undefined;

    const token = createCsrfService(TOKEN_SECRET).issue(session.sessionId);
    const success = await (await build({ persist })).inject({
      method: "POST",
      url: `/v1/services/${serviceId}/runs`,
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "x-csrf-token": token,
        "idempotency-key": "create-run-contract-0003",
      },
      payload: { input: {} },
    });
    expect(success.statusCode).toBe(202);
  });

  it("rejects malformed requests before persistence", async () => {
    const persist = vi.fn<CreateRunRepository["persist"]>();
    const malformed = await (await build({ persist })).inject({
      method: "POST",
      url: `/v1/services/not-a-uuid/runs`,
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "x-csrf-token": createCsrfService(TOKEN_SECRET).issue(session.sessionId),
        "idempotency-key": "create-run-contract-0005",
      },
      payload: { input: [], extra: true },
    });
    expect(malformed.statusCode).toBe(422);
    expect(persist).not.toHaveBeenCalled();
  });

  it("returns the declared parser, media and capacity Problems", async () => {
    const capacity: CreateRunRepository = {
      async persist() {
        throw new RunCapacityExceededError();
      },
    };
    const target = await build(capacity);
    const limited = await target.inject({
      method: "POST",
      url: `/v1/services/${serviceId}/runs`,
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "x-csrf-token": createCsrfService(TOKEN_SECRET).issue(session.sessionId),
        "idempotency-key": "create-run-contract-0006",
      },
      payload: { input: {} },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    expect(limited.json()).toMatchObject({ code: "PLATFORM_CAPACITY_LIMIT" });

    const malformed = await target.inject({
      method: "POST",
      url: `/v1/services/${serviceId}/runs`,
      headers: { "content-type": "application/json" },
      payload: '{"input":',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: "BAD_REQUEST" });

    const media = await target.inject({
      method: "POST",
      url: `/v1/services/${serviceId}/runs`,
      headers: { "content-type": "text/plain" },
      payload: "not-json",
    });
    expect(media.statusCode).toBe(415);
    expect(media.json()).toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });
  });
});
