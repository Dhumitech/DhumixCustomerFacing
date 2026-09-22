import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { LightMyRequestResponse } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import type { RuntimeConfig } from "../../src/config/environment.js";
import { ApplicationError } from "../../src/utils/applicationError.js";
import type {
  SignupRequest,
  SignupService,
} from "../../src/services/identity/signupService.js";
import type { SignInService } from "../../src/services/identity/signInService.js";
import type { RefreshService } from "../../src/services/identity/refreshService.js";
import type { BrowserAuthenticationService } from "../../src/services/identity/browserAuthenticationService.js";
import type { LogoutService } from "../../src/services/identity/logoutService.js";
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

const VALID_HASH = "a".repeat(64);
const IDEMPOTENCY_KEY = "signup-contract-key-0001";

interface RecordingService extends SignupService {
  readonly calls: SignupRequest[];
  failWith?: Error;
}

function recordingService(): RecordingService {
  const calls: SignupRequest[] = [];
  const service: RecordingService = {
    calls,
    async submit(request: SignupRequest) {
      calls.push(request);
      if (service.failWith !== undefined) {
        throw service.failWith;
      }
    },
  };
  return service;
}


/** Sign-in is exercised by its own suite; these cases never authenticate. */
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
    RESPONSE_ENVELOPE_LOCAL_KEY: "A".repeat(43),
    ...overrides,
  });
}

function validBody(): Record<string, unknown> {
  return {
    email: "customer@example.test",
    password: "a-sufficiently-long-password",
    workspace_name: "Acme Research",
    legal_acceptances: [
      {
        document_type: "terms",
        document_version: "v1",
        content_hash: VALID_HASH,
        accepted: true,
      },
    ],
  };
}

function post(
  app: FastifyInstance,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    headers: { "idempotency-key": IDEMPOTENCY_KEY, ...headers },
    payload: body,
  });
}

let app: FastifyInstance | undefined;
let service: RecordingService;

function appDependencies() {
  return {
    signupService: service,
    signInService: stubSignInService,
    refreshService: stubRefreshService,
    browserAuthenticationService: stubBrowserAuthenticationService,
    logoutService: stubLogoutService,
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
  };
}

beforeEach(() => {
  service = recordingService();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("POST /v1/auth/signup contract", () => {
  it("returns the fixed 202 accepted body", async () => {
    app = await buildApp(testConfig(), appDependencies());

    const response = await post(app, validBody());

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      accepted: true,
      message: "Account request accepted. Sign in to continue.",
    });
    expect(service.calls).toHaveLength(1);
  });

  it("never returns an identifier that could reveal account existence", async () => {
    app = await buildApp(testConfig(), appDependencies());

    const body = (await post(app, validBody())).json<Record<string, unknown>>();

    expect(Object.keys(body).sort()).toEqual(["accepted", "message"]);
    expect(JSON.stringify(body)).not.toMatch(/user_id|tenant_id|[0-9a-f]{8}-[0-9a-f]{4}/i);
  });

  it("rejects an unknown request property", async () => {
    app = await buildApp(testConfig(), appDependencies());

    const response = await post(app, { ...validBody(), referral_code: "abc" });

    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect(service.calls).toHaveLength(0);
  });

  it("requires an Idempotency-Key", async () => {
    app = await buildApp(testConfig(), appDependencies());

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: validBody(),
    });

    expect(response.statusCode).toBe(400);
    expect(service.calls).toHaveLength(0);
  });

  it("rejects a password shorter than the contract minimum", async () => {
    app = await buildApp(testConfig(), appDependencies());

    const response = await post(app, { ...validBody(), password: "short" });

    expect(response.statusCode).toBe(400);
    expect(service.calls).toHaveLength(0);
  });

  it("rejects a legal acceptance whose content hash is not 64 hex characters", async () => {
    app = await buildApp(testConfig(), appDependencies());

    const body = validBody();
    (body.legal_acceptances as Array<Record<string, unknown>>)[0]!.content_hash = "nope";

    expect((await post(app, body)).statusCode).toBe(400);
  });

  it("rejects accepted:false, which the contract fixes to true", async () => {
    app = await buildApp(testConfig(), appDependencies());

    const body = validBody();
    (body.legal_acceptances as Array<Record<string, unknown>>)[0]!.accepted = false;

    expect((await post(app, body)).statusCode).toBe(400);
  });

  it("rejects an empty legal_acceptances array", async () => {
    app = await buildApp(testConfig(), appDependencies());

    expect((await post(app, { ...validBody(), legal_acceptances: [] })).statusCode).toBe(400);
  });

  it("surfaces an idempotency conflict as 409 without leaking internals", async () => {
    service.failWith = new ApplicationError({
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
      title: "Idempotency conflict",
      detail: "This Idempotency-Key was already used with a different request.",
    });
    app = await buildApp(testConfig(), appDependencies());

    const response = await post(app, validBody());
    const body = response.json<Record<string, unknown>>();

    expect(response.statusCode).toBe(409);
    expect(body).toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    expect(JSON.stringify(body)).not.toMatch(/23505|app\.|pg|constraint|stack/i);
  });

  it("does not expose a database failure to the customer", async () => {
    service.failWith = Object.assign(new Error('relation "app.users" does not exist'), {
      code: "42P01",
    });
    app = await buildApp(testConfig(), appDependencies());

    const response = await post(app, validBody());
    const body = response.json<Record<string, unknown>>();

    expect(response.statusCode).toBe(500);
    expect(body).toMatchObject({ status: 500, code: "INTERNAL_ERROR" });
    expect(JSON.stringify(body)).not.toMatch(/app\.users|42P01|relation/i);
  });

  it("passes a UUID request ID through and drops a non-UUID one", async () => {
    app = await buildApp(testConfig(), appDependencies());

    await post(app, validBody(), { "x-request-id": "customer-request-001" });
    expect(service.calls[0]?.requestId).toBeNull();

    const uuid = "11111111-1111-4111-8111-111111111111";
    await post(app, validBody(), { "x-request-id": uuid });
    expect(service.calls[1]?.requestId).toBe(uuid);
  });

  it("limits one identity even when the source address changes", async () => {
    app = await buildApp(testConfig({ SIGNUP_RATE_LIMIT_MAX: "2" }), appDependencies());

    const fromIp = (ip: string) =>
      app!.inject({
        method: "POST",
        url: "/v1/auth/signup",
        headers: { "idempotency-key": IDEMPOTENCY_KEY },
        remoteAddress: ip,
        payload: validBody(),
      });

    expect((await fromIp("10.0.0.1")).statusCode).toBe(202);
    expect((await fromIp("10.0.0.2")).statusCode).toBe(202);

    // A third distinct address would pass the IP limit. The identity limit is
    // what stops one address being probed from a rotating source.
    const limited = await fromIp("10.0.0.3");
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ status: 429, code: "PLATFORM_CAPACITY_LIMIT" });
    expect(limited.headers["retry-after"]).toBeDefined();
  });

  it("enforces the configured signup rate limit", async () => {
    app = await buildApp(testConfig({ SIGNUP_RATE_LIMIT_MAX: "2" }), appDependencies());

    expect((await post(app, validBody())).statusCode).toBe(202);
    expect((await post(app, validBody())).statusCode).toBe(202);

    const limited = await post(app, validBody());
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ status: 429, code: "PLATFORM_CAPACITY_LIMIT" });
    expect(limited.headers["retry-after"]).toBeDefined();
  });
});
