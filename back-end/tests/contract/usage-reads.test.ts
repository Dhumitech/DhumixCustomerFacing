import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import {
  loadRuntimeConfig,
  type RuntimeConfig,
} from "../../src/config/environment.js";
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
import type {
  GetUsageSummaryRequest,
  GetUsageSummaryService,
} from "../../src/services/usage/getUsageSummaryService.js";
import type {
  ListUsageEventsRequest,
  ListUsageEventsService,
} from "../../src/services/usage/listUsageEventsService.js";
import { usageReadValidationFailed } from "../../src/services/usage/usageReadErrors.js";
import type { WorkspaceService } from "../../src/services/workspace/workspaceService.js";
import {
  stubGetCatalogTemplateService,
  stubListCatalogTemplatesService,
} from "../support/catalogueStub.js";
import {
  stubCancelRunService,
  stubCreateRunService,
  stubCreateServiceService,
  stubGetRunResultService,
  stubGetRunService,
  stubGetServiceService,
  stubListRunEventsService,
  stubListRunsService,
  stubListServicesService,
  stubRetryRunService,
} from "../support/serviceStub.js";

const ACCESS_TOKEN = "header.payload.signature";
const API_KEY = `dhk_v1_${"A".repeat(16)}.${"A".repeat(43)}`;
const FROM = "2026-08-01T00:00:00.000Z";
const TO = "2026-09-01T00:00:00.000Z";
const tenantId = randomUUID();
const sessionIdentity: TrustedSessionIdentity = {
  userId: randomUUID(),
  sessionId: randomUUID(),
};
const tenantIdentity: TrustedTenantIdentity = {
  userId: sessionIdentity.userId,
  sessionId: sessionIdentity.sessionId,
  tenantId,
};

const summary = {
  from: FROM,
  to: TO,
  items: [
    {
      meter: "amazon.result_records.observed",
      quantity: 93,
      unit: "records",
    },
  ],
  updated_at: "2026-08-31T10:00:00.000Z",
  state: "observed",
} as const;
const eventsPage = {
  data: [
    {
      id: "79000000-0000-4000-8000-000000000001",
      run_id: "79100000-0000-4000-8000-000000000001",
      product_family: "scraper_library",
      meter: "amazon.result_records.observed",
      quantity: 93,
      unit: "records",
      outcome: "succeeded",
      observed_at: "2026-08-30T08:57:06.000Z",
    },
  ],
  page: { next_cursor: null, has_more: false },
} as const;

class RecordingSummary implements GetUsageSummaryService {
  public readonly calls: GetUsageSummaryRequest[] = [];
  public async get(request: GetUsageSummaryRequest) {
    this.calls.push(request);
    if (request.schemaErrors.length > 0) {
      throw usageReadValidationFailed(request.schemaErrors);
    }
    return summary;
  }
}

class RecordingEvents implements ListUsageEventsService {
  public readonly calls: ListUsageEventsRequest[] = [];
  public async list(request: ListUsageEventsRequest) {
    this.calls.push(request);
    if (request.schemaErrors.length > 0) {
      throw usageReadValidationFailed(request.schemaErrors);
    }
    return eventsPage;
  }
}

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
  });
}

function browserAuthentication(): BrowserAuthenticationService {
  return {
    async authenticate(authorization) {
      if (authorization !== `Bearer ${ACCESS_TOKEN}`) {
        throw authenticationRequired();
      }
      return sessionIdentity;
    },
  };
}

const tenantAuthorizationService: TenantAuthorizationService = {
  async authorizeBrowserTenant() {
    return tenantIdentity;
  },
};

let app: FastifyInstance | undefined;
let summaries: RecordingSummary;
let events: RecordingEvents;

beforeEach(() => {
  summaries = new RecordingSummary();
  events = new RecordingEvents();
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
    tenantAuthorizationService,
    workspaceService: stubWorkspaceService,
    listCatalogTemplatesService: stubListCatalogTemplatesService,
    getCatalogTemplateService: stubGetCatalogTemplateService,
    listServicesService: stubListServicesService,
    createServiceService: stubCreateServiceService,
    getServiceService: stubGetServiceService,
    createRunService: stubCreateRunService,
    listRunsService: stubListRunsService,
    getRunService: stubGetRunService,
    listRunEventsService: stubListRunEventsService,
    cancelRunService: stubCancelRunService,
    retryRunService: stubRetryRunService,
    getRunResultService: stubGetRunResultService,
    getUsageSummaryService: summaries,
    listUsageEventsService: events,
  });
  return app;
}

describe("usage read API contracts", () => {
  it("returns the exact summary to an authenticated browser Tenant", async () => {
    const response = await (await build()).inject({
      method: "GET",
      url: `/v1/usage/summary?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`,
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(summary);
    expect(summaries.calls[0]).toMatchObject({
      principal: { kind: "browser", tenantId },
      from: FROM,
      to: TO,
    });
  });

  it("returns the exact event page to the browser-session user", async () => {
    const response = await (await build()).inject({
      method: "GET",
      url: `/v1/usage/events?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&limit=1`,
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(eventsPage);
    expect(events.calls[0]).toMatchObject({
      principal: { kind: "browser", tenantId, userId: sessionIdentity.userId },
      from: FROM,
      to: TO,
      limit: "1",
    });
  });

  it("requires browser authentication and rejects retired customer API keys", async () => {
    const instance = await build();
    const url = `/v1/usage/summary?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;
    const unauthenticated = await instance.inject({ method: "GET", url });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
    });

    const forbidden = await instance.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(forbidden.statusCode).toBe(401);
    expect(forbidden.json()).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    expect(summaries.calls).toHaveLength(0);
  });

  it("returns 422 for missing, extra and invalid query input", async () => {
    const instance = await build();
    const urls = [
      "/v1/usage/summary",
      `/v1/usage/summary?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&provider_id=forbidden`,
      `/v1/usage/summary?from=${encodeURIComponent("2026-02-31T00:00:00.000Z")}&to=${encodeURIComponent(TO)}`,
      `/v1/usage/events?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&limit=0`,
    ];
    for (const url of urls) {
      const response = await instance.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    }
  });
});
