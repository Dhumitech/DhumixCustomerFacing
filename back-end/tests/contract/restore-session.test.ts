import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import { ApplicationError } from "../../src/utils/applicationError.js";

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); });

async function fixture(overrides: NodeJS.ProcessEnv = {}) {
  const unused = async (): Promise<never> => { throw new Error("Unexpected dependency call"); };
  const restore = vi.fn(async () => ({ accessToken: "memory-access", expiresInSeconds: 900, csrfToken: "memory-csrf", identityEmail: "unit@example.test" }));
  const config = loadRuntimeConfig({ NODE_ENV: "test", HOST: "127.0.0.1", PORT: "3000", LOG_LEVEL: "silent",
    FRONTEND_ORIGIN: "http://localhost:5173", DATABASE_HOST: "localhost", DATABASE_PORT: "5432", DATABASE_NAME: "dhumi_test",
    DATABASE_IDENTITY_USER: "dhumi_test_identity_login", DATABASE_IDENTITY_PASSWORD: "identity-password-at-least-20-characters",
    DATABASE_CUSTOMER_API_USER: "dhumi_test_customer_api_login", DATABASE_CUSTOMER_API_PASSWORD: "customer-password-at-least-20-characters",
    DATABASE_ADMISSION_USER: "dhumi_test_admission_login", DATABASE_ADMISSION_PASSWORD: "admission-password-at-least-20-characters",
    DATABASE_SSL_MODE: "disable", ACCESS_TOKEN_SECRET: "test-access-token-secret-at-least-32-chars",
    ACCESS_TOKEN_ISSUER: "https://dhumi.test", ACCESS_TOKEN_AUDIENCE: "dhumi-browser", ...overrides });
  app = await buildApp(config, {
    restoreSessionService: { restore }, signupService: { submit: unused }, signInService: { authenticate: unused },
    refreshService: { refresh: unused }, logoutService: { logout: unused }, browserAuthenticationService: { authenticate: unused },
    tenantAuthorizationService: { authorizeBrowserTenant: unused }, workspaceService: { getWorkspace: unused },
    listCatalogTemplatesService: { list: unused }, getCatalogTemplateService: { get: unused },
    listServicesService: { list: unused }, createServiceService: { create: unused }, getServiceService: { get: unused },
  });
  return { app, restore };
}

describe("GET /v1/auth/session", () => {
  it.each([0, 1])("uses only the configured private proxy hop for client IP: %s", async hops => {
    const { app } = await fixture({ TRUST_PROXY_HOPS: String(hops) });
    let observed = "";
    app.addHook("onRequest", async request => { observed = request.ip; });
    await app.inject({ method: "GET", url: "/v1/status", remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": "198.51.100.99, 192.0.2.1" } });
    expect(observed).toBe(hops === 1 ? "192.0.2.1" : "127.0.0.1");
  });
  it.each([{ origin: "http://localhost:5173" }, { "sec-fetch-site": "same-origin" }])("restores with trusted browser provenance: %j", async provenance => {
    const { app, restore } = await fixture();
    const response = await app.inject({ method: "GET", url: "/v1/auth/session", headers: { ...provenance, cookie: `dhumi_refresh=${"a".repeat(43)}` } });
    expect(response.statusCode).toBe(200);
    expect(restore).toHaveBeenCalledWith("a".repeat(43));
    expect(Object.keys(response.json()).sort()).toEqual(["access_token", "csrf_token", "expires_in", "identity_email", "token_type"]);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).not.toContain("a".repeat(43));
  });
  it.each([{}, { origin: "https://untrusted.example" }, { "sec-fetch-site": "cross-site" }, { origin: "https://untrusted.example", "sec-fetch-site": "same-origin" }])("denies untrusted or absent provenance before restoring: %j", async headers => {
    const { app, restore } = await fixture();
    const response = await app.inject({ method: "GET", url: "/v1/auth/session", headers });
    expect(response.statusCode).toBe(403); expect(restore).not.toHaveBeenCalled();
    expect(response.headers["cache-control"]).toBe("no-store");
  });
  it("preserves the generic unauthenticated outcome for absent/revoked cookies", async () => {
    const { app, restore } = await fixture();
    restore.mockRejectedValue(new ApplicationError({ status: 401, code: "AUTHENTICATION_REQUIRED", title: "Authentication required" }));
    const response = await app.inject({ method: "GET", url: "/v1/auth/session", headers: { origin: "http://localhost:5173" } });
    expect(response.statusCode).toBe(401); expect(restore).toHaveBeenCalledWith(undefined);
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});
