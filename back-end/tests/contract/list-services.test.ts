import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadRuntimeConfig, type RuntimeConfig } from "../../src/config/environment.js";
import type {
  ListServicesRequest,
  ListServicesService,
  ServicePage,
} from "../../src/services/customerServices/listServicesService.js";
import { createListServicesService } from "../../src/services/customerServices/listServicesService.js";
import type {
  BrowserAuthenticationService,
  TrustedSessionIdentity,
} from "../../src/services/identity/browserAuthenticationService.js";
import type { LogoutService } from "../../src/services/identity/logoutService.js";
import type { RefreshService } from "../../src/services/identity/refreshService.js";
import { authenticationRequired } from "../../src/services/identity/sessionErrors.js";
import type { SignInService } from "../../src/services/identity/signInService.js";
import type { SignupService } from "../../src/services/identity/signupService.js";
import { workspaceUnavailable } from "../../src/services/tenantAccess/tenantAccessErrors.js";
import type {
  TenantAuthorizationService,
  TrustedTenantIdentity,
} from "../../src/services/tenantAccess/tenantAuthorizationService.js";
import type { WorkspaceService } from "../../src/services/workspace/workspaceService.js";
import {
  stubGetCatalogTemplateService,
  stubListCatalogTemplatesService,
} from "../support/catalogueStub.js";
import { stubCreateServiceService, stubGetServiceService } from "../support/serviceStub.js";

const ACCESS_TOKEN = "header.payload.signature";
const API_KEY = `dhk_v1_${"A".repeat(16)}.${"A".repeat(43)}`;
const organizationId = randomUUID();
const sessionIdentity: TrustedSessionIdentity = {
  userId: randomUUID(),
  sessionId: randomUUID(),
};
const tenantIdentity: TrustedTenantIdentity = {
  userId: sessionIdentity.userId,
  sessionId: sessionIdentity.sessionId,
  tenantId: organizationId,
};
const createdAt = "2026-08-24T12:00:00.000Z";
const page: ServicePage = {
  data: [
    {
      id: randomUUID(),
      name: "Saved marketplace Service",
      template_slug: "amazon-products",
      template_version: 2,
      version: 3,
      family: "marketplace_dataset",
      state: "active",
      created_at: createdAt,
    },
  ],
  page: { next_cursor: null, has_more: false },
};

const stubSignupService: SignupService = { async submit() { throw new Error("unexpected"); } };
const stubSignInService: SignInService = { async authenticate() { throw new Error("unexpected"); } };
const stubRefreshService: RefreshService = { async refresh() { throw new Error("unexpected"); } };
const stubLogoutService: LogoutService = { async logout() { throw new Error("unexpected"); } };
const stubWorkspaceService: WorkspaceService = { async getWorkspace() { throw new Error("unexpected"); } };

interface RecordingService extends ListServicesService {
  readonly calls: ListServicesRequest[];
  failWith?: Error;
}

function listService(): RecordingService {
  const calls: ListServicesRequest[] = [];
  const implementation = createListServicesService({
    repository: {
      async list() {
        const service = page.data[0]!;
        return [
          {
            id: service.id,
            name: service.name,
            templateSlug: service.template_slug,
            templateVersion: service.template_version,
            version: service.version,
            family: service.family,
            state: service.state,
            createdAt: new Date(service.created_at),
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
  });
}

let app: FastifyInstance | undefined;
let services: RecordingService;
let tenant: SwitchableTenantAuthorization;

beforeEach(() => {
  services = listService();
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
    listCatalogTemplatesService: stubListCatalogTemplatesService,
    getCatalogTemplateService: stubGetCatalogTemplateService,
    listServicesService: services,
    createServiceService: stubCreateServiceService,
    getServiceService: stubGetServiceService,
  });
  return app;
}

describe("GET /v1/services contract", () => {
  it("returns the exact ServicePage from a trusted browser principal", async () => {
    const requestId = randomUUID();
    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/services?limit=1",
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "x-request-id": requestId,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe(requestId);
    expect(response.json()).toEqual(page);
    expect(services.calls).toEqual([
      {
        principal: { kind: "browser", ...tenantIdentity },
        cursor: undefined,
        limit: "1",
        schemaErrors: [],
      },
    ]);
  });

  it("rejects retired customer API keys before lookup", async () => {
    const denied = await (await build()).inject({ method: "GET", url: "/v1/services", headers: { authorization: `Bearer ${API_KEY}` } });
    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    expect(services.calls).toHaveLength(0);
  });

  it("authenticates before exposing invalid query behavior", async () => {
    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/services?limit=invalid",
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe("Bearer");
    expect(response.json()).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    expect(services.calls).toHaveLength(0);
  });

  it("returns 403 when the browser Tenant is unavailable", async () => {
    tenant.failWith = workspaceUnavailable();
    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/services",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "ACCESS_DENIED" });
    expect(services.calls).toHaveLength(0);
  });

  it("maps malformed, repeated, unknown, and out-of-range query input to 422", async () => {
    const instance = await build();
    const invalidQueries = [
      "?extra=1",
      "?limit=0",
      "?limit=101",
      "?limit=1.5",
      "?limit=1&limit=2",
      "?cursor=",
      "?cursor=not-a-cursor",
    ];

    for (const query of invalidQueries) {
      const response = await instance.inject({
        method: "GET",
        url: `/v1/services${query}`,
        headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
      });
      expect(response.statusCode).toBe(422);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.json()).toMatchObject({ code: "VALIDATION_ERROR", status: 422 });
      expect(response.body).not.toContain("not-a-cursor");
    }
  });

  it("serializes only the eight public Service fields", async () => {
    services = {
      calls: [],
      async list() {
        return {
          data: [
            {
              ...page.data[0]!,
              tenant_id: "forbidden-tenant",
              configuration: { provider_resource: "forbidden-provider" },
              schema_hash: "forbidden-hash",
              created_by_user_id: "forbidden-user",
            },
          ],
          page: { ...page.page, internal_count: 1 },
          internal: true,
        };
      },
    };

    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/services",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json<Record<string, unknown>>()).sort()).toEqual([
      "data",
      "page",
    ]);
    expect(Object.keys(response.json<{ data: Record<string, unknown>[] }>().data[0]!).sort()).toEqual([
      "created_at",
      "family",
      "id",
      "name",
      "state",
      "template_slug",
      "template_version",
      "version",
    ]);
    expect(response.body).not.toMatch(
      /forbidden|tenant_id|configuration|schema_hash|created_by|provider/i,
    );
  });

  it("returns a correlated generic 500 without database/provider details", async () => {
    services.failWith = Object.assign(
      new Error('permission denied for relation "app.service_versions"'),
      { code: "42501", provider_error: "Bright Data account detail" },
    );
    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/services",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      code: "INTERNAL_ERROR",
      instance: "/v1/services",
    });
    expect(response.body).not.toMatch(/service_versions|42501|permission denied|Bright Data/i);
  });

  it("does not require cookies or CSRF for this read-only operation", async () => {
    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/services",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
  });
});
