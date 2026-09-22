import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadRuntimeConfig, type RuntimeConfig } from "../../src/config/environment.js";
import { encodeRunEventListCursor } from "../../src/helpers/runEventListCursor.js";
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
import type { ListRunEventsRecord } from "../../src/services/runQuery/listRunEventsRepository.js";
import {
  createListRunEventsService,
  type ListRunEventsRequest,
  type ListRunEventsService,
} from "../../src/services/runQuery/listRunEventsService.js";
import { workspaceUnavailable } from "../../src/services/tenantAccess/tenantAccessErrors.js";
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
  stubListRunsService,
  stubListServicesService,
} from "../support/serviceStub.js";

const ACCESS_TOKEN = "header.payload.signature";
const API_KEY = `dhk_v1_${"A".repeat(16)}.${"A".repeat(43)}`;
const RUN_ID = "74000000-0000-4000-8000-000000000001";
const OTHER_RUN_ID = "74000000-0000-4000-8000-000000000002";
const EVENT_ID = "75000000-0000-4000-8000-000000000001";
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
  scopes: ["runs:read"],
};
const record: ListRunEventsRecord = {
  id: EVENT_ID,
  sequence: "1",
  eventType: "accepted",
  occurredAt: new Date("2026-08-25T12:00:00.000Z"),
};
const page = {
  data: [
    {
      id: EVENT_ID,
      type: "accepted",
      message: "Run accepted.",
      occurred_at: "2026-08-25T12:00:00.000Z",
    },
  ],
  page: { next_cursor: null, has_more: false },
} as const;

const stubSignupService: SignupService = {
  async submit() {
    throw new Error("unexpected");
  },
};
const stubSignInService: SignInService = {
  async authenticate() {
    throw new Error("unexpected");
  },
};
const stubRefreshService: RefreshService = {
  async refresh() {
    throw new Error("unexpected");
  },
};
const stubLogoutService: LogoutService = {
  async logout() {
    throw new Error("unexpected");
  },
};
const stubWorkspaceService: WorkspaceService = {
  async getWorkspace() {
    throw new Error("unexpected");
  },
};

interface RecordingService extends ListRunEventsService {
  readonly calls: ListRunEventsRequest[];
  records: readonly ListRunEventsRecord[] | undefined;
  failWith?: Error;
}

