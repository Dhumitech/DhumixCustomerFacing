import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadRuntimeConfig, type RuntimeConfig } from "../../src/config/environment.js";
import type { PublicCatalogTemplateRecord } from "../../src/services/catalogue/catalogTemplate.js";
import {
  createGetCatalogTemplateService,
  type GetCatalogTemplateRequest,
  type GetCatalogTemplateService,
} from "../../src/services/catalogue/getCatalogTemplateService.js";
import type {
  BrowserAuthenticationService,
  TrustedSessionIdentity,
} from "../../src/services/identity/browserAuthenticationService.js";
import type { LogoutService } from "../../src/services/identity/logoutService.js";
import type { MarketplacePreviewService } from "../../src/services/marketplacePreview/marketplacePreviewService.js";
import type { MarketplaceSampleDownloadService } from "../../src/services/marketplaceSampleDownload/marketplaceSampleDownloadService.js";
import type { MarketplaceExpertEnquiryService } from "../../src/services/marketplaceExpertEnquiry/marketplaceExpertEnquiryService.js";
import type { RefreshService } from "../../src/services/identity/refreshService.js";
import { authenticationRequired } from "../../src/services/identity/sessionErrors.js";
import type { SignInService } from "../../src/services/identity/signInService.js";
import type { SignupService } from "../../src/services/identity/signupService.js";
import { workspaceUnavailable } from "../../src/services/tenantAccess/tenantAccessErrors.js";
import type {
  TenantAuthorizationService,
  TrustedTenantIdentity,
} from "../../src/services/tenantAccess/tenantAuthorizationService.js";
import type { WorkspaceService } from "../../src/services/workspace/workspaceService.js";
import { stubListCatalogTemplatesService } from "../support/catalogueStub.js";
import {
  AMAZON_OPERATION_FIXTURES,
  AMAZON_PUBLIC_TEMPLATES,
} from "../support/amazonCatalogueFixtures.js";
import {
  stubCreateServiceService,
  stubGetServiceService,
  stubListServicesService,
} from "../support/serviceStub.js";

const ACCESS_TOKEN = "header.payload.signature";
const API_KEY = `dhk_v1_${"A".repeat(16)}.${"A".repeat(43)}`;
const organizationId = randomUUID();
const sessionIdentity: TrustedSessionIdentity = {
  userId: randomUUID(),
  sessionId: randomUUID(),
};
const tenantIdentity: TrustedTenantIdentity = {
  userId: sessionIdentity.userId,
  sessionId: sessionIdentity.sessionId,
  tenantId: organizationId,
};
const presentation = {
  domain_slug: "amazon-com",
  domain_name: "amazon.com",
  category: "e-commerce",
  icon_key: "amazon",
  operation_group: "Amazon products",
  operation_name: "Collect by URL",
  display_priority: 1,
} as const;

const record: PublicCatalogTemplateRecord = {
  id: randomUUID(),
  slug: "amazon-products",
  family: "marketplace_dataset",
  templateState: "published",
  version: 1,
  name: "Amazon products",
  description: "Approved product catalogue template",
  availabilityState: "available",
  presentation,
  configurationSchema: { type: "object", additionalProperties: false },
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
};

