import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import type { RuntimeConfig } from "../../src/config/environment.js";
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
import { workspaceUnavailable } from "../../src/services/tenantAccess/tenantAccessErrors.js";
import type {
  TenantAuthorizationService,
  TrustedTenantIdentity,
} from "../../src/services/tenantAccess/tenantAuthorizationService.js";
import type { WorkspaceRecord } from "../../src/services/workspace/workspaceRepository.js";
import type { WorkspaceService } from "../../src/services/workspace/workspaceService.js";
import type { TrustedTenantPrincipal } from "../../src/services/tenantAccess/trustedTenantPrincipal.js";
import {
  stubCreateApiKeyService,
  stubListApiKeysService,
  stubRevokeApiKeyService,
} from "../support/apiKeyStub.js";
import {
  stubGetCatalogTemplateService,
  stubListCatalogTemplatesService,
} from "../support/catalogueStub.js";
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
const workspace: WorkspaceRecord = {
  id: tenantIdentity.tenantId,
  name: "Acme Research",
  state: "active",
  createdAt: new Date("2026-08-23T10:20:30.000Z"),
};

const stubSignupService: SignupService = {
  async submit() {
    throw new Error("stub signup service was not expected to be called");
  },
};
const stubSignInService: SignInService = {
  async authenticate() {
    throw new Error("stub sign-in service was not expected to be called");
  },
};
const stubRefreshService: RefreshService = {
  async refresh() {
    throw new Error("stub refresh service was not expected to be called");
  },
};
const stubLogoutService: LogoutService = {
  async logout() {
    throw new Error("stub logout service was not expected to be called");
  },
};

interface RecordingAuthentication extends BrowserAuthenticationService {
  readonly calls: Array<string | undefined>;
}

function recordingAuthentication(): RecordingAuthentication {
  const calls: Array<string | undefined> = [];
  return {
    calls,
    async authenticate(authorization) {
      calls.push(authorization);
      if (authorization !== `Bearer ${ACCESS_TOKEN}`) {
        throw authenticationRequired();
      }
      return sessionIdentity;
    },
  };
}

interface RecordingTenantAuthorization extends TenantAuthorizationService {
  readonly calls: TrustedSessionIdentity[];
  failWith?: Error;
}

function recordingTenantAuthorization(): RecordingTenantAuthorization {
  const calls: TrustedSessionIdentity[] = [];
  const service: RecordingTenantAuthorization = {
    calls,
    async authorizeBrowserTenant(identity) {
      calls.push(identity);
      if (service.failWith !== undefined) {
        throw service.failWith;
      }
      return tenantIdentity;
    },
  };
  return service;
}

interface RecordingWorkspace extends WorkspaceService {
  readonly calls: TrustedTenantPrincipal[];
}

function recordingWorkspace(): RecordingWorkspace {
  const calls: TrustedTenantPrincipal[] = [];
  return {
    calls,
    async getWorkspace(identity) {
      calls.push(identity);
      return workspace;
    },
  };
}

interface RecordingApiKeyAuthentication extends ApiKeyAuthenticationService {
  readonly calls: Array<string | undefined>;
}

function recordingApiKeyAuthentication(): RecordingApiKeyAuthentication {
  const calls: Array<string | undefined> = [];
  return {
    calls,
    async authenticate(authorization) {
      calls.push(authorization);
      if (authorization !== `Bearer ${API_KEY}`) throw authenticationRequired();
      return apiKeyIdentity;
    },
  };
}

function testConfig(): RuntimeConfig {
  return loadRuntimeConfig({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "3000",
    LOG_LEVEL: "silent",
    FRONTEND_ORIGIN: "http://localhost:5173",
    DATABASE_HOST: "localhost",
    DATABASE_PORT: "5432",
    DATABASE_NAME: "dhumi_test",
    DATABASE_IDENTITY_USER: "dhumi_test_identity_login",
    DATABASE_IDENTITY_PASSWORD: "identity-password-at-least-20-characters",
    DATABASE_CUSTOMER_API_USER: "dhumi_test_customer_api_login",
    DATABASE_CUSTOMER_API_PASSWORD: "customer-password-at-least-20-characters",
    DATABASE_ADMISSION_USER: "dhumi_test_admission_login",
    DATABASE_ADMISSION_PASSWORD: "admission-password-at-least-20-characters",
    DATABASE_SSL_MODE: "disable",
    ACCESS_TOKEN_SECRET: "test-access-token-secret-at-least-32-chars",
    ACCESS_TOKEN_ISSUER: "https://dhumi.test",
    ACCESS_TOKEN_AUDIENCE: "dhumi-browser",
    RESPONSE_ENVELOPE_LOCAL_KEY: "A".repeat(43),
  });
}

