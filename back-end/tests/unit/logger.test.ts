import pino from "pino";
import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../src/config/environment.js";
import { createLoggerOptions, safeErrorLogContext } from "../../src/config/logger.js";

function configuration() {
  return loadRuntimeConfig({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "3000",
    LOG_LEVEL: "info",
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

describe("structured logger", () => {
  it("redacts authenticated Redis URLs at all runtime/env entry points", () => {
    const records: string[] = [];
    const logger = pino(createLoggerOptions(configuration()), { write: (value: string) => records.push(value) });
    const redisUrl = "rediss://:redis-private-access-key@redis.example:10000";
    logger.info({ REDIS_URL: redisUrl, env: { REDIS_URL: redisUrl }, redisUrl, config: { redisUrl } });
    expect(records.join("")).not.toContain("redis-private-access-key");
    expect(records.join("")).toContain("[REDACTED]");
  });
  it("redacts Service Bus role credentials and legacy connection strings", () => {
    const records: string[] = [];
    const logger = pino(createLoggerOptions(configuration()), { write: (value: string) => records.push(value) });
    const clientSecret = "servicebus-role-private-value", connection = "servicebus-sas-private-value";
    logger.info({ SERVICE_BUS_SENDER_CLIENT_SECRET: clientSecret, SERVICE_BUS_RECEIVER_CLIENT_SECRET: clientSecret,
      env: { SERVICE_BUS_SENDER_CLIENT_SECRET: clientSecret, SERVICE_BUS_RECEIVER_CLIENT_SECRET: clientSecret },
      SERVICE_BUS_CONNECTION_STRING: connection, serviceBus: { credential: { clientSecret }, connectionString: connection },
      config: { serviceBus: { credential: { clientSecret }, connectionString: connection } } });
    expect(records.join("")).not.toContain(clientSecret);
    expect(records.join("")).not.toContain(connection);
    expect(records.join("")).toContain("[REDACTED]");
  });
  it("redacts Azure client secrets from environment and runtime configuration", () => {
    const records: string[] = [];
    const logger = pino(createLoggerOptions(configuration()), { write: (value: string) => records.push(value) });
    const clientSecret = "azure-client-private-value";
    logger.info({ AZURE_CLIENT_SECRET: clientSecret, env: { AZURE_CLIENT_SECRET: clientSecret },
      azure: { clientSecret }, resultStorage: { azure: { clientSecret } },
      config: { resultStorage: { azure: { clientSecret } } } });
    expect(records.join("")).not.toContain(clientSecret);
    expect(records.join("")).toContain("[REDACTED]");
  });
  it("redacts authorization, cookie, CSRF, and nested password fields", () => {
    const records: string[] = [];
    const destination = {
      write(value: string): void {
        records.push(value);
      },
    };
    const logger = pino(createLoggerOptions(configuration()), destination);

    logger.info({
      req: {
        headers: {
          authorization: "Bearer private",
          cookie: "session=private",
          "x-csrf-token": "csrf-header-private",
        },
      },
      config: {
        responseEnvelope: { localKeyBase64Url: "envelope-root-private" },
        database: {
          identity: { password: "database-private" },
          credential: { password: "janitor-database-private" },
        },
      },
      response: {
        csrf_token: "csrf-response-private",
        secret: "plaintext-api-key-private",
        authorization: "Bearer nested-private",
        keyHash: "camel-hash-private",
        key_hash: "snake-hash-private",
        response_envelope_ciphertext: "ciphertext-private",
        response_envelope_key_reference: "key-reference-private",
        provider: {
          apiKey: "bright-data-key-private",
          vaultSecretReference: "vault-reference-private",
          datasetId: "gd_provider-reference-private",
          snapshotReference: "s_snapshot-reference-private",
        },
      },
    });

    const output = records.join("");
    expect(output).not.toContain("Bearer private");
    expect(output).not.toContain("session=private");
    expect(output).not.toContain("csrf-header-private");
    expect(output).not.toContain("csrf-response-private");
    expect(output).not.toContain("database-private");
    expect(output).not.toContain("janitor-database-private");
    expect(output).not.toContain("envelope-root-private");
    expect(output).not.toContain("plaintext-api-key-private");
    expect(output).not.toContain("nested-private");
    expect(output).not.toContain("camel-hash-private");
    expect(output).not.toContain("snake-hash-private");
    expect(output).not.toContain("ciphertext-private");
    expect(output).not.toContain("key-reference-private");
    expect(output).not.toContain("bright-data-key-private");
    expect(output).not.toContain("vault-reference-private");
    expect(output).not.toContain("gd_provider-reference-private");
    expect(output).not.toContain("s_snapshot-reference-private");
    expect(output).toContain("[REDACTED]");
  });

  it("supports a distinct worker service identity", () => {
    const options = createLoggerOptions(configuration(), "dhumi-envelope-janitor");

    expect(options.base).toMatchObject({ service: "dhumi-envelope-janitor" });
  });

  it("keeps diagnostic frames while excluding error messages and causes", () => {
    const credential = "Bearer dhk_v1_private";
    const error = new Error(`database failed for ${credential}`, {
      cause: new Error(`query parameter contained ${credential}`),
    });
    error.name = "RepositoryFailure";

    const context = safeErrorLogContext(error);

    expect(context.error.type).toBe("RepositoryFailure");
    expect(context.error.stack).toContain("logger.test.ts");
    expect(JSON.stringify(context)).not.toContain(credential);
    expect(JSON.stringify(context)).not.toContain("query parameter");
  });

  it("does not trust a caller-controlled error type", () => {
    const error = new Error("safe message");
    error.name = "Bearer dhk_v1_private";

    expect(safeErrorLogContext(error).error.type).toBe("Error");
  });

  it("keeps only an enum-shaped safe provider reason", () => {
    const safe = new Error("provider body remains private") as Error & {
      safeReason?: string;
    };
    safe.safeReason = "PROVIDER_SNAPSHOT_REFERENCE_INVALID";
    expect(safeErrorLogContext(safe).error.safeReason).toBe(
      "PROVIDER_SNAPSHOT_REFERENCE_INVALID",
    );

    safe.safeReason = "PROVIDER_SNAPSHOT_REFERENCE_MISSING";
    expect(safeErrorLogContext(safe).error.safeReason).toBe(
      "PROVIDER_SNAPSHOT_REFERENCE_MISSING",
    );

    safe.safeReason = "PROVIDER_HTTP_422";
    expect(safeErrorLogContext(safe).error.safeReason).toBe("PROVIDER_HTTP_422");

    safe.safeReason = "PROVIDER_HTTP_402";
    expect(safeErrorLogContext(safe).error.safeReason).toBe("PROVIDER_HTTP_402");

    const unsafe = new Error("private") as Error & { safeReason?: string };
    unsafe.safeReason = "snapshot=s_private-value";
    expect(safeErrorLogContext(unsafe).error).not.toHaveProperty("safeReason");
  });

  it("retains only safe finite byte-boundary diagnostics", () => {
    const error = new Error("private provider response") as Error & {
      safeReason?: string;
      observedByteCount?: number;
      maximumByteCount?: number;
    };
    error.safeReason = "PROVIDER_CONTROL_TOO_LARGE";
    error.observedByteCount = 1_234_567;
    error.maximumByteCount = 1_048_576;

    expect(safeErrorLogContext(error).error).toMatchObject({
      safeReason: "PROVIDER_CONTROL_TOO_LARGE",
      observedByteCount: 1_234_567,
      maximumByteCount: 1_048_576,
    });

    error.observedByteCount = Number.NaN;
    error.maximumByteCount = -1;
    expect(safeErrorLogContext(error).error).not.toHaveProperty("observedByteCount");
    expect(safeErrorLogContext(error).error).not.toHaveProperty("maximumByteCount");
  });

  it("removes query values from automatic request-log metadata", () => {
    const serializer = createLoggerOptions(configuration()).serializers?.req;

    expect(serializer).toBeTypeOf("function");
    const serialized = serializer!({
      method: "GET",
      url: "/v1/keys?cursor=opaque-customer-cursor&limit=20",
      headers: { "accept-version": "1" },
      host: "localhost",
      ip: "127.0.0.1",
      socket: { remotePort: 54321 },
    });
    expect(serialized).toMatchObject({ method: "GET", url: "/v1/keys" });
    expect(JSON.stringify(serialized)).not.toContain("opaque-customer-cursor");
  });
});