function listService(): RecordingService {
  const calls: ListRunEventsRequest[] = [];
  const service: RecordingService = {
    calls,
    records: [record],
    async list(request) {
      calls.push(request);
      if (service.failWith !== undefined) throw service.failWith;
      return createListRunEventsService({
        repository: {
          async findPage() {
            return service.records;
          },
        },
      }).list(request);
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
  failWith?: Error;
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
let events: RecordingService;
let tenant: SwitchableTenantAuthorization;
let apiKeyAuth: SwitchableApiKeyAuthentication;

beforeEach(() => {
  events = listService();
  tenant = tenantAuthorization();
  apiKeyAuth = apiKeyAuthentication();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(
  implementation: ListRunEventsService = events,
): Promise<FastifyInstance> {
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
    listRunEventsService: implementation,
  });
  return app;
}

async function get(
  instance: FastifyInstance,
  suffix = "",
  authorization = `Bearer ${ACCESS_TOKEN}`,
) {
  return instance.inject({
    method: "GET",
    url: `/v1/runs/${RUN_ID}/events${suffix}`,
    headers: { authorization },
  });
}

describe("GET /v1/runs/{run_id}/events contract", () => {
  it("returns the exact customer-safe page from a trusted browser principal", async () => {
    const requestId = randomUUID();
    const response = await (await build()).inject({
      method: "GET",
      url: `/v1/runs/${RUN_ID}/events?limit=20`,
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "x-request-id": requestId,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe(requestId);
    expect(response.json()).toEqual(page);
    expect(events.calls).toEqual([
      {
        principal: { kind: "browser", ...tenantIdentity },
        runId: RUN_ID,
        cursor: undefined,
        limit: "20",
        schemaErrors: [],
      },
    ]);
  });

  it("accepts runs:read API keys and rejects a missing scope before lookup", async () => {
    const instance = await build();
    expect((await get(instance, "", `Bearer ${API_KEY}`)).statusCode).toBe(200);
    expect(events.calls[0]?.principal).toEqual(apiKeyIdentity);

    events.calls.length = 0;
    apiKeyAuth.identity = { ...apiKeyIdentity, scopes: ["runs:write"] };
    const denied = await get(instance, "", `Bearer ${API_KEY}`);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "ACCESS_DENIED" });
    expect(events.calls).toHaveLength(0);
  });

  it("authenticates before exposing malformed request behavior", async () => {
    const response = await get(await build(), "?limit=0", "Bearer invalid");

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe("Bearer");
    expect(response.json()).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    expect(events.calls).toHaveLength(0);
  });

  it("returns generic 403 when the browser Tenant is unavailable", async () => {
    tenant.failWith = workspaceUnavailable();
    const response = await get(await build());

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "ACCESS_DENIED" });
    expect(events.calls).toHaveLength(0);
  });

  it("maps malformed and invisible Run IDs to the same safe 404", async () => {
    const instance = await build();
    const malformed = await instance.inject({
      method: "GET",
      url: "/v1/runs/not-a-uuid/events",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    events.records = undefined;
    const invisible = await get(instance);

    for (const response of [malformed, invisible]) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        status: 404,
        code: "RESOURCE_NOT_FOUND",
        title: "Resource not found",
        detail: null,
      });
      expect(response.body).not.toMatch(/validation|exists|tenant|provider/i);
    }
  });

  it("maps invalid, repeated, unknown, and cross-Run pagination input to 422", async () => {
    const instance = await build();
    const otherCursor = encodeRunEventListCursor({
      runId: OTHER_RUN_ID,
      sequence: "1",
    });
    const invalidQueries = [
      "?extra=1",
      "?limit=0",
      "?limit=01",
      "?limit=101",
      "?limit=1.5",
      "?limit=1&limit=2",
      "?cursor=",
      "?cursor=not-a-cursor",
      `?cursor=${otherCursor}`,
    ];

    for (const query of invalidQueries) {
      const response = await get(instance, query);
      expect(response.statusCode).toBe(422);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.json()).toMatchObject({
        status: 422,
        code: "VALIDATION_ERROR",
      });
      expect(response.body).not.toMatch(/not-a-cursor|74000000-0000-4000-8000-000000000002/);
    }
  });

  it("serializes only the four approved event fields", async () => {
    const response = await get(
      await build({
        async list() {
          return {
            data: [
              {
                ...page.data[0],
                tenant_id: "forbidden-tenant",
                run_id: "forbidden-run",
                sequence: "1",
                source: "provider-private",
                safe_payload: { provider_secret: "forbidden" },
                evidence_reference: "vault://forbidden",
              },
            ],
            page: { ...page.page, internal_count: 1 },
            internal: true,
          };
        },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json<Record<string, unknown>>()).sort()).toEqual([
      "data",
      "page",
    ]);
    expect(
      Object.keys(response.json<{ data: Record<string, unknown>[] }>().data[0]!).sort(),
    ).toEqual(["id", "message", "occurred_at", "type"]);
    expect(response.body).not.toMatch(
      /forbidden|tenant_id|run_id|sequence|source|safe_payload|evidence|provider/i,
    );
  });

  it("returns a correlated generic 500 without database or provider details", async () => {
    events.failWith = Object.assign(
      new Error('permission denied for relation "app.run_events"'),
      { code: "42501", provider_error: "Bright Data account detail" },
    );
    const response = await get(await build());

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      code: "INTERNAL_ERROR",
      instance: `/v1/runs/${RUN_ID}/events`,
    });
    expect(response.body).not.toMatch(/run_events|42501|permission denied|Bright Data/i);
  });

  it("does not require cookies or CSRF for this read-only operation", async () => {
    expect((await get(await build(), "", `Bearer ${API_KEY}`)).statusCode).toBe(200);
  });
});
