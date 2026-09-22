import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadRuntimeConfig, type RuntimeConfig } from "../../src/config/environment.js";
import { encodeRunListCursor } from "../../src/helpers/runListCursor.js";
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
import type {
  ListRunsRequest,
  ListRunsService,
  RunPage,
} from "../../src/services/runQuery/listRunsService.js";
import { createListRunsService } from "../../src/services/runQuery/listRunsService.js";
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
  stubListServicesService,
} from "../support/serviceStub.js";

const ACCESS_TOKEN = "header.payload.signature";
const API_KEY = `dhk_v1_${"A".repeat(16)}.${"A".repeat(43)}`;
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
const createdAt = "2026-08-25T12:00:00.000Z";
const runId = randomUUID();
const serviceId = randomUUID();
const page: RunPage = {
  data: [
    {
      id: runId,
      service_id: serviceId,
      status: "queued",
      error_code: null,
      retryable: false,
      created_at: createdAt,
      updated_at: createdAt,
      completed_at: null,
    },
  ],
  page: { next_cursor: null, has_more: false },
};

const stubSignupService: SignupService = {
  async submit() {
    throw new Error("unexpected");
  },
};
const stubSignInService: SignInService = {
  async authenticate() {
    throw new Error("unexpected");
  },
};
const stubRefreshService: RefreshService = {
  async refresh() {
    throw new Error("unexpected");
  },
};
const stubLogoutService: LogoutService = {
  async logout() {
    throw new Error("unexpected");
  },
};
const stubWorkspaceService: WorkspaceService = {
  async getWorkspace() {
    throw new Error("unexpected");
  },
};

interface RecordingService extends ListRunsService {
  readonly calls: ListRunsRequest[];
  failWith?: Error;
}

function listService(): RecordingService {
  const calls: ListRunsRequest[] = [];
  const implementation = createListRunsService({
    repository: {
      async list() {
        const run = page.data[0]!;
        return [
          {
            id: run.id,
            serviceId: run.service_id,
            status: run.status,
            customerErrorCode: run.error_code,
            retryable: run.retryable,
            createdAt: new Date(run.created_at),
            updatedAt: new Date(run.updated_at),
            completedAt: run.completed_at === null ? null : new Date(run.completed_at),
          },
        ];
      },
    },
  });
  const service: RecordingService = {
    calls,
    async list(request) {
      calls.push(request);
      if (service.failWith !== undefined) throw service.failWith;
      return implementation.list(request);
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

interface SwitchableTenantAuthorization extends TenantAuthorizationService {
  failWith?: Error;
}

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
let runs: RecordingService;
let tenant: SwitchableTenantAuthorization;
let apiKeyAuth: SwitchableApiKeyAuthentication;

beforeEach(() => {
  runs = listService();
  tenant = tenantAuthorization();
  apiKeyAuth = apiKeyAuthentication();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(): Promise<FastifyInstance> {
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
    listRunsService: runs,
  });
  return app;
}

describe("GET /v1/runs contract", () => {
  it("returns the exact RunPage from a trusted browser principal", async () => {
    const requestId = randomUUID();
    const response = await (await build()).inject({
      method: "GET",
      url: `/v1/runs?status=queued&service_id=${serviceId}&limit=1`,
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "x-request-id": requestId,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe(requestId);
    expect(response.json()).toEqual(page);
    expect(response.json<{ data: Record<string, unknown>[] }>().data[0]).not.toHaveProperty(
      "progress_message",
    );
    expect(runs.calls).toEqual([
      {
        principal: { kind: "browser", ...tenantIdentity },
        status: "queued",
        serviceId,
        cursor: undefined,
        limit: "1",
        schemaErrors: [],
      },
    ]);
  });

  it("accepts runs:read and denies a Dhumi key without the scope", async () => {
    const instance = await build();
    const accepted = await instance.inject({
      method: "GET",
      url: "/v1/runs",
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(accepted.statusCode).toBe(200);
    expect(runs.calls[0]?.principal).toEqual(apiKeyIdentity);

    runs.calls.length = 0;
    apiKeyAuth.identity = { ...apiKeyIdentity, scopes: ["runs:write"] };
    const denied = await instance.inject({
      method: "GET",
      url: "/v1/runs",
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "ACCESS_DENIED" });
    expect(runs.calls).toHaveLength(0);
  });

  it("authenticates before exposing invalid query behavior", async () => {
    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/runs?status=private",
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe("Bearer");
    expect(response.json()).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    expect(runs.calls).toHaveLength(0);
  });

  it("returns 403 when the browser Tenant is unavailable", async () => {
    tenant.failWith = workspaceUnavailable();
    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/runs",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "ACCESS_DENIED" });
    expect(runs.calls).toHaveLength(0);
  });

  it("maps invalid status, cursor, limit, repeated, and unknown input to 422", async () => {
    const instance = await build();
    const queuedCursor = encodeRunListCursor({
      statusFilter: "queued",
      createdAt,
      id: runId,
    });
    const invalidQueries = [
      "?extra=1",
      "?status=QUEUED",
      "?status=queued&status=ready",
      "?limit=0",
      "?limit=101",
      "?limit=1.5",
      "?limit=1&limit=2",
      "?service_id=not-a-uuid",
      "?cursor=",
      "?cursor=not-a-cursor",
      `?status=ready&cursor=${queuedCursor}`,
    ];

    for (const query of invalidQueries) {
      const response = await instance.inject({
        method: "GET",
        url: `/v1/runs${query}`,
        headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
      });
      expect(response.statusCode).toBe(422);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.json()).toMatchObject({ code: "VALIDATION_ERROR", status: 422 });
      expect(response.body).not.toContain("not-a-cursor");
    }
  });

  it("serializes only the approved Run fields", async () => {
    runs = {
      calls: [],
      async list() {
        return {
          data: [
            {
              ...page.data[0]!,
              tenant_id: "forbidden-tenant",
              service_version_id: "forbidden-version",
              internal_status: "QUEUED",
              validated_input: { provider_resource: "forbidden-provider" },
              provider_mapping_id: "forbidden-mapping",
              accepted_at: "forbidden-timestamp",
            },
          ],
          page: { ...page.page, internal_count: 1 },
          internal: true,
        };
      },
    };

    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/runs",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json<Record<string, unknown>>()).sort()).toEqual([
      "data",
      "page",
    ]);
    expect(
      Object.keys(response.json<{ data: Record<string, unknown>[] }>().data[0]!).sort(),
    ).toEqual([
      "completed_at",
      "created_at",
      "error_code",
      "id",
      "retryable",
      "service_id",
      "status",
      "updated_at",
    ]);
    expect(response.body).not.toMatch(
      /forbidden|tenant_id|service_version|internal_status|validated_input|provider/i,
    );
  });

  it("returns a correlated generic 500 without database/provider details", async () => {
    runs.failWith = Object.assign(
      new Error('permission denied for relation "app.service_versions"'),
      { code: "42501", provider_error: "Bright Data account detail" },
    );
    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/runs",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      code: "INTERNAL_ERROR",
      instance: "/v1/runs",
    });
    expect(response.body).not.toMatch(/service_versions|42501|permission denied|Bright Data/i);
  });

  it("does not require cookies or CSRF for this read-only operation", async () => {
    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/runs",
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(response.statusCode).toBe(200);
  });
});
