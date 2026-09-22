import { randomUUID } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadRuntimeConfig, type RuntimeConfig } from "../../src/config/environment.js";
import type { CsrfService } from "../../src/helpers/csrf.js";
import type {
  RevokeApiKeyRepository,
  RevokeApiKeyRepositoryInput,
  RevokeApiKeyOutcome,
} from "../../src/services/apiKeys/revokeApiKeyRepository.js";
import type {
  RevokeApiKeyRequest,
  RevokeApiKeyService,
} from "../../src/services/apiKeys/revokeApiKeyService.js";
import { createRevokeApiKeyService } from "../../src/services/apiKeys/revokeApiKeyService.js";
import type {
  BrowserAuthenticationService,
  TrustedSessionIdentity,
} from "../../src/services/identity/browserAuthenticationService.js";
import type { LogoutService } from "../../src/services/identity/logoutService.js";
import type { RefreshService } from "../../src/services/identity/refreshService.js";
import { authenticationRequired } from "../../src/services/identity/sessionErrors.js";
import type { SignInService } from "../../src/services/identity/signInService.js";
import type { SignupService } from "../../src/services/identity/signupService.js";
import type {
  TenantAuthorizationService,
  TrustedTenantIdentity,
} from "../../src/services/tenantAccess/tenantAuthorizationService.js";
import { workspaceUnavailable } from "../../src/services/tenantAccess/tenantAccessErrors.js";
import type { WorkspaceService } from "../../src/services/workspace/workspaceService.js";
import { ApplicationError } from "../../src/utils/applicationError.js";
import {
  stubApiKeyAuthenticationService,
  stubCreateApiKeyService,
  stubListApiKeysService,
} from "../support/apiKeyStub.js";
import {
  stubGetCatalogTemplateService,
  stubListCatalogTemplatesService,
} from "../support/catalogueStub.js";
import { stubCreateServiceService, stubGetServiceService, stubListServicesService } from "../support/serviceStub.js";

const ACCESS_TOKEN = "header.payload.signature";
const CSRF_TOKEN = "valid-csrf-token-value";
const KEY_ID = "44444444-4444-4444-8444-444444444444";
const sessionIdentity: TrustedSessionIdentity = {
  userId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  issuedTenantId: "33333333-3333-4333-8333-333333333333",
};
const tenantIdentity: TrustedTenantIdentity = {
  userId: sessionIdentity.userId,
  sessionId: sessionIdentity.sessionId,
  tenantId: sessionIdentity.issuedTenantId,
};

const stubSignupService: SignupService = { async submit() { throw new Error("unexpected"); } };
const stubSignInService: SignInService = { async authenticate() { throw new Error("unexpected"); } };
const stubRefreshService: RefreshService = { async refresh() { throw new Error("unexpected"); } };
const stubLogoutService: LogoutService = { async logout() { throw new Error("unexpected"); } };
const stubWorkspaceService: WorkspaceService = { async getWorkspace() { throw new Error("unexpected"); } };

interface RecordingRepository extends RevokeApiKeyRepository {
  readonly calls: RevokeApiKeyRepositoryInput[];
  outcome: RevokeApiKeyOutcome;
}

function repository(): RecordingRepository {
  const calls: RevokeApiKeyRepositoryInput[] = [];
  return {
    calls,
    outcome: "revoked",
    async revoke(input) {
      calls.push(input);
      return this.outcome;
    },
  };
}

interface RecordingRevokeService extends RevokeApiKeyService {
  readonly calls: RevokeApiKeyRequest[];
  readonly repository: RecordingRepository;
  failWith?: Error;
}

function csrf(): CsrfService {
  return {
    issue() {
      return CSRF_TOKEN;
    },
    verify(sessionId, presented) {
      return sessionId === sessionIdentity.sessionId && presented === CSRF_TOKEN;
    },
  };
}