let app: FastifyInstance | undefined;
let authentication: RecordingAuthentication;
let tenantAuthorization: RecordingTenantAuthorization;
let workspaceService: RecordingWorkspace;
let apiKeyAuthentication: RecordingApiKeyAuthentication;

beforeEach(() => {
  authentication = recordingAuthentication();
  tenantAuthorization = recordingTenantAuthorization();
  workspaceService = recordingWorkspace();
  apiKeyAuthentication = recordingApiKeyAuthentication();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(): Promise<FastifyInstance> {
  app = await buildApp(testConfig(), {
    signupService: stubSignupService,
    signInService: stubSignInService,
    refreshService: stubRefreshService,
    browserAuthenticationService: authentication,
    logoutService: stubLogoutService,
    tenantAuthorizationService: tenantAuthorization,
    workspaceService,
    createApiKeyService: stubCreateApiKeyService,
    listApiKeysService: stubListApiKeysService,
    revokeApiKeyService: stubRevokeApiKeyService,
    apiKeyAuthenticationService: apiKeyAuthentication,
    listCatalogTemplatesService: stubListCatalogTemplatesService,
    getCatalogTemplateService: stubGetCatalogTemplateService,
    listServicesService: stubListServicesService,
    createServiceService: stubCreateServiceService,
    getServiceService: stubGetServiceService,
  });
  return app;
}

describe("GET /v1/workspace contract", () => {
  it("returns exactly the declared workspace from trusted browser and Tenant context", async () => {
    const requestId = randomUUID();
    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/workspace",
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "x-request-id": requestId,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe(requestId);
    expect(response.json()).toEqual({
      id: workspace.id,
      name: workspace.name,
      state: workspace.state,
      created_at: "2026-08-23T10:20:30.000Z",
    });
    expect(Object.keys(response.json<Record<string, unknown>>()).sort()).toEqual([
      "created_at",
      "id",
      "name",
      "state",
    ]);
    expect(authentication.calls).toEqual([`Bearer ${ACCESS_TOKEN}`]);
    expect(tenantAuthorization.calls).toEqual([sessionIdentity]);
    expect(workspaceService.calls).toEqual([{ kind: "browser", ...tenantIdentity }]);
    expect(apiKeyAuthentication.calls).toHaveLength(0);
  });

  it("uses the reserved Dhumi credential namespace without browser fallback", async () => {
    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/workspace",
      headers: { authorization: `Bearer ${API_KEY}` },
    });

    expect(response.statusCode).toBe(200);
    expect(apiKeyAuthentication.calls).toEqual([`Bearer ${API_KEY}`]);
    expect(authentication.calls).toHaveLength(0);
    expect(tenantAuthorization.calls).toHaveLength(0);
    expect(workspaceService.calls).toEqual([apiKeyIdentity]);
  });

  it("does not fall back to browser authentication for a malformed reserved credential", async () => {
    const authorization = "Bearer dhk_v1_malformed";
    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/workspace",
      headers: { authorization },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
    });
    expect(apiKeyAuthentication.calls).toEqual([authorization]);
    expect(authentication.calls).toHaveLength(0);
    expect(workspaceService.calls).toHaveLength(0);
  });

  it("requires Bearer authentication and does not call later authorization layers", async () => {
    const response = await (await build()).inject({ method: "GET", url: "/v1/workspace" });

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe("Bearer");
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
    });
    expect(tenantAuthorization.calls).toHaveLength(0);
    expect(workspaceService.calls).toHaveLength(0);
  });

  it("returns the declared generic 403 when current Tenant authority is unavailable", async () => {
    tenantAuthorization.failWith = workspaceUnavailable();
    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/workspace",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({
      status: 403,
      code: "ACCESS_DENIED",
    });
    expect(workspaceService.calls).toHaveLength(0);
  });

  it("does not require refresh cookies or CSRF for this read-only operation", async () => {
    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/workspace",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
  });
});
