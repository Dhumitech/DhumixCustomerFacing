import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadRuntimeConfig, type RuntimeConfig } from "../../src/config/environment.js";
import type {
  ApiKeyPage,
  ListApiKeysRequest,
  ListApiKeysService,
} from "../../src/services/apiKeys/listApiKeysService.js";
import { createListApiKeysService } from "../../src/services/apiKeys/listApiKeysService.js";
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
  TenantAuthorizationService,
  TrustedTenantIdentity,
} from "../../src/services/tenantAccess/tenantAuthorizationService.js";
import { workspaceUnavailable } from "../../src/services/tenantAccess/tenantAccessErrors.js";
import type { WorkspaceService } from "../../src/services/workspace/workspaceService.js";
import {
  stubApiKeyAuthenticationService,
  stubCreateApiKeyService,
  stubRevokeApiKeyService,
} from "../support/apiKeyStub.js";
import {
  stubGetCatalogTemplateService,
  stubListCatalogTemplatesService,
} from "../support/catalogueStub.js";
import { stubCreateServiceService, stubGetServiceService, stubListServicesService } from "../support/serviceStub.js";

const ACCESS_TOKEN = "header.payload.signature";
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
const page: ApiKeyPage = {
  data: [
    {
      id: randomUUID(),
      name: "CI key",
      prefix: "dhk_v1_AAAAAAAAAAAAAAAA",
      scopes: ["runs:read"],
      state: "active",
      created_at: "2026-08-24T00:00:00.000Z",
      last_used_at: null,
      expires_at: null,
      revoked_at: null,
    },
  ],
  page: { next_cursor: null, has_more: false },
};

const stubSignupService: SignupService = { async submit() { throw new Error("unexpected"); } };
const stubSignInService: SignInService = { async authenticate() { throw new Error("unexpected"); } };
const stubRefreshService: RefreshService = { async refresh() { throw new Error("unexpected"); } };
const stubLogoutService: LogoutService = { async logout() { throw new Error("unexpected"); } };
const stubWorkspaceService: WorkspaceService = { async getWorkspace() { throw new Error("unexpected"); } };

interface RecordingListService extends ListApiKeysService {
  readonly calls: ListApiKeysRequest[];
  failWith?: Error;
}

function listService(): RecordingListService {
  const calls: ListApiKeysRequest[] = [];
  const implementation = createListApiKeysService({
    repository: {
      async list() {
        const key = page.data[0]!;
        return [
          {
            id: key.id,
            name: key.name,
            prefix: key.prefix,
            scopes: key.scopes,
            state: key.state,
            createdAt: new Date(key.created_at),
            lastUsedAt: null,
            expiresAt: null,
            revokedAt: null,
          },
        ];
      },
    },
  });
  const service: RecordingListService = {
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
let service: RecordingListService;
let tenant: SwitchableTenantAuthorization;

beforeEach(() => {
  service = listService();
  tenant = tenantAuthorization();
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
    listApiKeysService: service,
    revokeApiKeyService: stubRevokeApiKeyService,
    apiKeyAuthenticationService: stubApiKeyAuthenticationService,
    listCatalogTemplatesService: stubListCatalogTemplatesService,
    getCatalogTemplateService: stubGetCatalogTemplateService,
    listServicesService: stubListServicesService,
    createServiceService: stubCreateServiceService,
    getServiceService: stubGetServiceService,
  });
  return app;
}

describe("GET /v1/keys contract", () => {
  it("returns exactly ApiKeyPage using the trusted Tenant and parsed query values", async () => {
    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/keys?limit=1",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(page);
    expect(service.calls).toEqual([
      {
        identity: tenantIdentity,
        cursor: undefined,
        limit: "1",
        schemaErrors: [],
      },
    ]);
  });

  it("requires browser authentication before Tenant authorization or listing", async () => {
    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/keys?limit=not-an-integer",
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe("Bearer");
    expect(response.json()).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    expect(service.calls).toHaveLength(0);
  });

  it("keeps API-key management browser-only", async () => {
    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/keys",
      headers: {
        authorization: `Bearer dhk_v1_${"A".repeat(16)}.${"A".repeat(43)}`,
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    expect(service.calls).toHaveLength(0);
  });

  it("returns the generic 403 when current Tenant authorization is unavailable", async () => {
    tenant.failWith = workspaceUnavailable();
    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/keys?cursor=",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "ACCESS_DENIED" });
    expect(service.calls).toHaveLength(0);
  });

  it("maps malformed, repeated, unknown, and out-of-range query input to declared 422", async () => {
    const instance = await build();
    const invalidQueries = [
      "?extra=1",
      "?limit=1&limit=2",
      "?limit=0",
      "?limit=101",
      "?limit=1.5",
      "?cursor=",
      "?cursor=not-a-cursor",
    ];

    for (const query of invalidQueries) {
      const response = await instance.inject({
        method: "GET",
        url: `/v1/keys${query}`,
        headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
      });
      expect(response.statusCode).toBe(422);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.json()).toMatchObject({ code: "VALIDATION_ERROR", status: 422 });
      expect(response.body).not.toContain("not-a-cursor");
    }
  });

  it("serializes only public metadata even if an upstream object contains sensitive fields", async () => {
    const calls: ListApiKeysRequest[] = [];
    service = {
      calls,
      async list(request) {
        calls.push(request);
        return {
          data: [
            {
              ...page.data[0]!,
              tenant_id: tenantIdentity.tenantId,
              creator_user_id: tenantIdentity.userId,
              key_hash: "forbidden-verifier-hash",
              secret: "forbidden-plaintext-secret",
            },
          ],
          page: { ...page.page, internal_count: 1 },
          internal: true,
        };
      },
    };

    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/keys",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json<Record<string, unknown>>()).sort()).toEqual(["data", "page"]);
    expect(Object.keys(response.json<{ data: Record<string, unknown>[] }>().data[0]!).sort()).toEqual([
      "created_at",
      "expires_at",
      "id",
      "last_used_at",
      "name",
      "prefix",
      "revoked_at",
      "scopes",
      "state",
    ]);
    expect(response.body).not.toMatch(/forbidden|key_hash|creator_user_id|tenant_id|secret/);
  });

  it("returns a generic correlated 500 without database details", async () => {
    service.failWith = Object.assign(
      new Error('permission denied for relation "app.platform_api_keys"'),
      { code: "42501" },
    );
    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/keys?limit=1",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      code: "INTERNAL_ERROR",
      instance: "/v1/keys",
    });
    expect(response.body).not.toMatch(/platform_api_keys|42501|permission denied/i);
  });
});