function revokeService(): RecordingRevokeService {
  const calls: RevokeApiKeyRequest[] = [];
  const persistence = repository();
  const implementation = createRevokeApiKeyService({ repository: persistence, csrf: csrf() });
  const service: RecordingRevokeService = {
    calls,
    repository: persistence,
    async revoke(request) {
      calls.push(request);
      if (service.failWith !== undefined) throw service.failWith;
      return implementation.revoke(request);
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
  unavailable: boolean;
}

function tenantAuthorization(): SwitchableTenantAuthorization {
  return {
    unavailable: false,
    async authorizeBrowserTenant(identity) {
      if (this.unavailable || identity !== sessionIdentity) throw workspaceUnavailable();
      return tenantIdentity;
    },
  };
}

function config(): RuntimeConfig {
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
let service: RecordingRevokeService;
let tenant: SwitchableTenantAuthorization;

beforeEach(() => {
  service = revokeService();
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
    createApiKeyService: stubCreateApiKeyService,
    listApiKeysService: stubListApiKeysService,
    revokeApiKeyService: service,
    apiKeyAuthenticationService: stubApiKeyAuthenticationService,
    listCatalogTemplatesService: stubListCatalogTemplatesService,
    getCatalogTemplateService: stubGetCatalogTemplateService,
    listServicesService: stubListServicesService,
    createServiceService: stubCreateServiceService,
    getServiceService: stubGetServiceService,
  });
  return app;
}

function revoke(
  instance: FastifyInstance,
  keyId = KEY_ID,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return instance.inject({
    method: "DELETE",
    url: `/v1/keys/${keyId}`,
    headers: {
      authorization: `Bearer ${ACCESS_TOKEN}`,
      "x-csrf-token": CSRF_TOKEN,
      ...headers,
    },
  });
}

describe("DELETE /v1/keys/{key_id} contract", () => {
  it("returns exactly an empty 204 after passing trusted request data", async () => {
    const requestId = randomUUID();
    const response = await revoke(await build(), KEY_ID, { "x-request-id": requestId });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(response.headers["content-type"]).toBeUndefined();
    expect(service.calls).toHaveLength(1);
    expect(service.calls[0]).toMatchObject({
      identity: tenantIdentity,
      keyId: KEY_ID,
      csrfToken: CSRF_TOKEN,
      schemaErrors: [],
      requestId,
    });
    expect(service.calls[0]?.ipFingerprint).toBeInstanceOf(Buffer);
    expect(service.repository.calls).toHaveLength(1);
  });

  it("returns the declared 401 and Bearer challenge before service execution", async () => {
    const response = await (await build()).inject({
      method: "DELETE",
      url: `/v1/keys/${KEY_ID}`,
      headers: { "x-csrf-token": CSRF_TOKEN },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe("Bearer");
    expect(response.json()).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    expect(service.calls).toHaveLength(0);
  });

  it("returns the declared 403 when the current Tenant is unavailable", async () => {
    tenant.unavailable = true;
    const response = await revoke(await build());

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "ACCESS_DENIED" });
    expect(service.calls).toHaveLength(0);
  });

  it.each([
    ["missing", undefined],
    ["wrong", "wrong-csrf-token-value"],
    ["short", "too-short"],
  ])("returns the declared 403 for %s CSRF without persistence", async (_label, token) => {
    const instance = await build();
    const response = await instance.inject({
      method: "DELETE",
      url: `/v1/keys/${KEY_ID}`,
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        ...(token === undefined ? {} : { "x-csrf-token": token }),
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "ACCESS_DENIED" });
    expect(service.repository.calls).toHaveLength(0);
  });

  it("maps malformed UUID validation to the declared non-enumerating 404", async () => {
    const response = await revoke(await build(), "not-a-uuid");
    const problem = response.json<Record<string, unknown>>();

    expect(response.statusCode).toBe(404);
    expect(problem).toMatchObject({
      status: 404,
      code: "RESOURCE_NOT_FOUND",
      title: "Resource not found",
    });
    expect(problem).not.toHaveProperty("errors");
    expect(JSON.stringify({
      title: problem.title,
      detail: problem.detail,
      code: problem.code,
    })).not.toMatch(/uuid|format|validation/i);
    expect(service.repository.calls).toHaveLength(0);
  });

  it("uses the same generic 404 when no key is visible", async () => {
    service.repository.outcome = "not_found";
    const response = await revoke(await build());

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      status: 404,
      code: "RESOURCE_NOT_FOUND",
      title: "Resource not found",
    });
    expect(response.body).not.toMatch(/tenant|platform_api_keys|permission/i);
  });

  it("returns an empty 204 for an already inactive visible key", async () => {
    service.repository.outcome = "already_inactive";
    const response = await revoke(await build());

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
  });

  it("returns a generic 500 without database details", async () => {
    service.failWith = new ApplicationError({
      status: 500,
      code: "INTERNAL_ERROR",
      title: "Internal server error",
      cause: new Error("permission denied for app.platform_api_keys"),
    });
    const response = await revoke(await build());

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(response.body).not.toMatch(/platform_api_keys|permission denied|42501/i);
  });
});
