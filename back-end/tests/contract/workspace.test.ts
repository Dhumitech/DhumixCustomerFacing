import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import type { RuntimeConfig } from "../../src/config/environment.js";
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
  stubGetCatalogTemplateService,
  stubListCatalogTemplatesService,
} from "../support/catalogueStub.js";
import {
  stubCreateServiceService,
  stubGetServiceService,
  stubListServicesService,
} from "../support/serviceStub.js";

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
const workspace: WorkspaceRecord = {
  id: tenantIdentity.tenantId,
  name: "Acme Research",
  state: "active",
  role: "member",
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
  readonly selectors: Array<string | string[] | undefined>;
  failWith?: Error;
}

function recordingTenantAuthorization(): RecordingTenantAuthorization {
  const calls: TrustedSessionIdentity[] = [];
  const selectors: Array<string | string[] | undefined> = [];
  const service: RecordingTenantAuthorization = {
    calls,
    selectors,
    async authorizeBrowserTenant(identity, selector) {
      calls.push(identity);
      selectors.push(selector);
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
  });
}

let app: FastifyInstance | undefined;
let authentication: RecordingAuthentication;
let tenantAuthorization: RecordingTenantAuthorization;
let workspaceService: RecordingWorkspace;

beforeEach(() => {
  authentication = recordingAuthentication();
  tenantAuthorization = recordingTenantAuthorization();
  workspaceService = recordingWorkspace();
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
    listCatalogTemplatesService: stubListCatalogTemplatesService,
    getCatalogTemplateService: stubGetCatalogTemplateService,
    listServicesService: stubListServicesService,
    createServiceService: stubCreateServiceService,
    getServiceService: stubGetServiceService,
  });
  return app;
}

describe("GET /v1/workspace contract", () => {
  it("passes the organization selector separately from trusted session identity", async () => {
    const selector = randomUUID();
    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/workspace",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}`, "x-dhumi-organization": selector },
    });
    expect(response.statusCode).toBe(200);
    expect(tenantAuthorization.calls).toEqual([sessionIdentity]);
    expect(tenantAuthorization.selectors).toEqual([selector]);
  });

  it("allows the organization selector in a browser CORS preflight", async () => {
    const response = await (await build()).inject({
      method: "OPTIONS",
      url: "/v1/workspace",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "GET",
        "access-control-request-headers": "Authorization,X-Dhumi-Organization",
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-headers"]).toContain("X-Dhumi-Organization");
    expect(tenantAuthorization.calls).toEqual([]);
  });
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
      role: workspace.role,
      created_at: "2026-08-23T10:20:30.000Z",
    });
    expect(Object.keys(response.json<Record<string, unknown>>()).sort()).toEqual([
      "created_at",
      "id",
      "name",
      "role",
      "state",
    ]);
    expect(authentication.calls).toEqual([`Bearer ${ACCESS_TOKEN}`]);
    expect(tenantAuthorization.calls).toEqual([sessionIdentity]);
    expect(workspaceService.calls).toEqual([{ kind: "browser", ...tenantIdentity }]);
  });

  it("rejects retired customer API keys before Tenant authorization", async () => {
    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/workspace",
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    expect(authentication.calls).toEqual([`Bearer ${API_KEY}`]);
    expect(tenantAuthorization.calls).toHaveLength(0);
    expect(workspaceService.calls).toHaveLength(0);
  });

  it("rejects a malformed retired credential through browser authentication", async () => {
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
    expect(authentication.calls).toEqual([authorization]);
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
