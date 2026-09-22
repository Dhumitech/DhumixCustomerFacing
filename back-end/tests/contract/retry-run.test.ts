import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import { createCsrfService } from "../../src/helpers/csrf.js";
import type {
  ApiKeyAuthenticationService,
  TrustedApiKeyIdentity,
} from "../../src/services/apiKeys/apiKeyAuthenticationService.js";
import {
  RunRetryNotFoundError,
  RunRetryStateConflictError,
  RunRetryUnavailableError,
  type RetryRunRepository,
} from "../../src/services/admission/retryRunRepository.js";
import { createRetryRunService } from "../../src/services/admission/retryRunService.js";
import type {
  BrowserAuthenticationService,
  TrustedSessionIdentity,
} from "../../src/services/identity/browserAuthenticationService.js";
import { authenticationRequired } from "../../src/services/identity/sessionErrors.js";
import type { TenantAuthorizationService } from "../../src/services/tenantAccess/tenantAuthorizationService.js";
import {
  stubCreateApiKeyService,
  stubListApiKeysService,
  stubRevokeApiKeyService,
} from "../support/apiKeyStub.js";
import {
  stubGetCatalogTemplateService,
  stubListCatalogTemplatesService,
} from "../support/catalogueStub.js";
import {
  stubCancelRunService,
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
const sourceRunId = randomUUID();
const session: TrustedSessionIdentity = {
  userId: randomUUID(),
  sessionId: randomUUID(),
  issuedTenantId: tenantId,
};
const apiKeyIdentity: TrustedApiKeyIdentity = {
  kind: "api_key",
  apiKeyId: randomUUID(),
  tenantId,
  scopes: ["runs:write"],
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
    RESPONSE_ENVELOPE_LOCAL_KEY: "A".repeat(43),
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

function apiKeyAuthentication(
  identity: TrustedApiKeyIdentity = apiKeyIdentity,
): ApiKeyAuthenticationService {
  return {
    async authenticate(authorization) {
      if (authorization !== `Bearer ${API_KEY}`) throw authenticationRequired();
      return identity;
    },
  };
}

async function build(
  repository: RetryRunRepository,
  apiKeyAuth: ApiKeyAuthenticationService = apiKeyAuthentication(),
): Promise<FastifyInstance> {
  const tenantAuthorization: TenantAuthorizationService = {
    async authorizeBrowserTenant(identity) {
      return { userId: identity.userId, sessionId: identity.sessionId, tenantId };
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
    createApiKeyService: stubCreateApiKeyService,
    listApiKeysService: stubListApiKeysService,
    revokeApiKeyService: stubRevokeApiKeyService,
    apiKeyAuthenticationService: apiKeyAuth,
    listCatalogTemplatesService: stubListCatalogTemplatesService,
    getCatalogTemplateService: stubGetCatalogTemplateService,
    listServicesService: stubListServicesService,
    createServiceService: stubCreateServiceService,
    getServiceService: stubGetServiceService,
    createRunService: stubCreateRunService,
    listRunsService: stubListRunsService,
    getRunService: stubGetRunService,
    cancelRunService: stubCancelRunService,
    retryRunService: createRetryRunService({
      repository,
      validator: {
        validate() {
          return { valid: true, schemaHash: Buffer.alloc(32, 7) };
        },
      },
      csrf: createCsrfService(TOKEN_SECRET),
      providerEnvironment: "test",
    }),
  });
  return app;
}

describe("POST /v1/runs/{run_id}/retry contract", () => {
  it("accepts a scoped API key and serializes only RunAccepted", async () => {
    const persist = vi.fn<RetryRunRepository["persist"]>(async () => ({
      kind: "created",
      run: { ...accepted, provider_id: "must-be-stripped" } as typeof accepted,
    }));
    const response = await (await build({ persist })).inject({
      method: "POST",
      url: `/v1/runs/${sourceRunId}/retry`,
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "idempotency-key": "retry-run-contract-0001",
      },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual(accepted);
    expect(response.body).not.toContain("provider_id");
    expect(persist.mock.calls[0]?.[0]).toMatchObject({
      tenantId,
      sourceRunId,
      actor: { kind: "api_key", apiKeyId: apiKeyIdentity.apiKeyId },
    });
  });

  it("requires browser CSRF before resource handling", async () => {
    const persist = vi.fn<RetryRunRepository["persist"]>(async () => ({
      kind: "replay",
      run: accepted,
    }));
    const denied = await (await build({ persist })).inject({
      method: "POST",
      url: "/v1/runs/not-a-uuid/retry",
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "idempotency-key": "retry-run-contract-0002",
      },
    });
    expect(denied.statusCode).toBe(403);
    expect(persist).not.toHaveBeenCalled();
    await app?.close();
    app = undefined;

    const response = await (await build({ persist })).inject({
      method: "POST",
      url: `/v1/runs/${sourceRunId}/retry`,
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "x-csrf-token": createCsrfService(TOKEN_SECRET).issue(session.sessionId),
        "idempotency-key": "retry-run-contract-0003",
      },
    });
    expect(response.statusCode).toBe(202);
  });

  it("enforces scope, idempotency and non-enumerating source IDs", async () => {
    const persist = vi.fn<RetryRunRepository["persist"]>();
    const deniedIdentity = { ...apiKeyIdentity, scopes: ["runs:read"] as const };
    const denied = await (
      await build({ persist }, apiKeyAuthentication(deniedIdentity))
    ).inject({
      method: "POST",
      url: `/v1/runs/${sourceRunId}/retry`,
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "idempotency-key": "retry-run-contract-0004",
      },
    });
    expect(denied.statusCode).toBe(403);
    await app?.close();
    app = undefined;

    const malformed = await (await build({ persist })).inject({
      method: "POST",
      url: "/v1/runs/not-a-uuid/retry",
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "idempotency-key": "retry-run-contract-0005",
      },
    });
    expect(malformed.statusCode).toBe(404);

    const missingKey = await (await build({ persist })).inject({
      method: "POST",
      url: `/v1/runs/${sourceRunId}/retry`,
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(missingKey.statusCode).toBe(422);
    expect(persist).not.toHaveBeenCalled();
  });

  it("rejects every supplied body", async () => {
    const persist = vi.fn<RetryRunRepository["persist"]>();
    const response = await (await build({ persist })).inject({
      method: "POST",
      url: `/v1/runs/${sourceRunId}/retry`,
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "idempotency-key": "retry-run-contract-body",
        "content-type": "application/json",
      },
      payload: "{}",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "BAD_REQUEST" });
    expect(persist).not.toHaveBeenCalled();
  });

  it("returns the shared parser, media and body-limit Problems", async () => {
    const persist = vi.fn<RetryRunRepository["persist"]>();
    const target = await build({ persist });
    const malformed = await target.inject({
      method: "POST",
      url: `/v1/runs/${sourceRunId}/retry`,
      headers: { "content-type": "application/json" },
      payload: '{"unexpected":',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: "BAD_REQUEST" });

    const media = await target.inject({
      method: "POST",
      url: `/v1/runs/${sourceRunId}/retry`,
      headers: { "content-type": "application/xml" },
      payload: "<retry />",
    });
    expect(media.statusCode).toBe(415);
    expect(media.json()).toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });

    const oversized = await target.inject({
      method: "POST",
      url: `/v1/runs/${sourceRunId}/retry`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ value: "x".repeat(1_048_576) }),
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  it.each([
    [new RunRetryNotFoundError(), 404, "RESOURCE_NOT_FOUND"],
    [new RunRetryStateConflictError(), 409, "STATE_CONFLICT"],
    [new RunRetryUnavailableError(), 503, "SERVICE_UNAVAILABLE"],
  ])("serializes a declared retry domain Problem", async (error, status, code) => {
    const target = await build({ async persist() { throw error; } });
    const response = await target.inject({
      method: "POST",
      url: `/v1/runs/${sourceRunId}/retry`,
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "idempotency-key": `retry-run-domain-${status}`,
      },
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code });
  });
});
