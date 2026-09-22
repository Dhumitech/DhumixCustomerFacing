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
  BrowserAuthenticationService,
  TrustedSessionIdentity,
} from "../../src/services/identity/browserAuthenticationService.js";
import { authenticationRequired } from "../../src/services/identity/sessionErrors.js";
import type { LogoutService } from "../../src/services/identity/logoutService.js";
import type { RefreshService } from "../../src/services/identity/refreshService.js";
import type { SignInService } from "../../src/services/identity/signInService.js";
import type { SignupService } from "../../src/services/identity/signupService.js";
import type { GetRunResultRepositoryOutcome } from "../../src/services/runQuery/getRunResultRepository.js";
import {
  createGetRunResultService,
  type GetRunResultRequest,
  type GetRunResultService,
} from "../../src/services/runQuery/getRunResultService.js";
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
import {
  stubCreateRunService,
  stubCreateServiceService,
  stubGetRunService,
  stubGetServiceService,
  stubListRunEventsService,
  stubListRunsService,
  stubListServicesService,
} from "../support/serviceStub.js";

const ACCESS_TOKEN = "header.payload.signature";
const API_KEY = `dhk_v1_${"A".repeat(16)}.${"A".repeat(43)}`;
const runId = randomUUID();
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
  scopes: ["results:read"],
};

const stubSignupService: SignupService = { async submit() { throw new Error("unexpected"); } };
const stubSignInService: SignInService = { async authenticate() { throw new Error("unexpected"); } };
const stubRefreshService: RefreshService = { async refresh() { throw new Error("unexpected"); } };
const stubLogoutService: LogoutService = { async logout() { throw new Error("unexpected"); } };
const stubWorkspaceService: WorkspaceService = { async getWorkspace() { throw new Error("unexpected"); } };

interface RecordingResultService extends GetRunResultService {
  readonly calls: GetRunResultRequest[];
  outcome: GetRunResultRepositoryOutcome;
  signerUnavailable: boolean;
}

function resultService(): RecordingResultService {
  const service: RecordingResultService = {
    calls: [],
    outcome: {
      kind: "ready",
      artifact: {
        artifactId: randomUUID(),
        objectKey: "private/object/key",
        contentType: "application/json",
        byteCount: "42",
        checksum: Buffer.from("cd".repeat(32), "hex"),
      },
    },
    signerUnavailable: false,
    async get(request) {
      service.calls.push(request);
      return createGetRunResultService({
        repository: {
          async findResult() { return service.outcome; },
          async recordDownloadAuthorization() {},
        },
        urlSigner: {
          async sign() {
            if (service.signerUnavailable) {
              throw Object.assign(new Error("unavailable"), {
                name: "ResultUrlSigningUnavailableError",
              });
            }
            return {
              downloadUrl: "https://downloads.dhumi.example/capability/opaque",
              expiresAt: new Date("2026-08-27T12:15:00.000Z"),
              transport: "https" as const,
            };
          },
        },
      }).get(request);
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

function tenantAuthorization(): TenantAuthorizationService {
  return {
    async authorizeBrowserTenant() {
      return tenantIdentity;
    },
  };
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
let results: RecordingResultService;
let apiKeyAuth: SwitchableApiKeyAuthentication;

beforeEach(() => {
  results = resultService();
  apiKeyAuth = apiKeyAuthentication();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(service: GetRunResultService = results): Promise<FastifyInstance> {
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
    createServiceService: stubCreateServiceService,
    getServiceService: stubGetServiceService,
    createRunService: stubCreateRunService,
    listRunsService: stubListRunsService,
    getRunService: stubGetRunService,
    listRunEventsService: stubListRunEventsService,
    getRunResultService: service,
  });
  return app;
}

describe("GET /v1/runs/{run_id}/result contract", () => {
  it("returns the exact public result for an authorized browser", async () => {
    const response = await (await build()).inject({
      method: "GET",
      url: `/v1/runs/${runId}/result`,
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      run_id: runId,
      content_type: "application/json",
      byte_count: 42,
      checksum: "cd".repeat(32),
      download_url: "https://downloads.dhumi.example/capability/opaque",
      download_expires_at: "2026-08-27T12:15:00.000Z",
    });
    expect(results.calls[0]).toMatchObject({
      principal: { kind: "browser", ...tenantIdentity },
      runId,
      representation: "normalized",
      schemaErrors: [],
      requestId: expect.any(String),
      ipFingerprint: expect.any(Buffer),
    });
    expect(response.body).not.toMatch(/private\/object|attempt|provider/i);
  });

  it("passes an explicit raw representation and rejects unsupported values", async () => {
    const instance = await build();
    const raw = await instance.inject({
      method: "GET",
      url: `/v1/runs/${runId}/result?representation=raw`,
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    expect(raw.statusCode).toBe(200);
    expect(results.calls.at(-1)).toMatchObject({ representation: "raw" });

    const invalid = await instance.inject({
      method: "GET",
      url: `/v1/runs/${runId}/result?representation=provider`,
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("requires results:read for a Dhumi API key", async () => {
    const instance = await build();
    const accepted = await instance.inject({
      method: "GET",
      url: `/v1/runs/${runId}/result`,
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(accepted.statusCode).toBe(200);

    apiKeyAuth.identity = { ...apiKeyIdentity, scopes: ["runs:read"] };
    const denied = await instance.inject({
      method: "GET",
      url: `/v1/runs/${runId}/result`,
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "ACCESS_DENIED" });
  });

  it("authenticates before exposing malformed path behavior", async () => {
    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/runs/not-a-uuid/result",
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
  });

  it("returns safe 404, 409, and 503 outcomes", async () => {
    const instance = await build();
    const malformed = await instance.inject({
      method: "GET",
      url: "/v1/runs/not-a-uuid/result",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    expect(malformed.statusCode).toBe(404);
    expect(malformed.json()).toMatchObject({ code: "RESOURCE_NOT_FOUND" });

    results.outcome = { kind: "not_ready" };
    const notReady = await instance.inject({
      method: "GET",
      url: `/v1/runs/${runId}/result`,
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    expect(notReady.statusCode).toBe(409);
    expect(notReady.json()).toMatchObject({ code: "STATE_CONFLICT" });

    results.outcome = resultService().outcome;
    results.signerUnavailable = true;
    const unavailable = await instance.inject({
      method: "GET",
      url: `/v1/runs/${runId}/result`,
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(unavailable.body).not.toMatch(/object|storage|signer/i);
  });

  it("strips any unapproved service fields at the HTTP boundary", async () => {
    const response = await (await build({
      async get() {
        return {
          run_id: runId,
          content_type: "application/json",
          byte_count: 42,
          checksum: "ef".repeat(32),
          download_url: "https://downloads.dhumi.example/capability/opaque",
          download_expires_at: "2026-08-27T12:15:00.000Z",
          object_key: "forbidden",
          attempt_id: "forbidden",
          provider_id: "forbidden",
        };
      },
    } as GetRunResultService)).inject({
      method: "GET",
      url: `/v1/runs/${runId}/result`,
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json<Record<string, unknown>>()).sort()).toEqual([
      "byte_count",
      "checksum",
      "content_type",
      "download_expires_at",
      "download_url",
      "run_id",
    ]);
    expect(response.body).not.toContain("forbidden");
  });
});
