import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadRuntimeConfig, type RuntimeConfig } from "../../src/config/environment.js";
import { createCsrfService } from "../../src/helpers/csrf.js";
import type {
  ApiKeyAuthenticationService,
  TrustedApiKeyIdentity,
} from "../../src/services/apiKeys/apiKeyAuthenticationService.js";
import type {
  CreateServiceRepository,
  CreatedService,
} from "../../src/services/customerServices/createServiceRepository.js";
import { createServiceService } from "../../src/services/customerServices/createServiceService.js";
import type {
  BrowserAuthenticationService,
  TrustedSessionIdentity,
} from "../../src/services/identity/browserAuthenticationService.js";
import { authenticationRequired } from "../../src/services/identity/sessionErrors.js";
import type { LogoutService } from "../../src/services/identity/logoutService.js";
import type { RefreshService } from "../../src/services/identity/refreshService.js";
import type { SignInService } from "../../src/services/identity/signInService.js";
import type { SignupService } from "../../src/services/identity/signupService.js";
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
import { stubGetServiceService, stubListServicesService } from "../support/serviceStub.js";

const TOKEN_SECRET = "test-access-token-secret-at-least-32-chars";
const ACCESS_TOKEN = "header.payload.signature";
const API_KEY = `dhk_v1_${"A".repeat(16)}.${"A".repeat(43)}`;
const tenantId = randomUUID();
const sessionIdentity: TrustedSessionIdentity = {
  userId: randomUUID(),
  sessionId: randomUUID(),
  issuedTenantId: tenantId,
};
const tenantIdentity: TrustedTenantIdentity = {
  userId: sessionIdentity.userId,
  sessionId: sessionIdentity.sessionId,
  tenantId,
};
const apiKeyIdentity: TrustedApiKeyIdentity = {
  kind: "api_key",
  apiKeyId: randomUUID(),
  tenantId,
  scopes: ["services:write"],
};
const publicCreated: CreatedService = {
  id: randomUUID(),
  name: "Saved products",
  template_slug: "amazon-products",
  template_version: 2,
  version: 1,
  family: "marketplace_dataset",
  state: "active",
  configuration: { query: "laptop", country: "US" },
  created_at: "2026-08-25T10:00:00.000Z",
};

const stubSignupService: SignupService = { async submit() { throw new Error("unexpected"); } };
const stubSignInService: SignInService = { async authenticate() { throw new Error("unexpected"); } };
const stubRefreshService: RefreshService = { async refresh() { throw new Error("unexpected"); } };
const stubLogoutService: LogoutService = { async logout() { throw new Error("unexpected"); } };
const stubWorkspaceService: WorkspaceService = { async getWorkspace() { throw new Error("unexpected"); } };

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
      return sessionIdentity;
    },
  };
}

function tenantAuthorization(): TenantAuthorizationService {
  return {
    async authorizeBrowserTenant(identity) {
      expect(identity).toEqual(sessionIdentity);
      return tenantIdentity;
    },
  };
}

