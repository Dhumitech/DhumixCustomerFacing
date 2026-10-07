import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import type { RuntimeConfig } from "../../src/config/environment.js";
import { ApplicationError } from "../../src/utils/applicationError.js";
import type {
  SignInRequest,
  SignInResult,
  SignInService,
} from "../../src/services/identity/signInService.js";
import type { SignupService } from "../../src/services/identity/signupService.js";
import type { RefreshService } from "../../src/services/identity/refreshService.js";
import type { BrowserAuthenticationService } from "../../src/services/identity/browserAuthenticationService.js";
import type { LogoutService } from "../../src/services/identity/logoutService.js";
import type { TenantAuthorizationService } from "../../src/services/tenantAccess/tenantAuthorizationService.js";
import type { WorkspaceService } from "../../src/services/workspace/workspaceService.js";
import {
  stubGetCatalogTemplateService,
  stubListCatalogTemplatesService,
} from "../support/catalogueStub.js";
import { stubCreateServiceService, stubGetServiceService, stubListServicesService } from "../support/serviceStub.js";

const stubSignupService: SignupService = {
  async submit() {
    throw new Error("stub signup service was not expected to be called");
  },
};

const stubRefreshService: RefreshService = {
  async refresh() {
    throw new Error("stub refresh service was not expected to be called");
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

interface RecordingSignIn extends SignInService {
  readonly calls: SignInRequest[];
  failWith?: Error;
}

const REFRESH_TOKEN = "refresh-token-value-for-contract-tests-000";

function recordingSignIn(): RecordingSignIn {
  const calls: SignInRequest[] = [];
  const service: RecordingSignIn = {
    calls,
    async authenticate(request: SignInRequest): Promise<SignInResult> {
      calls.push(request);
      if (service.failWith !== undefined) {
        throw service.failWith;
      }
      return {
        accessToken: "header.payload.signature",
        expiresInSeconds: 900,
        csrfToken: "csrf-token-value",
        refreshToken: REFRESH_TOKEN,
        refreshExpiresAt: new Date(Date.now() + 1_209_600_000),
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
    MARKETPLACE_SAMPLE_DOWNLOAD_MAX_RECORDS: "100",
    MARKETPLACE_SAMPLE_DOWNLOAD_MAX_BYTES: "1048576",
    MARKETPLACE_SAMPLE_DOWNLOAD_RATE_LIMIT_MAX: "10",
    MARKETPLACE_SAMPLE_DOWNLOAD_RATE_WINDOW_SECONDS: "3600",
    ...overrides,
  });
}

function validBody(): Record<string, unknown> {
  return { email: "customer@example.test", password: "a-sufficiently-long-password" };
}

let app: FastifyInstance | undefined;
let service: RecordingSignIn;

beforeEach(() => {
  service = recordingSignIn();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(overrides: NodeJS.ProcessEnv = {}): Promise<FastifyInstance> {
  app = await buildApp(testConfig(overrides), {
    signupService: stubSignupService,
    signInService: service,
    refreshService: stubRefreshService,
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
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return instance.inject({
    method: "POST",
    url: "/v1/auth/sign-in",
    headers,
    payload: body,
  });
}

describe("POST /v1/auth/sign-in contract", () => {
  it("returns exactly the four AuthSession fields", async () => {
    const instance = await build();
    const response = await post(instance, validBody());

    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json<Record<string, unknown>>()).sort()).toEqual([
      "access_token",
      "csrf_token",
      "expires_in",
      "token_type",
    ]);
    expect(response.json()).toMatchObject({ token_type: "Bearer", expires_in: 900 });
  });

  it("never returns the refresh token in the response body", async () => {
    const instance = await build();
    const response = await post(instance, validBody());

    expect(response.body).not.toContain(REFRESH_TOKEN);
  });

  it("sets the refresh token in an HttpOnly, SameSite cookie scoped to /v1/auth", async () => {
    const instance = await build();
    const cookie = (await post(instance, validBody())).headers["set-cookie"];
    const header = Array.isArray(cookie) ? cookie.join(";") : String(cookie);

    expect(header).toContain(`dhumi_refresh=${REFRESH_TOKEN}`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Path=/v1/auth");
  });

  it("does not mark the cookie Secure in local development", async () => {
    const instance = await build();
    expect(String((await post(instance, validBody())).headers["set-cookie"])).not.toContain(
      "Secure",
    );
  });

  it("marks the cookie Secure whenever NODE_ENV is production", () => {
    // Asserted at the configuration layer. Building a production app here would
    // also require verify-full TLS and a readable CA file, which would test the
    // TLS rules rather than the cookie flag.
    const caFile = join(tmpdir(), `dhumi-signin-ca-${randomUUID()}.pem`);
    writeFileSync(caFile, "-----BEGIN CERTIFICATE-----");

    try {
      const production = testConfig({
        NODE_ENV: "production",
        DATABASE_SSL_MODE: "verify-full",
        DATABASE_SSL_CA_FILE: caFile,
        // Production also refuses to start without an approved legal
        // catalogue, so one is supplied here to reach the cookie assertion.
        LEGAL_DOCUMENTS: '[{"document_type": "terms", "document_version": "v1", "content_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]',
      });
      expect(production.session.cookie.secure).toBe(true);
      expect(testConfig().session.cookie.secure).toBe(false);
    } finally {
      rmSync(caFile, { force: true });
    }
  });

  it("answers a schema-invalid sign-in body with the generic 401", async () => {
    // The declared 400 is reserved for parser/framing failures. This body is
    // valid JSON, so preserving the generic 401 prevents field-level account
    // enumeration without misrepresenting a parser failure.
    const instance = await build();
    const response = await post(instance, { ...validBody(), remember_me: true });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    expect(response.headers["www-authenticate"]).toBe("Bearer");
    expect(service.calls).toHaveLength(0);
  });

  it("makes a malformed body indistinguishable from a wrong password", async () => {
    const instance = await build();

    const malformed = await post(instance, { email: "customer@example.test" });

    service.failWith = new ApplicationError({
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
      title: "Authentication failed",
      detail: "The email address or password is incorrect.",
    });
    const wrongPassword = await post(instance, validBody());

    const strip = (body: string): string =>
      body.replace(/"request_id":"[^"]+"/, '"request_id":"X"');

    expect(malformed.statusCode).toBe(wrongPassword.statusCode);
    expect(strip(malformed.body)).toBe(strip(wrongPassword.body));
  });

  it("answers a schema-invalid signup body with 400", async () => {
    // Signup maps structural validation to its declared 400. Sign-in keeps the
    // narrower generic-401 rule above for syntactically valid request bodies.
    const instance = await build();
    const response = await instance.inject({
      method: "POST",
      url: "/v1/auth/signup",
      headers: { "idempotency-key": "signup-status-check-0001" },
      payload: { email: "someone@example.test" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "BAD_REQUEST" });
  });

  it("returns 401 with WWW-Authenticate and application/problem+json", async () => {
    service.failWith = new ApplicationError({
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
      title: "Authentication failed",
      detail: "The email address or password is incorrect.",
    });
    const instance = await build();
    const response = await post(instance, validBody());

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe("Bearer");
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("does not leak internals when the database fails", async () => {
    service.failWith = Object.assign(new Error('relation "app.users" does not exist'), {
      code: "42P01",
    });
    const instance = await build();
    const response = await post(instance, validBody());

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toMatch(/app\.users|42P01|relation/i);
  });

  it("passes a fingerprint rather than the address, and no raw user agent", async () => {
    const instance = await build();
    await post(instance, validBody(), { "user-agent": "Mozilla/5.0 (secret build 12345)" });

    const call = service.calls[0];
    expect(call?.ipFingerprint).toBeInstanceOf(Buffer);
    expect(call?.ipFingerprint).toHaveLength(32);
    expect(JSON.stringify(call)).not.toContain("secret build 12345");
    expect(call).not.toHaveProperty("deviceMetadata");
  });

  it("records a fresh server trace for UUID and non-UUID caller IDs while preserving their echo", async () => {
    const instance = await build();

    const first = await post(instance, validBody(), { "x-request-id": "customer-request-001" });
    expect(service.calls[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.headers["x-request-id"]).toBe("customer-request-001");

    const uuid = "11111111-1111-4111-8111-111111111111";
    const second = await post(instance, validBody(), { "x-request-id": uuid });
    expect(service.calls[1]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(service.calls[1]?.requestId).not.toBe(uuid);
    expect(service.calls[1]?.requestId).not.toBe(service.calls[0]?.requestId);
    expect(second.headers["x-request-id"]).toBe(uuid);
  });

  it("limits one identity even when the source address changes", async () => {
    const instance = await build({ SIGNIN_RATE_LIMIT_MAX: "2" });
    const fromIp = (ip: string) =>
      instance.inject({
        method: "POST",
        url: "/v1/auth/sign-in",
        remoteAddress: ip,
        payload: validBody(),
      });

    expect((await fromIp("10.0.0.1")).statusCode).toBe(200);
    expect((await fromIp("10.0.0.2")).statusCode).toBe(200);

    const limited = await fromIp("10.0.0.3");
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
  });
});
