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
  ListCatalogTemplatesRequest,
  ListCatalogTemplatesService,
  TemplatePage,
} from "../../src/services/catalogue/listCatalogTemplatesService.js";
import { createListCatalogTemplatesService } from "../../src/services/catalogue/listCatalogTemplatesService.js";
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
  stubCreateApiKeyService,
  stubListApiKeysService,
  stubRevokeApiKeyService,
} from "../support/apiKeyStub.js";
import { stubGetCatalogTemplateService } from "../support/catalogueStub.js";
import { AMAZON_PUBLIC_TEMPLATES } from "../support/amazonCatalogueFixtures.js";
import { stubCreateServiceService, stubGetServiceService, stubListServicesService } from "../support/serviceStub.js";

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
  scopes: ["catalog:read"],
};
const presentation = {
  domain_slug: "amazon-com",
  domain_name: "amazon.com",
  category: "e-commerce",
  icon_key: "amazon",
  operation_group: "Amazon products",
  operation_name: "Collect by URL",
  display_priority: 1,
} as const;
const page: TemplatePage = {
  data: [
    {
      slug: "amazon-products",
      version: 1,
      family: "marketplace_dataset",
      name: "Amazon products",
      description: "Approved product catalogue Template",
      availability: "available",
      presentation,
      configuration_schema: { type: "object", additionalProperties: false },
      input_schema: { type: "object", properties: { query: { type: "string" } } },
    },
  ],
  page: { next_cursor: null, has_more: false },
};

const stubSignupService: SignupService = { async submit() { throw new Error("unexpected"); } };
const stubSignInService: SignInService = { async authenticate() { throw new Error("unexpected"); } };
const stubRefreshService: RefreshService = { async refresh() { throw new Error("unexpected"); } };
const stubLogoutService: LogoutService = { async logout() { throw new Error("unexpected"); } };
const stubWorkspaceService: WorkspaceService = { async getWorkspace() { throw new Error("unexpected"); } };

interface RecordingCatalogueService extends ListCatalogTemplatesService {
  readonly calls: ListCatalogTemplatesRequest[];
  failWith?: Error;
}

