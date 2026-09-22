import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadRuntimeConfig, type RuntimeConfig } from "../../src/config/environment.js";
import type {
  ApiKeyAuthenticationService,
  TrustedApiKeyIdentity,
} from "../../src/services/apiKeys/apiKeyAuthenticationService.js";
import type {
  BrowserAuthenticationService,
  TrustedSessionIdentity,
} from "../../src/services/identity/browserAuthenticationService.js";
import type { LogoutService } from "../../src/services/identity/logoutService.js";
import type { RefreshService } from "../../src/services/identity/refreshService.js";
import { authenticationRequired } from "../../src/services/identity/sessionErrors.js";
import type { SignInService } from "../../src/services/identity/signInService.js";
import type { SignupService } from "../../src/services/identity/signupService.js";
import type { GetRunRecord } from "../../src/services/runQuery/getRunRepository.js";
import {
  createGetRunService,
  type GetRunRequest,
  type GetRunService,
} from "../../src/services/runQuery/getRunService.js";
import { workspaceUnavailable } from "../../src/services/tenantAccess/tenantAccessErrors.js";
import type {
  TenantAuthorizationService,
  TrustedTenantIdentity,
} from "../../src/services/tenantAccess/tenantAuthorizationService.js";
import type { WorkspaceService } from "../../src/services/workspace/workspaceService.js";
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
  stubCreateRunService,
  stubCreateServiceService,
  stubGetServiceService,
  stubListRunsService,
  stubListServicesService,
} from "../support/serviceStub.js";

const ACCESS_TOKEN = "header.payload.signature";
const API_KEY = `dhk_v1_${"A".repeat(16)}.${"A".repeat(43)}`;
const runId = "44444444-4444-4444-8444-444444444444";
const serviceId = "55555555-5555-4555-8555-555555555555";
const sessionIdentity: TrustedSessionIdentity = {
  userId: randomUUID(),
  sessionId: randomUUID(),
  issuedTenantId: randomUUID(),
};
const tenantIdentity: TrustedTenantIdentity = {
  userId: sessionIdentity.userId,
  sessionId: sessionIdentity.sessionId,
  tenantId: sessionIdentity.issuedTenantId,
};
const apiKeyIdentity: TrustedApiKeyIdentity = {
  kind: "api_key",
  apiKeyId: randomUUID(),
  tenantId: tenantIdentity.tenantId,
  scopes: ["runs:read"],
};
const record: GetRunRecord = {
  id: runId,
  serviceId,
  status: "queued",
  customerErrorCode: null,
  retryable: false,
  createdAt: new Date("2026-08-25T12:00:00.000Z"),
  updatedAt: new Date("2026-08-25T12:00:00.000Z"),
  completedAt: null,
};
const detail = {
  id: runId,
  service_id: serviceId,
  status: "queued",
  error_code: null,
  retryable: false,
  created_at: "2026-08-25T12:00:00.000Z",
  updated_at: "2026-08-25T12:00:00.000Z",
  completed_at: null,
} as const;

const stubSignupService: SignupService = { async submit() { throw new Error("unexpected"); } };
const stubSignInService: SignInService = { async authenticate() { throw new Error("unexpected"); } };
const stubRefreshService: RefreshService = { async refresh() { throw new Error("unexpected"); } };
const stubLogoutService: LogoutService = { async logout() { throw new Error("unexpected"); } };
const stubWorkspaceService: WorkspaceService = { async getWorkspace() { throw new Error("unexpected"); } };

interface RecordingGetRun extends GetRunService {
  readonly calls: GetRunRequest[];
  result: GetRunRecord | undefined;
  failWith?: Error;
}

function getRunService(): RecordingGetRun {
  const calls: GetRunRequest[] = [];
  const service: RecordingGetRun = {
    calls,
    result: record,
    async get(request) {
      calls.push(request);
      if (service.failWith !== undefined) throw service.failWith;
      return createGetRunService({
        repository: { async findById() { return service.result; } },
      }).get(request);
    },
  };
  return service;
}

function browserAuthentication(): BrowserAuthenticationService {
  return {
    async authenticate(authorization) {
      if (authorization !== `Bearer ${ACCESS_TOKEN}`) throw authenticationRequired();
      return sessionIdentity;
    },
  };
}

interface SwitchableTenantAuthorization extends TenantAuthorizationService { failWith?: Error }

function tenantAuthorization(): SwitchableTenantAuthorization {
  const service: SwitchableTenantAuthorization = {
    async authorizeBrowserTenant(identity) {
      if (service.failWith !== undefined) throw service.failWith;
      expect(identity).toEqual(sessionIdentity);
      return tenantIdentity;
    },
  };
  return service;
}

interface SwitchableApiKeyAuthentication extends ApiKeyAuthenticationService {
  identity: TrustedApiKeyIdentity;
}

function apiKeyAuthentication(): SwitchableApiKeyAuthentication {
  const service: SwitchableApiKeyAuthentication = {
    identity: apiKeyIdentity,
    async authenticate(authorization) {
      if (authorization !== `Bearer ${API_KEY}`) throw authenticationRequired();
      return service.identity;
    },
  };
  return service;
}