const template = {
  slug: record.slug,
  version: record.version,
  family: record.family,
  name: record.name,
  description: record.description,
  availability: record.availabilityState,
  presentation: record.presentation,
  configuration_schema: record.configurationSchema,
  input_schema: record.inputSchema,
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

interface RecordingGetTemplateService extends GetCatalogTemplateService {
  readonly calls: GetCatalogTemplateRequest[];
  result: PublicCatalogTemplateRecord | undefined;
  failWith?: Error;
}

function getTemplateService(): RecordingGetTemplateService {
  const calls: GetCatalogTemplateRequest[] = [];
  const service: RecordingGetTemplateService = {
    calls,
    result: record,
    async get(request) {
      calls.push(request);
      if (service.failWith !== undefined) throw service.failWith;
      return createGetCatalogTemplateService({
        repository: {
          async findBySlug() {
            return service.result;
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
let detail: RecordingGetTemplateService;
let tenant: SwitchableTenantAuthorization;

beforeEach(() => {
  detail = getTemplateService();
  tenant = tenantAuthorization();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(
  getService: GetCatalogTemplateService = detail,
  marketplacePreviewService: MarketplacePreviewService = {
    async get() {
      throw new Error("unexpected Marketplace sample read");
    },
    async query() {
      throw new Error("unexpected Marketplace sample query");
    },
  },
  marketplaceSampleDownloadService: MarketplaceSampleDownloadService = {
    async authorize() {
      throw new Error("unexpected Marketplace sample download");
    },
  },
  marketplaceExpertEnquiryService: MarketplaceExpertEnquiryService = {
    async submit() {
      throw new Error("unexpected Marketplace expert enquiry");
    },
  },
): Promise<FastifyInstance> {
  app = await buildApp(config(), {
    signupService: stubSignupService,
    signInService: stubSignInService,
    refreshService: stubRefreshService,
    browserAuthenticationService: browserAuthentication(),
    logoutService: stubLogoutService,
    tenantAuthorizationService: tenant,
    workspaceService: stubWorkspaceService,
    listCatalogTemplatesService: stubListCatalogTemplatesService,
    getCatalogTemplateService: getService,
    marketplacePreviewService,
    marketplaceSampleDownloadService,
    marketplaceExpertEnquiryService,
    listServicesService: stubListServicesService,
    createServiceService: stubCreateServiceService,
    getServiceService: stubGetServiceService,
  });
  return app;
}

async function get(
  instance: FastifyInstance,
  slug = "amazon-products",
  authorization = `Bearer ${ACCESS_TOKEN}`,
) {
  return instance.inject({
    method: "GET",
    url: `/v1/catalog/templates/${slug}`,
    headers: { authorization },
  });
}

describe("GET /v1/catalog/templates/{slug} contract", () => {
  it("returns the exact ServiceTemplate from a trusted browser principal", async () => {
    const requestId = randomUUID();
    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/catalog/templates/amazon-products",
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "x-request-id": requestId,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe(requestId);
    expect(response.json()).toEqual(template);
    expect(detail.calls).toEqual([
      {
        principal: { kind: "browser", ...sessionIdentity },
        slug: "amazon-products",
        schemaErrors: [],
      },
    ]);
  });

  it("rejects retired customer API keys before lookup", async () => {
    const instance = await build();
    const denied = await get(instance, "amazon-products", `Bearer ${API_KEY}`);
    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    expect(detail.calls).toHaveLength(0);
  });

  it("authenticates before exposing malformed-slug behavior", async () => {
    const response = await get(await build(), "Amazon--products", "Bearer invalid");

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe("Bearer");
    expect(response.json()).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    expect(detail.calls).toHaveLength(0);
  });

  it("checks a supplied organization selector even for browsing", async () => {
    tenant.failWith = workspaceUnavailable();
    const response = await (await build()).inject({
      method: "GET",
      url: "/v1/catalog/templates/amazon-products",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}`, "x-dhumi-organization": organizationId },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "ACCESS_DENIED" });
    expect(detail.calls).toHaveLength(0);
  });

  it("maps malformed and invisible slugs to the same safe 404 contract", async () => {
    const instance = await build();
    const malformed = await get(instance, "amazon--products");
    detail.result = undefined;
    const invisible = await get(instance, "missing-template");

    for (const response of [malformed, invisible]) {
      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.json()).toMatchObject({
        status: 404,
        code: "RESOURCE_NOT_FOUND",
        title: "Resource not found",
        detail: null,
      });
      expect(response.json()).not.toHaveProperty("errors");
      expect(response.body).not.toMatch(/pattern|validation|exists|published|evidence|tenant/i);
    }
  });

  it("serializes only the accepted public Template fields", async () => {
    const response = await get(
      await build({
        async get() {
          return {
            ...template,
            id: randomUUID(),
            adapter_version_id: "forbidden-adapter",
            launch_evidence_id: "forbidden-evidence",
            dataset_id: "gd_forbidden123456",
            output_schema: { secret: true },
            presentation: {
              ...template.presentation,
              provider_dataset_id: "gd_nestedforbidden123456",
            },
          };
        },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json<Record<string, unknown>>()).sort()).toEqual([
      "availability",
      "configuration_schema",
      "description",
      "family",
      "input_schema",
      "name",
      "presentation",
      "slug",
      "version",
    ]);
    expect(
      Object.keys(response.json<{ presentation: Record<string, unknown> }>().presentation).sort(),
    ).toEqual([
      "category",
      "display_priority",
      "domain_name",
      "domain_slug",
      "icon_key",
      "operation_group",
      "operation_name",
    ]);
    expect(response.body).not.toMatch(/forbidden|adapter|evidence|dataset_id|output_schema/i);
    expect(response.body).not.toMatch(/gd_[a-z0-9]{8,}/i);
  });

  it("resolves all 13 registry slugs through the same generic detail handler", async () => {
    const calls: unknown[] = [];
    const templatesBySlug = new Map(
      AMAZON_PUBLIC_TEMPLATES.map((publicTemplate) => [publicTemplate.slug, publicTemplate]),
    );
    const instance = await build({
      async get(request) {
        calls.push(request.slug);
        if (typeof request.slug !== "string") throw new Error("unexpected non-string slug");
        const publicTemplate = templatesBySlug.get(request.slug);
        if (publicTemplate === undefined) throw new Error("unexpected missing fixture slug");
        return publicTemplate;
      },
    });

    for (const operation of AMAZON_OPERATION_FIXTURES) {
      const response = await get(instance, operation.slug);
      expect(response.statusCode, operation.slug).toBe(200);
      expect(response.json()).toMatchObject({
        slug: operation.slug,
        family: "scraper_library",
        input_schema: operation.inputSchema,
      });
    }

    expect(calls).toEqual(AMAZON_OPERATION_FIXTURES.map((operation) => operation.slug));
  });

  it("returns a correlated generic 500 without database or provider details", async () => {
    detail.failWith = Object.assign(
      new Error('permission denied for relation "app.service_template_versions"'),
      { code: "42501", provider_error: "Bright Data account detail" },
    );
    const response = await get(await build());

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      code: "INTERNAL_ERROR",
      instance: "/v1/catalog/templates/amazon-products",
    });
    expect(response.body).not.toMatch(/service_template|42501|permission denied|Bright Data/i);
  });

  it("does not require cookies or CSRF for this read-only operation", async () => {
    expect((await get(await build())).statusCode).toBe(200);
  });

  it("serves masked stored-sample reads and forwards browser CSRF for local queries", async () => {
    const calls: Array<{
      operation: string;
      request:
        | Parameters<MarketplacePreviewService["get"]>[0]
        | Parameters<MarketplacePreviewService["query"]>[0];
    }> = [];
    const result = {
      template_slug: "linkedin-posts",
      template_version: 1,
      sample_version: 1,
      sample_record_count: 2,
      matches_in_sample: 1,
      selected_fields: ["url", "text"],
      rows: [{ url: "https://www.linkedin.com/posts/example", text: "Synt***one." }],
      masking_notice: "Values containing *** are masked; counts are sample-relative.",
      page: { next_cursor: null, has_more: false },
    } as const;
    const marketplacePreviewService: MarketplacePreviewService = {
      async get(request) {
        calls.push({ operation: "get", request });
        return result;
      },
      async query(request) {
        calls.push({ operation: "query", request });
        return result;
      },
    };
    const instance = await build(detail, marketplacePreviewService);
    tenant.failWith = workspaceUnavailable();

    const read = await instance.inject({
      method: "GET",
      url: "/v1/catalog/templates/linkedin-posts/sample?limit=30",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(result);
    expect(read.body).not.toMatch(/object_key|dataset_id|provider/i);

    const query = await instance.inject({
      method: "POST",
      url: "/v1/catalog/templates/linkedin-posts/sample/query",
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "x-csrf-token": "valid-browser-csrf-token",
        "content-type": "application/json",
      },
      payload: {
        expected_sample_version: 1,
        selected_fields: ["text"],
        filter: { name: "text", operator: "includes", value: "sample" },
        page: { limit: 30 },
      },
    });
    expect(query.statusCode).toBe(200);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.request.principal).toEqual({ kind: "browser", ...sessionIdentity });
      expect(call.request.principal).not.toHaveProperty("tenantId");
    }
    expect(calls[1]).toMatchObject({
      operation: "query",
      request: {
        slug: "linkedin-posts",
        csrfToken: "valid-browser-csrf-token",
      },
    });
  });

  it("authorizes a bounded sample download through the authenticated catalogue boundary", async () => {
    const calls: Parameters<MarketplaceSampleDownloadService["authorize"]>[0][] = [];
    const download: MarketplaceSampleDownloadService = {
      async authorize(request) {
        calls.push(request);
        return {
          sample_version: 1,
          format: "json",
          record_count: 2,
          content_type: "application/json; charset=utf-8",
          byte_count: 241,
          checksum: "a".repeat(64),
          download_url:
            "http://127.0.0.1:10000/devstoreaccount1/dhumi-test-results/sample.json?sig=redacted",
          download_expires_at: "2026-09-11T12:05:00.000Z",
        };
      },
    };
    const instance = await build(detail, undefined, download);
    const response = await instance.inject({
      method: "POST",
      url: "/v1/catalog/templates/linkedin-posts/sample/downloads",
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "x-csrf-token": "valid-browser-csrf-token",
        "idempotency-key": "sample-download-contract-0001",
        "content-type": "application/json",
      },
      payload: {
        expected_sample_version: 1,
        selected_fields: ["url", "text"],
        filter: { name: "text", operator: "includes", value: "sample" },
        format: "json",
        record_limit: 30,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ format: "json", record_count: 2 });
    expect(response.body).not.toMatch(/object_key|provider|dataset_id/i);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      principal: { kind: "browser", ...sessionIdentity },
      slug: "linkedin-posts",
      csrfToken: "valid-browser-csrf-token",
      idempotencyKey: "sample-download-contract-0001",
      body: { record_limit: 30, format: "json" },
      schemaErrors: [],
    });
    expect(calls[0]?.ipFingerprint).toBeInstanceOf(Buffer);
  });

  it("rejects a sample download with a retired customer API key before authorization", async () => {
    const calls: unknown[] = [];
    const download: MarketplaceSampleDownloadService = {
      async authorize(request) {
        calls.push(request);
        throw new Error("must not authorize");
      },
    };
    const instance = await build(detail, undefined, download);
    const response = await instance.inject({
      method: "POST",
      url: "/v1/catalog/templates/linkedin-posts/sample/downloads",
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "idempotency-key": "sample-download-contract-0002",
      },
      payload: {
        expected_sample_version: 1,
        selected_fields: ["url"],
        format: "csv",
        record_limit: 2,
      },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    expect(calls).toHaveLength(0);
  });

  it("records an authenticated, version-pinned Marketplace expert enquiry", async () => {
    const calls: Parameters<MarketplaceExpertEnquiryService["submit"]>[0][] = [];
    const enquiry: MarketplaceExpertEnquiryService = {
      async submit(request) {
        calls.push(request);
        return {
          id: "1d000000-0000-4000-8000-000000000001",
          template_slug: "linkedin-posts",
          template_version: 1,
          state: "received",
          submitted_at: "2026-09-12T10:00:00.000Z",
        };
      },
    };
    const instance = await build(detail, undefined, undefined, enquiry);
    const response = await instance.inject({
      method: "POST",
      url: "/v1/catalog/templates/linkedin-posts/expert-enquiries",
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "x-csrf-token": "valid-browser-csrf-token",
        "idempotency-key": "expert-enquiry-contract-0001",
        "content-type": "application/json",
      },
      payload: { expected_template_version: 1 },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      template_slug: "linkedin-posts",
      template_version: 1,
      state: "received",
    });
    expect(response.body).not.toMatch(/provider|dataset_id|payment|entitlement/i);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      principal: { kind: "browser", ...sessionIdentity },
      slug: "linkedin-posts",
      csrfToken: "valid-browser-csrf-token",
      idempotencyKey: "expert-enquiry-contract-0001",
      body: { expected_template_version: 1 },
      schemaErrors: [],
    });
    expect(calls[0]?.ipFingerprint).toBeInstanceOf(Buffer);
  });

  it("rejects an expert enquiry with a retired customer API key before persistence", async () => {
    const calls: unknown[] = [];
    const enquiry: MarketplaceExpertEnquiryService = {
      async submit(request) {
        calls.push(request);
        throw new Error("must not persist");
      },
    };
    const instance = await build(detail, undefined, undefined, enquiry);
    const response = await instance.inject({
      method: "POST",
      url: "/v1/catalog/templates/linkedin-posts/expert-enquiries",
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "idempotency-key": "expert-enquiry-contract-0002",
      },
      payload: { expected_template_version: 1 },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    expect(calls).toHaveLength(0);
  });
});