function apiKeyAuthentication(identity = apiKeyIdentity): ApiKeyAuthenticationService {
  return {
    async authenticate(authorization) {
      if (authorization !== `Bearer ${API_KEY}`) throw authenticationRequired();
      return identity;
    },
  };
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(
  repository: CreateServiceRepository,
  apiKeyAuth: ApiKeyAuthenticationService = apiKeyAuthentication(),
): Promise<FastifyInstance> {
  app = await buildApp(config(), {
    signupService: stubSignupService,
    signInService: stubSignInService,
    refreshService: stubRefreshService,
    browserAuthenticationService: browserAuthentication(),
    logoutService: stubLogoutService,
    tenantAuthorizationService: tenantAuthorization(),
    workspaceService: stubWorkspaceService,
    createApiKeyService: stubCreateApiKeyService,
    listApiKeysService: stubListApiKeysService,
    revokeApiKeyService: stubRevokeApiKeyService,
    apiKeyAuthenticationService: apiKeyAuth,
    listCatalogTemplatesService: stubListCatalogTemplatesService,
    getCatalogTemplateService: stubGetCatalogTemplateService,
    listServicesService: stubListServicesService,
    createServiceService: createServiceService({
      repository,
      validator: {
        validate() {
          return { valid: true, schemaHash: Buffer.alloc(32, 5) };
        },
      },
      csrf: createCsrfService(TOKEN_SECRET),
      providerEnvironment: "test",
    }),
    getServiceService: stubGetServiceService,
  });
  return app;
}

function requestBody(): Record<string, unknown> {
  return {
    template_slug: "amazon-products",
    name: "Saved products",
    configuration: { query: "laptop", country: "US" },
  };
}

describe("POST /v1/services contract", () => {
  it("creates through a browser principal with valid conditional CSRF", async () => {
    const persist = vi.fn<CreateServiceRepository["persist"]>(async () => ({
      kind: "created",
      service: {
        ...publicCreated,
        tenant_id: "must-be-stripped",
        provider_mapping_id: "must-be-stripped",
      } as CreatedService,
    }));
    const csrf = createCsrfService(TOKEN_SECRET).issue(sessionIdentity.sessionId);
    const requestId = randomUUID();
    const response = await (await build({ persist })).inject({
      method: "POST",
      url: "/v1/services",
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "x-csrf-token": csrf,
        "idempotency-key": "create-service-key-0001",
        "x-request-id": requestId,
      },
      payload: requestBody(),
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers["x-request-id"]).toBe(requestId);
    expect(response.json()).toEqual(publicCreated);
    expect(response.body).not.toContain("must-be-stripped");
    expect(persist.mock.calls[0]?.[0]).toMatchObject({
      tenantId,
      actor: { kind: "browser", userId: sessionIdentity.userId },
      providerEnvironment: "test",
    });
  });

  it("accepts a scoped Dhumi API key without CSRF and rejects a missing scope", async () => {
    const persist = vi.fn<CreateServiceRepository["persist"]>(async () => ({
      kind: "replay",
      service: publicCreated,
    }));
    const success = await (await build({ persist })).inject({
      method: "POST",
      url: "/v1/services",
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "idempotency-key": "create-service-key-0002",
      },
      payload: requestBody(),
    });
    expect(success.statusCode).toBe(201);
    expect(persist.mock.calls[0]?.[0].actor).toEqual({
      kind: "api_key",
      apiKeyId: apiKeyIdentity.apiKeyId,
    });
    await app?.close();
    app = undefined;

    const deniedIdentity = { ...apiKeyIdentity, scopes: ["services:read"] as const };
    const denied = await (await build({ persist }, apiKeyAuthentication(deniedIdentity))).inject({
      method: "POST",
      url: "/v1/services",
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "idempotency-key": "create-service-key-0003",
      },
      payload: requestBody(),
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "ACCESS_DENIED" });
  });

  it("fails browser CSRF and malformed input without persistence", async () => {
    const persist = vi.fn<CreateServiceRepository["persist"]>();
    const missingCsrf = await (await build({ persist })).inject({
      method: "POST",
      url: "/v1/services",
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "idempotency-key": "create-service-key-0004",
      },
      payload: requestBody(),
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json()).toMatchObject({ code: "ACCESS_DENIED" });
    await app?.close();
    app = undefined;

    const malformed = await (await build({ persist })).inject({
      method: "POST",
      url: "/v1/services",
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "idempotency-key": "create-service-key-0005",
      },
      payload: { ...requestBody(), unexpected: "rejected" },
    });
    expect(malformed.statusCode).toBe(422);
    expect(malformed.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(persist).not.toHaveBeenCalled();
  });

  it("returns the declared parser and media Problems", async () => {
    const repository: CreateServiceRepository = {
      async persist() {
        throw new Error("persistence must not run");
      },
    };
    const target = await build(repository);
    const malformed = await target.inject({
      method: "POST",
      url: "/v1/services",
      headers: { "content-type": "application/json" },
      payload: '{"name":',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: "BAD_REQUEST" });

    const unsupported = await target.inject({
      method: "POST",
      url: "/v1/services",
      headers: { "content-type": "text/plain" },
      payload: "not-json",
    });
    expect(unsupported.statusCode).toBe(415);
    expect(unsupported.json()).toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });

    const oversized = await target.inject({
      method: "POST",
      url: "/v1/services",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ configuration: { value: "x".repeat(1_048_576) } }),
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });
});
