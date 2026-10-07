import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import {
  loadRuntimeConfig,
  type RuntimeConfig,
} from "../../src/config/environment.js";
import type { GetPlatformStatusService } from "../../src/services/status/getPlatformStatusService.js";
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
import {
  stubGetUsageSummaryService,
  stubListUsageEventsService,
} from "../support/usageStub.js";

const projection = {
  state: "operational",
  products: [
    {
      family: "scraper_library",
      state: "degraded",
      updated_at: "2026-08-31T12:30:00.000Z",
    },
    {
      family: "marketplace_dataset",
      state: "not_enabled",
      updated_at: "2026-08-31T12:30:00.000Z",
    },
  ],
  updated_at: "2026-08-31T12:30:00.000Z",
} as const;

class RecordingStatusService implements GetPlatformStatusService {
  public calls = 0;
  public failure: Error | undefined;

  public async get() {
    this.calls += 1;
    if (this.failure !== undefined) throw this.failure;
    return projection;
  }
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
  });
}

let app: FastifyInstance | undefined;
let status: RecordingStatusService;

beforeEach(() => {
  status = new RecordingStatusService();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(): Promise<FastifyInstance> {
  app = await buildApp(config(), {
    signupService: { async submit() { throw new Error("unexpected"); } },
    signInService: { async authenticate() { throw new Error("unexpected"); } },
    refreshService: { async refresh() { throw new Error("unexpected"); } },
    browserAuthenticationService: { async authenticate() { throw new Error("unexpected"); } },
    logoutService: { async logout() { throw new Error("unexpected"); } },
    tenantAuthorizationService: { async authorizeBrowserTenant() { throw new Error("unexpected"); } },
    workspaceService: { async getWorkspace() { throw new Error("unexpected"); } },
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
    getUsageSummaryService: stubGetUsageSummaryService,
    listUsageEventsService: stubListUsageEventsService,
    getPlatformStatusService: status,
  });
  return app;
}

describe("GET /v1/status", () => {
  it("returns the exact global projection without authentication", async () => {
    const requestId = randomUUID();
    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/status",
      headers: { "x-request-id": requestId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe(requestId);
    expect(response.json()).toEqual(projection);
    expect(status.calls).toBe(1);
  });

  it("does not parse or forward a bearer credential on this anonymous route", async () => {
    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/status",
      headers: { authorization: "Bearer provider-token-must-not-be-used" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(projection);
    expect(status.calls).toBe(1);
  });

  it("rejects undeclared query input before calling the service", async () => {
    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/status?tenant_id=forbidden",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "BAD_REQUEST" });
    expect(status.calls).toBe(0);
  });

  it("returns a generic correlated 500 when the stored projection fails", async () => {
    const instance = await build();
    status.failure = new Error("private database detail");
    const response = await instance.inject({ method: "GET", url: "/v1/status" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      code: "INTERNAL_ERROR",
      detail: null,
      instance: "/v1/status",
    });
    expect(response.body).not.toContain("private database detail");
  });
});
