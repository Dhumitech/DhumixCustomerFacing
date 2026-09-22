import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import type { SignInService } from "../../src/services/identity/signInService.js";
import type { SignupService } from "../../src/services/identity/signupService.js";
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
import {
  stubCreateServiceService,
  stubCreateRunService,
  stubCancelRunService,
  stubGetServiceService,
  stubListServicesService,
} from "../support/serviceStub.js";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import { PUBLIC_PROBLEM_CODES } from "../../src/utils/publicProblemCode.js";

let app: FastifyInstance | undefined;

/** These cases exercise the runtime shell only; no signup is submitted. */
const stubSignupService: SignupService = {
  async submit() {
    throw new Error("stub signup service was not expected to be called");
  },
};

afterEach(async () => {
  await app?.close();
  app = undefined;
});

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

const appDependencies = {
  signupService: stubSignupService,
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
  createRunService: stubCreateRunService,
  cancelRunService: stubCancelRunService,
};

describe("runtime application", () => {
  function config() {
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

  it("returns a safe Problem response and accepts a validated caller request ID", async () => {
    app = await buildApp(config(), appDependencies);

    const response = await app.inject({
      method: "GET",
      url: "/not-an-api",
      headers: {
        origin: "http://localhost:5173",
        "x-request-id": "customer-request-001",
      },
    });

    const body = response.json<Record<string, unknown>>();
    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.headers["x-request-id"]).toBe("customer-request-001");
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(body).toMatchObject({
      type: "about:blank",
      title: "Route not found",
      status: 404,
      code: "RESOURCE_NOT_FOUND",
      request_id: response.headers["x-request-id"],
    });
    expect(JSON.stringify(body)).not.toContain("stack");
  });

  it("replaces an unsafe caller request ID without rejecting the business request", async () => {
    app = await buildApp(config(), appDependencies);

    const response = await app.inject({
      method: "GET",
      url: "/not-an-api",
      headers: { "x-request-id": "contains spaces" },
    });

    const body = response.json<Record<string, unknown>>();
    expect(response.statusCode).toBe(404);
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers["x-request-id"]).not.toBe("contains spaces");
    expect(body).toMatchObject({
      title: "Route not found",
      status: 404,
      code: "RESOURCE_NOT_FOUND",
      request_id: response.headers["x-request-id"],
    });
  });

  it("does not grant CORS access to an unapproved browser origin", async () => {
    app = await buildApp(config(), appDependencies);

    const response = await app.inject({
      method: "GET",
      url: "/not-an-api",
      headers: { origin: "https://unapproved.example" },
    });

    // A fixed-origin CORS policy always advertises only the approved origin.
    // The browser rejects it because it does not match the caller's Origin.
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(response.headers["access-control-allow-origin"]).not.toBe(
      "https://unapproved.example",
    );
  });

  it("registers cookie parsing and the route-level rate-limit seam", async () => {
    app = await buildApp(config(), appDependencies);
    await app.ready();

    expect(app.hasRequestDecorator("cookies")).toBe(true);
    expect(app.hasDecorator("rateLimit")).toBe(true);
  });

  // An unparseable body fails inside the content-type parser, which Fastify
  // runs before preValidation, validation and preHandler. `attachValidation`
  // therefore never sees it and no route can map it itself, so the shared
  // handler owns the outcome for every body-carrying operation.
  it.each([
    ["unparseable JSON", '{"name":'],
    ["a non-JSON body", "hello"],
    ["an empty body", ""],
  ])("answers %s with the declared 400 Problem", async (_label, payload) => {
    app = await buildApp(config(), appDependencies);

    const response = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { "content-type": "application/json" },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({
      type: "about:blank",
      title: "Malformed request",
      status: 400,
      code: "BAD_REQUEST",
      request_id: response.headers["x-request-id"],
    });
    // The framework's parser message can quote the caller's bytes.
    expect(response.json()).toMatchObject({ detail: null });
  });

  it("reports one code for both routes into the declared 400", async () => {
    app = await buildApp(config(), appDependencies);

    const parseFailure = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      headers: { "content-type": "application/json" },
      payload: '{"email":',
    });
    const schemaViolation = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      headers: { "content-type": "application/json" },
      payload: { unexpected: true },
    });

    expect(parseFailure.statusCode).toBe(400);
    expect(schemaViolation.statusCode).toBe(400);
    expect(parseFailure.json().code).toBe(schemaViolation.json().code);
    expect(parseFailure.json().code).toBe("BAD_REQUEST");
  });

  it("answers an oversized JSON body with the declared 413 Problem", async () => {
    app = await buildApp(config(), appDependencies);

    const response = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "A".repeat(1_048_576) }),
    });

    expect(response.statusCode).toBe(413);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({
      type: "about:blank",
      title: "Payload too large",
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
      detail: null,
      request_id: response.headers["x-request-id"],
    });
  });

  it("answers an unsupported request media type with the declared 415 Problem", async () => {
    app = await buildApp(config(), appDependencies);

    const response = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { "content-type": "application/xml" },
      payload: "<key />",
    });

    expect(response.statusCode).toBe(415);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({
      type: "about:blank",
      title: "Unsupported media type",
      status: 415,
      code: "UNSUPPORTED_MEDIA_TYPE",
      detail: null,
      request_id: response.headers["x-request-id"],
    });
  });

  it("keeps runtime, OpenAPI, and public prose Problem codes identical", async () => {
    const openApi = await readFile(
      new URL("../../contracts/openapi.yaml", import.meta.url),
      "utf8",
    );
    const publicApi = await readFile(
      new URL("../../contracts/public-api.md", import.meta.url),
      "utf8",
    );
    const openApiSection = /    ProblemCode:\r?\n(?<body>[\s\S]*?)    Problem:\r?\n/.exec(openApi)
      ?.groups?.body;
    const proseSection = /\| HTTP \| Stable Dhumi code \| Meaning \|(?<body>[\s\S]*?)\r?\n\r?\nProvider errors/.exec(
      publicApi,
    )?.groups?.body;

    expect(openApiSection).toBeDefined();
    expect(proseSection).toBeDefined();
    const openApiCodes = [...(openApiSection ?? "").matchAll(/^        - ([A-Z0-9_]+)$/gm)].map(
      ([, code]) => code,
    );
    const proseCodes = [...(proseSection ?? "").matchAll(/`([A-Z0-9_]+)`/g)].map(
      ([, code]) => code,
    );

    expect(openApiCodes).toEqual([...PUBLIC_PROBLEM_CODES]);
    expect([...new Set(proseCodes)].sort()).toEqual([...PUBLIC_PROBLEM_CODES].sort());
  });

  it("declares shared parser failures for every JSON-body operation", async () => {
    const openApi = await readFile(
      new URL("../../contracts/openapi.yaml", import.meta.url),
      "utf8",
    );

    for (const operationId of [
      "signUp",
      "signIn",
      "createApiKey",
      "createService",
      "createRun",
    ]) {
      const start = openApi.indexOf(`operationId: ${operationId}`);
      const next = openApi.indexOf("\n      operationId:", start + 1);
      const operation = openApi.slice(start, next === -1 ? undefined : next);

      expect(start, `${operationId} must exist`).toBeGreaterThanOrEqual(0);
      expect(operation, `${operationId} must declare 400`).toContain(
        "'400': { $ref: '#/components/responses/BadRequest' }",
      );
      expect(operation, `${operationId} must declare 413`).toContain(
        "'413': { $ref: '#/components/responses/PayloadTooLarge' }",
      );
      expect(operation, `${operationId} must declare 415`).toContain(
        "'415': { $ref: '#/components/responses/UnsupportedMediaType' }",
      );
    }

    const createServiceStart = openApi.indexOf("operationId: createService");
    const nextOperation = openApi.indexOf("\n      operationId:", createServiceStart + 1);
    const createServiceOperation = openApi.slice(createServiceStart, nextOperation);
    expect(createServiceOperation).toContain(
      "'500': { $ref: '#/components/responses/InternalServerError' }",
    );
  });
});