function catalogueService(): RecordingCatalogueService {
  const calls: ListCatalogTemplatesRequest[] = [];
  const implementation = createListCatalogTemplatesService({
    repository: {
      async list() {
        const template = page.data[0]!;
        return [
          {
            id: randomUUID(),
            slug: template.slug,
            family: template.family,
            templateState: "published",
            version: template.version,
            name: template.name,
            description: template.description,
            availabilityState: template.availability,
            presentation: template.presentation,
            configurationSchema: template.configuration_schema,
            inputSchema: template.input_schema,
          },
        ];
      },
    },
  });
  const service: RecordingCatalogueService = {
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
let catalogue: RecordingCatalogueService;
let tenant: SwitchableTenantAuthorization;
let apiKeyAuth: SwitchableApiKeyAuthentication;

beforeEach(() => {
  catalogue = catalogueService();
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
    listCatalogTemplatesService: catalogue,
    getCatalogTemplateService: stubGetCatalogTemplateService,
    listServicesService: stubListServicesService,
    createServiceService: stubCreateServiceService,
    getServiceService: stubGetServiceService,
  });
  return app;
}

describe("GET /v1/catalog/templates contract", () => {
  it("returns the exact TemplatePage from a trusted browser principal", async () => {
    const requestId = randomUUID();
    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/catalog/templates?family=marketplace_dataset&limit=1",
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "x-request-id": requestId,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe(requestId);
    expect(response.json()).toEqual(page);
    expect(catalogue.calls).toEqual([
      {
        principal: { kind: "browser", ...tenantIdentity },
        family: "marketplace_dataset",
        cursor: undefined,
        limit: "1",
        schemaErrors: [],
      },
    ]);
  });

  it("accepts a Dhumi API key with catalog:read and rejects one without it", async () => {
    const instance = await build();
    const accepted = await instance.inject({
      method: "GET",
      url: "/v1/catalog/templates",
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(accepted.statusCode).toBe(200);
    expect(catalogue.calls[0]?.principal).toEqual(apiKeyIdentity);

    catalogue.calls.length = 0;
    apiKeyAuth.identity = { ...apiKeyIdentity, scopes: ["runs:read"] };
    const denied = await instance.inject({
      method: "GET",
      url: "/v1/catalog/templates",
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "ACCESS_DENIED" });
    expect(catalogue.calls).toHaveLength(0);
  });

  it("authenticates before exposing invalid query behavior", async () => {
    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/catalog/templates?limit=invalid",
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe("Bearer");
    expect(response.json()).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    expect(catalogue.calls).toHaveLength(0);
  });

  it("returns the generic 403 when the browser Tenant is unavailable", async () => {
    tenant.failWith = workspaceUnavailable();
    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/catalog/templates",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "ACCESS_DENIED" });
    expect(catalogue.calls).toHaveLength(0);
  });

  it("maps malformed, repeated, unknown, and out-of-range query input to 422", async () => {
    const instance = await build();
    const invalidQueries = [
      "?extra=1",
      "?family=unknown",
      "?family=marketplace_dataset&family=scraper_library",
      "?limit=0",
      "?limit=101",
      "?limit=1.5",
      "?cursor=",
      "?cursor=not-a-cursor",
    ];

    for (const query of invalidQueries) {
      const response = await instance.inject({
        method: "GET",
        url: `/v1/catalog/templates${query}`,
        headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
      });
      expect(response.statusCode).toBe(422);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.json()).toMatchObject({ code: "VALIDATION_ERROR", status: 422 });
      expect(response.body).not.toContain("not-a-cursor");
    }
  });

  it("serializes only the accepted public Template fields", async () => {
    catalogue = {
      calls: [],
      async list() {
        return {
          data: [
            {
              ...page.data[0]!,
              id: randomUUID(),
              adapter_version_id: "forbidden-adapter",
              launch_evidence_id: "forbidden-evidence",
              dataset_id: "gd_forbidden123456",
              output_schema: { secret: true },
            },
          ],
          page: { ...page.page, internal_count: 1 },
          internal: true,
        };
      },
    };

    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/catalog/templates",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json<Record<string, unknown>>()).sort()).toEqual(["data", "page"]);
    expect(Object.keys(response.json<{ data: Record<string, unknown>[] }>().data[0]!).sort()).toEqual([
      "availability",
      "configuration_schema",
      "description",
      "family",
      "input_schema",
      "name",
      "presentation",
      "slug",
      "version",
    ]);
    expect(response.body).not.toMatch(/forbidden|adapter|evidence|dataset_id|output_schema/i);
    expect(response.body).not.toMatch(/gd_[a-z0-9]{8,}/i);
  });

  it("serializes all 13 operations with exact public presentation metadata", async () => {
    catalogue = {
      calls: [],
      async list() {
        return {
          data: AMAZON_PUBLIC_TEMPLATES.map((template) => ({
            ...template,
            presentation: {
              ...template.presentation,
              provider_dataset_id: "gd_forbidden123456",
            },
          })),
          page: { next_cursor: null, has_more: false },
        };
      },
    };

    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/catalog/templates?family=scraper_library&limit=100",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<TemplatePage>();
    expect(body.data).toHaveLength(13);
    expect(body.data.map((template) => template.slug)).toEqual(
      AMAZON_PUBLIC_TEMPLATES.map((template) => template.slug),
    );
    for (const template of body.data) {
      expect(Object.keys(template.presentation).sort()).toEqual([
        "category",
        "display_priority",
        "domain_name",
        "domain_slug",
        "icon_key",
        "operation_group",
        "operation_name",
      ]);
    }
    expect(response.body).not.toMatch(/provider_dataset_id|gd_[a-z0-9]{8,}/i);
  });

  it("returns a correlated generic 500 without database or provider details", async () => {
    catalogue.failWith = Object.assign(
      new Error('permission denied for relation "app.service_template_versions"'),
      { code: "42501", provider_error: "Bright Data account detail" },
    );
    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/catalog/templates",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      code: "INTERNAL_ERROR",
      instance: "/v1/catalog/templates",
    });
    expect(response.body).not.toMatch(/service_template|42501|permission denied|Bright Data/i);
  });

  it("does not require cookies or CSRF for this read-only operation", async () => {
    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/catalog/templates",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
  });
});