function config(): RuntimeConfig {
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
    ACCESS_TOKEN_SECRET: "test-access-token-secret-at-least-32-chars",
    ACCESS_TOKEN_ISSUER: "https://dhumi.test",
    ACCESS_TOKEN_AUDIENCE: "dhumi-browser",
    RESPONSE_ENVELOPE_LOCAL_KEY: "A".repeat(43),
  });
}

let app: FastifyInstance | undefined;
let runs: RecordingGetRun;
let tenant: SwitchableTenantAuthorization;
let apiKeyAuth: SwitchableApiKeyAuthentication;

beforeEach(() => {
  runs = getRunService();
  tenant = tenantAuthorization();
  apiKeyAuth = apiKeyAuthentication();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(implementation: GetRunService = runs): Promise<FastifyInstance> {
  app = await buildApp(config(), {
    signupService: stubSignupService,
    signInService: stubSignInService,
    refreshService: stubRefreshService,
    browserAuthenticationService: browserAuthentication(),
    logoutService: stubLogoutService,
    tenantAuthorizationService: tenant,
    workspaceService: stubWorkspaceService,
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
    getRunService: implementation,
  });
  return app;
}

async function get(
  instance: FastifyInstance,
  id = runId,
  authorization = `Bearer ${ACCESS_TOKEN}`,
) {
  return instance.inject({
    method: "GET",
    url: `/v1/runs/${id}`,
    headers: { authorization },
  });
}

describe("GET /v1/runs/{run_id} contract", () => {
  it("returns the exact Run detail from a trusted browser principal", async () => {
    const requestId = randomUUID();
    const response = await (await build()).inject({
      method: "GET",
      url: `/v1/runs/${runId}`,
      headers: { authorization: `Bearer ${ACCESS_TOKEN}`, "x-request-id": requestId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe(requestId);
    expect(response.json()).toEqual(detail);
    expect(runs.calls).toEqual([{
      principal: { kind: "browser", ...tenantIdentity },
      runId,
      schemaErrors: [],
    }]);
  });

  it("accepts runs:read API keys and rejects a missing scope before lookup", async () => {
    const instance = await build();
    expect((await get(instance, runId, `Bearer ${API_KEY}`)).statusCode).toBe(200);
    expect(runs.calls[0]?.principal).toEqual(apiKeyIdentity);

    runs.calls.length = 0;
    apiKeyAuth.identity = { ...apiKeyIdentity, scopes: ["runs:write"] };
    const denied = await get(instance, runId, `Bearer ${API_KEY}`);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "ACCESS_DENIED" });
    expect(runs.calls).toHaveLength(0);
  });

  it("authenticates before exposing malformed identifier behavior", async () => {
    const response = await get(await build(), "not-a-uuid", "Bearer invalid");

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe("Bearer");
    expect(response.json()).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    expect(runs.calls).toHaveLength(0);
  });

  it("returns generic 403 when the browser Tenant is unavailable", async () => {
    tenant.failWith = workspaceUnavailable();
    const response = await get(await build());

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "ACCESS_DENIED" });
    expect(runs.calls).toHaveLength(0);
  });

  it("maps malformed and invisible IDs to the same safe 404 contract", async () => {
    const instance = await build();
    const malformed = await get(instance, "not-a-uuid");
    runs.result = undefined;
    const invisible = await get(instance, "66666666-6666-4666-8666-666666666666");

    for (const response of [malformed, invisible]) {
      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.json()).toMatchObject({
        status: 404,
        code: "RESOURCE_NOT_FOUND",
        title: "Resource not found",
        detail: null,
      });
      expect(response.json()).not.toHaveProperty("errors");
      expect(response.body).not.toMatch(/validation|exists|tenant|provider/i);
    }
  });

  it("serializes only the eight approved Run fields", async () => {
    const response = await get(await build({
      async get() {
        return {
          ...detail,
          tenant_id: "forbidden-tenant",
          service_version_id: "forbidden-version",
          internal_status: "QUEUED",
          validated_input: { provider_resource: "forbidden-provider" },
          provider_mapping_id: "forbidden-mapping",
          accepted_at: "forbidden-timestamp",
        };
      },
    }));

    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json<Record<string, unknown>>()).sort()).toEqual([
      "completed_at",
      "created_at",
      "error_code",
      "id",
      "retryable",
      "service_id",
      "status",
      "updated_at",
    ]);
    expect(response.json()).not.toHaveProperty("progress_message");
    expect(response.body).not.toMatch(
      /forbidden|tenant_id|service_version|internal_status|validated_input|provider/i,
    );
  });

  it("returns a correlated generic 500 without database or provider details", async () => {
    runs.failWith = Object.assign(
      new Error('permission denied for relation "app.service_versions"'),
      { code: "42501", provider_error: "Bright Data account detail" },
    );
    const response = await get(await build());

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      code: "INTERNAL_ERROR",
      instance: `/v1/runs/${runId}`,
    });
    expect(response.body).not.toMatch(/service_versions|42501|permission denied|Bright Data/i);
  });

  it("does not require cookies or CSRF for this read-only operation", async () => {
    expect((await get(await build(), runId, `Bearer ${API_KEY}`)).statusCode).toBe(200);
  });
});
