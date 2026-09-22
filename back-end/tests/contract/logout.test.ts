import { randomUUID } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import type { RuntimeConfig } from "../../src/config/environment.js";
import type {
  BrowserAuthenticationService,
  TrustedSessionIdentity,
} from "../../src/services/identity/browserAuthenticationService.js";
import type { LogoutRequest, LogoutService } from "../../src/services/identity/logoutService.js";
import type { RefreshService } from "../../src/services/identity/refreshService.js";
import { authenticationRequired, csrfValidationFailed } from "../../src/services/identity/sessionErrors.js";
import type { SignInService } from "../../src/services/identity/signInService.js";
import type { SignupService } from "../../src/services/identity/signupService.js";
import type { TenantAuthorizationService } from "../../src/services/tenantAccess/tenantAuthorizationService.js";
import type { WorkspaceService } from "../../src/services/workspace/workspaceService.js";
import {
  stubApiKeyAuthenticationService,
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
const CSRF_TOKEN = "csrf-token-value-for-logout";
const identity: TrustedSessionIdentity = {
  userId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  issuedTenantId: "33333333-3333-4333-8333-333333333333",
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

const stubTenantAuthorizationService: TenantAuthorizationService = {
  async authorizeBrowserTenant() {
    throw new Error("stub tenant authorization was not expected to be called");
  },
};

const stubWorkspaceService: WorkspaceService = {
  async getWorkspace() {
    throw new Error("stub workspace service was not expected to be called");
  },
};

interface RecordingAuthentication extends BrowserAuthenticationService {
  readonly calls: Array<string | undefined>;
  failWith?: Error;
}

function recordingAuthentication(): RecordingAuthentication {
  const calls: Array<string | undefined> = [];
  const service: RecordingAuthentication = {
    calls,
    async authenticate(authorization) {
      calls.push(authorization);
      if (service.failWith !== undefined) {
        throw service.failWith;
      }
      if (authorization !== `Bearer ${ACCESS_TOKEN}`) {
        throw authenticationRequired();
      }
      return identity;
    },
  };
  return service;
}

interface RecordingLogout extends LogoutService {
  readonly calls: LogoutRequest[];
  failWith?: Error;
}

function recordingLogout(): RecordingLogout {
  const calls: LogoutRequest[] = [];
  const service: RecordingLogout = {
    calls,
    async logout(request) {
      calls.push(request);
      if (service.failWith !== undefined) {
        throw service.failWith;
      }
    },
  };
  return service;
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
let logoutService: RecordingLogout;

beforeEach(() => {
  authentication = recordingAuthentication();
  logoutService = recordingLogout();
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
    logoutService,
    tenantAuthorizationService: stubTenantAuthorizationService,
    workspaceService: stubWorkspaceService,
    createApiKeyService: stubCreateApiKeyService,
    listApiKeysService: stubListApiKeysService,
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

function post(
  instance: FastifyInstance,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return instance.inject({
    method: "POST",
    url: "/v1/auth/logout",
    headers: {
      authorization: `Bearer ${ACCESS_TOKEN}`,
      "x-csrf-token": CSRF_TOKEN,
      cookie: "dhumi_refresh=opaque-refresh-cookie",
      ...headers,
    },
  });
}

describe("POST /v1/auth/logout contract", () => {
  it("returns an empty 204 and clears the refresh cookie with matching scope", async () => {
    const response = await post(await build());

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    const setCookie = String(response.headers["set-cookie"]);
    expect(setCookie).toContain("dhumi_refresh=");
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/v1/auth");
    expect(setCookie).toContain("Expires=Thu, 01 Jan 1970");
    expect(setCookie).not.toContain("opaque-refresh-cookie");
  });

  it("passes trusted identity, CSRF, and safe request metadata to the service", async () => {
    const requestId = randomUUID();
    const response = await post(await build(), { "x-request-id": requestId });

    expect(response.statusCode).toBe(204);
    expect(authentication.calls).toEqual([`Bearer ${ACCESS_TOKEN}`]);
    expect(logoutService.calls).toHaveLength(1);
    expect(logoutService.calls[0]).toMatchObject({
      identity,
      csrfToken: CSRF_TOKEN,
      requestId,
    });
    expect(logoutService.calls[0]?.ipFingerprint).toBeInstanceOf(Buffer);
  });

  it("returns the generic 401 and Bearer challenge when authentication is missing", async () => {
    const instance = await build();
    const response = await instance.inject({ method: "POST", url: "/v1/auth/logout" });

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe("Bearer");
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
    });
    expect(logoutService.calls).toHaveLength(0);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("returns the declared 403 without clearing the cookie when CSRF fails", async () => {
    logoutService.failWith = csrfValidationFailed();
    const response = await post(await build(), { "x-csrf-token": "wrong-csrf-token" });

    expect(response.statusCode).toBe(403);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({
      status: 403,
      code: "ACCESS_DENIED",
    });
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("passes a missing CSRF header to the service instead of emitting undeclared 400", async () => {
    logoutService.failWith = csrfValidationFailed();
    const instance = await build();
    const response = await instance.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    expect(response.statusCode).toBe(403);
    expect(logoutService.calls[0]?.csrfToken).toBeUndefined();
  });
});
