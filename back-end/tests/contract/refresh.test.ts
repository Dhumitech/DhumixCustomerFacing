import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import type { RuntimeConfig } from "../../src/config/environment.js";
import type { SignInService } from "../../src/services/identity/signInService.js";
import type { SignupService } from "../../src/services/identity/signupService.js";
import type {
  RefreshRequest,
  RefreshResult,
  RefreshService,
} from "../../src/services/identity/refreshService.js";
import { ApplicationError } from "../../src/utils/applicationError.js";
import type { BrowserAuthenticationService } from "../../src/services/identity/browserAuthenticationService.js";
import type { LogoutService } from "../../src/services/identity/logoutService.js";
import type { TenantAuthorizationService } from "../../src/services/tenantAccess/tenantAuthorizationService.js";
import type { WorkspaceService } from "../../src/services/workspace/workspaceService.js";
import {
  stubGetCatalogTemplateService,
  stubListCatalogTemplatesService,
} from "../support/catalogueStub.js";
import { stubCreateServiceService, stubGetServiceService, stubListServicesService } from "../support/serviceStub.js";

const CURRENT_REFRESH_TOKEN = "a".repeat(43);
const ROTATED_REFRESH_TOKEN = "b".repeat(43);
const CSRF_TOKEN = "c".repeat(43);

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

const stubBrowserAuthenticationService: BrowserAuthenticationService = {
  async authenticate() {
    throw new Error("stub browser authentication was not expected to be called");
  },
};

const stubLogoutService: LogoutService = {
  async logout() {
    throw new Error("stub logout service was not expected to be called");
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

interface RecordingRefresh extends RefreshService {
  readonly calls: RefreshRequest[];
  failWith?: Error;
}

function recordingRefresh(): RecordingRefresh {
  const calls: RefreshRequest[] = [];
  const service: RecordingRefresh = {
    calls,
    async refresh(request): Promise<RefreshResult> {
      calls.push(request);
      if (service.failWith !== undefined) {
        throw service.failWith;
      }
      return {
        accessToken: "header.payload.signature",
        expiresInSeconds: 900,
        csrfToken: CSRF_TOKEN,
        refreshToken: ROTATED_REFRESH_TOKEN,
        refreshExpiresAt: new Date(Date.now() + 60_000),
      };
    },
  };
  return service;
}

function testConfig(overrides: NodeJS.ProcessEnv = {}): RuntimeConfig {
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
    ...overrides,
  });
}

let app: FastifyInstance | undefined;
let service: RecordingRefresh;

beforeEach(() => {
  service = recordingRefresh();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(overrides: NodeJS.ProcessEnv = {}): Promise<FastifyInstance> {
  app = await buildApp(testConfig(overrides), {
    signupService: stubSignupService,
    signInService: stubSignInService,
    refreshService: service,
    browserAuthenticationService: stubBrowserAuthenticationService,
    logoutService: stubLogoutService,
    tenantAuthorizationService: stubTenantAuthorizationService,
    workspaceService: stubWorkspaceService,
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
    url: "/v1/auth/refresh",
    headers: {
      cookie: `dhumi_refresh=${CURRENT_REFRESH_TOKEN}`,
      "x-csrf-token": CSRF_TOKEN,
      ...headers,
    },
  });
}

describe("POST /v1/auth/refresh contract", () => {
  it("returns exactly AuthSession and rotates the HttpOnly cookie", async () => {
    const response = await post(await build());

    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json<Record<string, unknown>>()).sort()).toEqual([
      "access_token",
      "csrf_token",
      "expires_in",
      "token_type",
    ]);
    expect(response.body).not.toContain(ROTATED_REFRESH_TOKEN);
    const setCookie = String(response.headers["set-cookie"]);
    expect(setCookie).toContain(`dhumi_refresh=${ROTATED_REFRESH_TOKEN}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/v1/auth");
  });

  it("passes the cookie, CSRF header and safe request metadata to the service", async () => {
    const requestId = "11111111-1111-4111-8111-111111111111";
    const response = await post(await build(), { "x-request-id": requestId });

    expect(response.statusCode).toBe(200);
    expect(service.calls[0]).toMatchObject({
      refreshToken: CURRENT_REFRESH_TOKEN,
      csrfToken: CSRF_TOKEN,
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(service.calls[0]?.requestId).not.toBe(requestId);
    expect(response.headers["x-request-id"]).toBe(requestId);
    expect(service.calls[0]?.ipFingerprint).toBeInstanceOf(Buffer);
    expect(service.calls[0]?.ipFingerprint).toHaveLength(32);
  });

  it("returns the declared generic 401 without setting a new cookie", async () => {
    service.failWith = new ApplicationError({
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
      title: "Session refresh failed",
    });
    const response = await post(await build());

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe("Bearer");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.json()).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
  });

  it("returns the declared 403 for CSRF rejection", async () => {
    service.failWith = new ApplicationError({
      status: 403,
      code: "ACCESS_DENIED",
      title: "CSRF validation failed",
    });
    const response = await post(await build());

    expect(response.statusCode).toBe(403);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.json()).toMatchObject({ code: "ACCESS_DENIED" });
  });

  it("limits one refresh family even when the source address changes", async () => {
    const instance = await build({ REFRESH_RATE_LIMIT_MAX: "2" });
    const fromIp = (ip: string) =>
      instance.inject({
        method: "POST",
        url: "/v1/auth/refresh",
        remoteAddress: ip,
        headers: {
          cookie: `dhumi_refresh=${CURRENT_REFRESH_TOKEN}`,
          "x-csrf-token": CSRF_TOKEN,
        },
      });

    expect((await fromIp("10.0.0.1")).statusCode).toBe(200);
    expect((await fromIp("10.0.0.2")).statusCode).toBe(200);
    const limited = await fromIp("10.0.0.3");
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    expect(limited.json()).toMatchObject({ code: "PLATFORM_CAPACITY_LIMIT" });
  });
});
