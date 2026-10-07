import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import { createCsrfService } from "../../src/helpers/csrf.js";
import {
  RunCancellationNotFoundError,
  RunCancellationStateConflictError,
  RunCancellationUnavailableError,
  type CancelRunRepository,
} from "../../src/services/admission/cancelRunRepository.js";
import { createCancelRunService } from "../../src/services/admission/cancelRunService.js";
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
  stubCreateRunService,
  stubCreateServiceService,
  stubGetRunService,
  stubGetServiceService,
  stubListRunsService,
  stubListServicesService,
} from "../support/serviceStub.js";

const TOKEN_SECRET = "test-access-token-secret-at-least-32-chars";
const ACCESS_TOKEN = "header.payload.signature";
const API_KEY = `dhk_v1_${"A".repeat(16)}.${"A".repeat(43)}`;
const tenantId = randomUUID();
const runId = randomUUID();
const serviceId = randomUUID();
const session: TrustedSessionIdentity = {
  userId: randomUUID(),
  sessionId: randomUUID(),
};
const accepted = {
  id: runId,
  service_id: serviceId,
  status: "queued" as const,
  error_code: null,
  retryable: false,
  created_at: "2026-08-25T12:00:00.000Z",
  updated_at: "2026-08-25T12:00:00.000Z",
  completed_at: null,
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
  repository: CancelRunRepository,
): Promise<FastifyInstance> {
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
    browserAuthenticationService: browserAuthentication(),
    logoutService: { async logout() { throw new Error("unexpected"); } },
    tenantAuthorizationService: tenantAuthorization,
    workspaceService: { async getWorkspace() { throw new Error("unexpected"); } },
    listCatalogTemplatesService: stubListCatalogTemplatesService,
    getCatalogTemplateService: stubGetCatalogTemplateService,
    listServicesService: stubListServicesService,
    createServiceService: stubCreateServiceService,
    getServiceService: stubGetServiceService,
    createRunService: stubCreateRunService,
    listRunsService: stubListRunsService,
    getRunService: stubGetRunService,
    cancelRunService: createCancelRunService({
      repository,
      csrf: createCsrfService(TOKEN_SECRET),
    }),
  });
  return app;
}

describe("POST /v1/runs/{run_id}/cancel contract", () => {
  it("rejects a retired customer API key before persistence even with a CSRF header", async () => {
    const persist = vi.fn<CancelRunRepository["persist"]>();
    const response = await (await build({ persist })).inject({
      method: "POST",
      url: `/v1/runs/${runId}/cancel`,
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "x-csrf-token": createCsrfService(TOKEN_SECRET).issue(session.sessionId),
        "idempotency-key": "cancel-run-api-key-denied",
      },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    expect(persist).not.toHaveBeenCalled();
  });

  it("accepts a browser session and emits only the exact queued Run", async () => {
    const persist = vi.fn<CancelRunRepository["persist"]>(async () => ({
      kind: "accepted",
      run: { ...accepted, provider_id: "must-be-stripped" } as typeof accepted,
    }));
    const response = await (await build({ persist })).inject({
      method: "POST",
      url: `/v1/runs/${runId}/cancel`,
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "x-csrf-token": createCsrfService(TOKEN_SECRET).issue(session.sessionId),
        "idempotency-key": "cancel-run-contract-0001",
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual(accepted);
    expect(response.body).not.toContain("provider_id");
    expect(persist.mock.calls[0]?.[0]).toMatchObject({
      tenantId,
      runId,
      actor: { kind: "browser", userId: session.userId },
    });
  });

  it("requires browser CSRF before resource handling", async () => {
    const persist = vi.fn<CancelRunRepository["persist"]>(async () => ({
      kind: "replay",
      run: accepted,
    }));
    const missing = await (await build({ persist })).inject({
      method: "POST",
      url: "/v1/runs/not-a-uuid/cancel",
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "idempotency-key": "cancel-run-contract-0002",
      },
    });
    expect(missing.statusCode).toBe(403);
    expect(persist).not.toHaveBeenCalled();
    await app?.close();
    app = undefined;

    const token = createCsrfService(TOKEN_SECRET).issue(session.sessionId);
    const success = await (await build({ persist })).inject({
      method: "POST",
      url: `/v1/runs/${runId}/cancel`,
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "x-csrf-token": token,
        "idempotency-key": "cancel-run-contract-0003",
      },
    });
    expect(success.statusCode).toBe(202);
  });

  it("enforces idempotency and non-enumerating Run identifiers", async () => {
    const persist = vi.fn<CancelRunRepository["persist"]>();
    const malformed = await (await build({ persist })).inject({
      method: "POST",
      url: "/v1/runs/not-a-uuid/cancel",
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "x-csrf-token": createCsrfService(TOKEN_SECRET).issue(session.sessionId),
        "idempotency-key": "cancel-run-contract-0005",
      },
    });
    expect(malformed.statusCode).toBe(404);

    const missingKey = await (await build({ persist })).inject({
      method: "POST",
      url: `/v1/runs/${runId}/cancel`,
      headers: { authorization: `Bearer ${ACCESS_TOKEN}`, "x-csrf-token": createCsrfService(TOKEN_SECRET).issue(session.sessionId) },
    });
    expect(missingKey.statusCode).toBe(422);
    expect(persist).not.toHaveBeenCalled();
  });

  it.each([
    { payload: "{}", label: "object" },
    { payload: "null", label: "null" },
    { payload: "[]", label: "array" },
  ])("rejects an unexpected $label body", async ({ payload }) => {
    const persist = vi.fn<CancelRunRepository["persist"]>();
    const response = await (await build({ persist })).inject({
      method: "POST",
      url: `/v1/runs/${runId}/cancel`,
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "x-csrf-token": createCsrfService(TOKEN_SECRET).issue(session.sessionId),
        "idempotency-key": "cancel-run-contract-body",
        "content-type": "application/json",
      },
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "BAD_REQUEST" });
    expect(persist).not.toHaveBeenCalled();
  });

  it("returns the declared parser, media and body-limit Problems", async () => {
    const persist = vi.fn<CancelRunRepository["persist"]>();
    const target = await build({ persist });

    const malformed = await target.inject({
      method: "POST",
      url: `/v1/runs/${runId}/cancel`,
      headers: { "content-type": "application/json" },
      payload: '{"unexpected":',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: "BAD_REQUEST" });

    const media = await target.inject({
      method: "POST",
      url: `/v1/runs/${runId}/cancel`,
      headers: { "content-type": "application/xml" },
      payload: "<cancel />",
    });
    expect(media.statusCode).toBe(415);
    expect(media.json()).toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });

    const oversized = await target.inject({
      method: "POST",
      url: `/v1/runs/${runId}/cancel`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ value: "x".repeat(1_048_576) }),
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  it.each([
    [new RunCancellationNotFoundError(), 404, "RESOURCE_NOT_FOUND"],
    [new RunCancellationStateConflictError(), 409, "STATE_CONFLICT"],
    [new RunCancellationUnavailableError(), 503, "SERVICE_UNAVAILABLE"],
  ])("serializes the declared domain Problem", async (error, status, code) => {
    const target = await build({ async persist() { throw error; } });
    const response = await target.inject({
      method: "POST",
      url: `/v1/runs/${runId}/cancel`,
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "x-csrf-token": createCsrfService(TOKEN_SECRET).issue(session.sessionId),
        "idempotency-key": `cancel-run-domain-${status}`,
      },
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code });
  });
});
