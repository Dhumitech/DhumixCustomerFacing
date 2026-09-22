import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadRuntimeConfig, type RuntimeConfig } from "../../src/config/environment.js";
import type { ApiKeyCreated } from "../../src/helpers/apiKeyCanonicalization.js";
import {
  apiKeyIdempotencyConflict,
  apiKeyValidationFailed,
  responseEnvelopeUnavailable,
} from "../../src/services/apiKeys/apiKeyErrors.js";
import type {
  CreateApiKeyRequest,
  CreateApiKeyService,
} from "../../src/services/apiKeys/createApiKeyService.js";
import type {
  BrowserAuthenticationService,
  TrustedSessionIdentity,
} from "../../src/services/identity/browserAuthenticationService.js";
import type { LogoutService } from "../../src/services/identity/logoutService.js";
import type { RefreshService } from "../../src/services/identity/refreshService.js";
import { authenticationRequired, csrfValidationFailed } from "../../src/services/identity/sessionErrors.js";
import type { SignInService } from "../../src/services/identity/signInService.js";
import type { SignupService } from "../../src/services/identity/signupService.js";
import { workspaceUnavailable } from "../../src/services/tenantAccess/tenantAccessErrors.js";
import type {
  TenantAuthorizationService,
  TrustedTenantIdentity,
} from "../../src/services/tenantAccess/tenantAuthorizationService.js";
import type { WorkspaceService } from "../../src/services/workspace/workspaceService.js";
import {
  stubApiKeyAuthenticationService,
  stubListApiKeysService,
  stubRevokeApiKeyService,
} from "../support/apiKeyStub.js";
import {
  stubGetCatalogTemplateService,
  stubListCatalogTemplatesService,
} from "../support/catalogueStub.js";
import { stubCreateServiceService, stubGetServiceService, stubListServicesService } from "../support/serviceStub.js";

const ACCESS_TOKEN = "header.payload.signature";
const CSRF_TOKEN = "valid-csrf-token-for-create-key";
const IDEMPOTENCY_KEY = "create-key-contract-0001";
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
const created: ApiKeyCreated = {
  id: randomUUID(),
  name: "CI key",
  prefix: "dhk_v1_AAAAAAAAAAAAAAAA",
  scopes: ["runs:read", "runs:write"],
  state: "active",
  created_at: "2026-08-24T00:00:00.000Z",
  last_used_at: null,
  expires_at: null,
  revoked_at: null,
  secret: `dhk_v1_AAAAAAAAAAAAAAAA.${"B".repeat(43)}`,
};

const stubSignupService: SignupService = { async submit() { throw new Error("unexpected"); } };
const stubSignInService: SignInService = { async authenticate() { throw new Error("unexpected"); } };
const stubRefreshService: RefreshService = { async refresh() { throw new Error("unexpected"); } };
const stubLogoutService: LogoutService = { async logout() { throw new Error("unexpected"); } };
const stubWorkspaceService: WorkspaceService = { async getWorkspace() { throw new Error("unexpected"); } };

interface RecordingCreateApiKey extends CreateApiKeyService {
  readonly calls: CreateApiKeyRequest[];
  failWith?: Error;
}

function createService(): RecordingCreateApiKey {
  const calls: CreateApiKeyRequest[] = [];
  const service: RecordingCreateApiKey = {
    calls,
    async create(request) {
      calls.push(request);
      if (service.failWith !== undefined) throw service.failWith;
      if (request.csrfToken !== CSRF_TOKEN) throw csrfValidationFailed();
      if (request.schemaErrors.length > 0) throw apiKeyValidationFailed(request.schemaErrors);
      return created;
    },
  };
  return service;
}

interface SwitchableTenantAuthorization extends TenantAuthorizationService {
  failWith?: Error;
}

function authentication(): BrowserAuthenticationService {
  return {
    async authenticate(authorization) {
      if (authorization !== `Bearer ${ACCESS_TOKEN}`) throw authenticationRequired();
      return sessionIdentity;
    },
  };
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
let service: RecordingCreateApiKey;
let tenant: SwitchableTenantAuthorization;

beforeEach(() => {
  service = createService();
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
    browserAuthenticationService: authentication(),
    logoutService: stubLogoutService,
    tenantAuthorizationService: tenant,
    workspaceService: stubWorkspaceService,
    createApiKeyService: service,
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
  payload: Record<string, unknown> = { name: "CI key", scopes: ["runs:write", "runs:read"] },
  headers: Record<string, string> = {},
) {
  return instance.inject({
    method: "POST",
    url: "/v1/keys",
    headers: {
      authorization: `Bearer ${ACCESS_TOKEN}`,
      "x-csrf-token": CSRF_TOKEN,
      "idempotency-key": IDEMPOTENCY_KEY,
      ...headers,
    },
    payload,
  });
}

describe("POST /v1/keys contract", () => {
  it("returns exactly ApiKeyCreated and uses trusted browser/Tenant context", async () => {
    const response = await post(await build());
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(created);
    expect(Object.keys(response.json<Record<string, unknown>>()).sort()).toEqual([
      "created_at",
      "expires_at",
      "id",
      "last_used_at",
      "name",
      "prefix",
      "revoked_at",
      "scopes",
      "secret",
      "state",
    ]);
    expect(service.calls[0]).toMatchObject({
      identity: tenantIdentity,
      csrfToken: CSRF_TOKEN,
      idempotencyKey: IDEMPOTENCY_KEY,
      schemaErrors: [],
    });
  });

  it("enforces authentication before Tenant authorization and creation", async () => {
    const instance = await build();
    const response = await instance.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { "x-csrf-token": CSRF_TOKEN, "idempotency-key": IDEMPOTENCY_KEY },
      payload: { name: "CI key", scopes: ["runs:read"] },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    expect(service.calls).toHaveLength(0);
  });

  it("returns generic 403 for unavailable Tenant or invalid CSRF", async () => {
    tenant.failWith = workspaceUnavailable();
    const tenantResponse = await post(await build());
    expect(tenantResponse.statusCode).toBe(403);
    expect(tenantResponse.json()).toMatchObject({ code: "ACCESS_DENIED" });
    expect(service.calls).toHaveLength(0);

    await app?.close();
    app = undefined;
    tenant = tenantAuthorization();
    const csrfResponse = await post(await build(), undefined, { "x-csrf-token": "wrong" });
    expect(csrfResponse.statusCode).toBe(403);
    expect(csrfResponse.json()).toMatchObject({ code: "ACCESS_DENIED" });
  });

  it("maps malformed body/header schema to the declared 422", async () => {
    const response = await post(
      await build(),
      { name: "", scopes: ["admin:*"], extra: true },
      { "idempotency-key": "short" },
    );
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "VALIDATION_ERROR", status: 422 });
    expect(service.calls[0]?.schemaErrors.length).toBeGreaterThan(0);
  });

  it("preserves declared 409 and 503 service errors without leaking internals", async () => {
    service.failWith = apiKeyIdempotencyConflict();
    const conflict = await post(await build());
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    await app?.close();
    app = undefined;
    service = createService();
    service.failWith = responseEnvelopeUnavailable(new Error("kms host secret details"));
    const unavailable = await post(await build());
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(unavailable.body).not.toContain("kms host secret details");
  });
});
