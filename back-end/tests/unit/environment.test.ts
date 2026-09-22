import { describe, expect, it } from "vitest";
import {
  ConfigurationError,
  loadEnvelopeJanitorConfig,
  loadResultRecorderConfig,
  loadRuntimeConfig,
} from "../../src/config/environment.js";

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
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
    DATABASE_POOL_MIN: "0",
    DATABASE_POOL_MAX: "5",
    DATABASE_CONNECTION_TIMEOUT_MS: "5000",
    DATABASE_IDLE_TIMEOUT_MS: "30000",
    DATABASE_STATEMENT_TIMEOUT_MS: "15000",
    DATABASE_QUERY_TIMEOUT_MS: "20000",
    DATABASE_IDLE_TRANSACTION_TIMEOUT_MS: "30000",
    DATABASE_SSL_MODE: "disable",
    ACCESS_TOKEN_SECRET: "test-access-token-secret-at-least-32-chars",
    ACCESS_TOKEN_ISSUER: "https://dhumi.test",
    ACCESS_TOKEN_AUDIENCE: "dhumi-browser",
    RESPONSE_ENVELOPE_LOCAL_KEY: "A".repeat(43),
    MARKETPLACE_SAMPLE_DOWNLOAD_MAX_RECORDS: "100",
    MARKETPLACE_SAMPLE_DOWNLOAD_MAX_BYTES: "1048576",
    MARKETPLACE_SAMPLE_DOWNLOAD_RATE_LIMIT_MAX: "10",
    MARKETPLACE_SAMPLE_DOWNLOAD_RATE_WINDOW_SECONDS: "3600",
  };
}

function validEnvelopeJanitorEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_HOST: "localhost",
    DATABASE_PORT: "5432",
    DATABASE_NAME: "dhumi_test",
    DATABASE_ENVELOPE_JANITOR_USER: "dhumi_test_envelope_janitor_login",
    DATABASE_ENVELOPE_JANITOR_PASSWORD: "janitor-password-at-least-20-characters",
    DATABASE_SSL_MODE: "disable",
  };
}

function validResultRecorderEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_HOST: "localhost",
    DATABASE_PORT: "5432",
    DATABASE_NAME: "dhumi_test",
    DATABASE_RESULT_RECORDER_USER: "dhumi_test_result_recorder_login",
    DATABASE_RESULT_RECORDER_PASSWORD: "recorder-password-at-least-20-characters",
    DATABASE_SSL_MODE: "disable",
    RESULT_STORAGE_DRIVER: "azurite",
    RESULT_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true",
    RESULT_STORAGE_CONTAINER: "dhumi-test-results",
  };
}

describe("loadRuntimeConfig", () => {
  it("loads a valid local configuration", () => {
    const config = loadRuntimeConfig(validEnvironment());

    expect(config.database.database).toBe("dhumi_test");
    expect(config.database.identity.user).toBe("dhumi_test_identity_login");
    expect(config.database.customerApi.user).toBe("dhumi_test_customer_api_login");
    expect(config.database.admission.user).toBe("dhumi_test_admission_login");
    expect(config.providerEnvironment).toBe("local");
    expect(config.database.ssl).toBe(false);
    expect(config.responseEnvelope.localKeyBase64Url).toBe("A".repeat(43));
    expect(config.resultStorage).toMatchObject({
      driver: "unavailable",
      containerName: "dhumi-results",
      downloadTtlSeconds: 300,
      maxBytes: 104_857_600,
    });
    expect(config.marketplaceSampleDownload).toEqual({
      maxRecords: 100,
      maxBytes: 1_048_576,
      rateLimitMax: 10,
      rateWindowSeconds: 3_600,
      downloadTtlSeconds: 300,
    });
  });

  it("requires explicit Marketplace sample-download safety controls in production", () => {
    const source = validEnvironment();
    source.NODE_ENV = "production";
    source.DATABASE_SSL_MODE = "verify-full";
    source.DATABASE_SSL_CA_FILE = "C:/not-read-before-marketplace-control-check.pem";
    delete source.MARKETPLACE_SAMPLE_DOWNLOAD_MAX_BYTES;

    expect(() => loadRuntimeConfig(source)).toThrow(
      /Production Marketplace sample-download controls must be explicit: MARKETPLACE_SAMPLE_DOWNLOAD_MAX_BYTES/,
    );
  });

  it("enables Azurite only with an explicit loopback connection", () => {
    const source = validEnvironment();
    source.RESULT_STORAGE_DRIVER = "azurite";
    source.RESULT_STORAGE_CONNECTION_STRING =
      "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
      "AccountKey=local-emulator-value;" +
      "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";
    source.RESULT_STORAGE_CONTAINER = "dhumi-test-results";

    expect(loadRuntimeConfig(source).resultStorage).toMatchObject({
      driver: "azurite",
      connectionString: expect.stringContaining("BlobEndpoint=http://127.0.0.1"),
      containerName: "dhumi-test-results",
    });
  });

  it("fails closed for incomplete, remote, or production Azurite configuration", () => {
    const incomplete = validEnvironment();
    incomplete.RESULT_STORAGE_DRIVER = "azurite";
    expect(() => loadRuntimeConfig(incomplete)).toThrow(/RESULT_STORAGE_CONNECTION_STRING/);

    const remote = validEnvironment();
    remote.RESULT_STORAGE_DRIVER = "azurite";
    remote.RESULT_STORAGE_CONNECTION_STRING =
      "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
      "AccountKey=local-emulator-value;BlobEndpoint=http://storage.example.test:10000/account;";
    expect(() => loadRuntimeConfig(remote)).toThrow(/loopback Azurite/);

    const production = validEnvironment();
    production.NODE_ENV = "production";
    production.RESULT_STORAGE_DRIVER = "azurite";
    production.RESULT_STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
    expect(() => loadRuntimeConfig(production)).toThrow(/RESULT_STORAGE_DRIVER/);
  });

  it("rejects the local environment-key fallback in production", () => {
    const production = validEnvironment();
    production.NODE_ENV = "production";
    production.DATABASE_SSL_MODE = "verify-full";
    production.DATABASE_SSL_CA_FILE = "C:/not-read-because-canary-validation-fails.pem";
    production.LEGAL_DOCUMENTS = JSON.stringify([
      { document_type: "terms", document_version: "v1", content_hash: "a".repeat(64) },
    ]);
    production.BRIGHTDATA_API_KEY = "provider-secret-at-least-twenty-characters";
    expect(() => loadRuntimeConfig(production)).toThrow(/BRIGHTDATA_API_KEY/);
  });

  it("permits a 15-day access token only outside production", () => {
    const development = validEnvironment();
    development.ACCESS_TOKEN_TTL_SECONDS = "1296000";
    expect(loadRuntimeConfig(development).session.accessToken.ttlSeconds).toBe(1_296_000);

    const production = validEnvironment();
    production.NODE_ENV = "production";
    production.ACCESS_TOKEN_TTL_SECONDS = "1296000";
    expect(() => loadRuntimeConfig(production)).toThrow(/ACCESS_TOKEN_TTL_SECONDS/);
  });

  it("requires a canonical, independent 32-byte local response-envelope key", () => {
    const missing = validEnvironment();
    delete missing.RESPONSE_ENVELOPE_LOCAL_KEY;
    expect(() => loadRuntimeConfig(missing)).toThrow(/RESPONSE_ENVELOPE_LOCAL_KEY/);

    const malformed = validEnvironment();
    malformed.RESPONSE_ENVELOPE_LOCAL_KEY = "not-a-32-byte-key";
    expect(() => loadRuntimeConfig(malformed)).toThrow(/RESPONSE_ENVELOPE_LOCAL_KEY/);
  });

  it("rejects postgres and migration-owner runtime identities", () => {
    const source = validEnvironment();
    source.DATABASE_IDENTITY_USER = "postgres";
    source.DATABASE_CUSTOMER_API_USER = "dhumi_owner";

    expect(() => loadRuntimeConfig(source)).toThrow(ConfigurationError);
  });

  it("requires separate identity and customer API LOGIN roles", () => {
    const source = validEnvironment();
    source.DATABASE_CUSTOMER_API_USER = source.DATABASE_IDENTITY_USER;

    expect(() => loadRuntimeConfig(source)).toThrow(/DATABASE_CUSTOMER_API_USER/);
  });

  it("explains the minimum password length without exposing either password", () => {
    const source = validEnvironment();
    source.DATABASE_IDENTITY_PASSWORD = "short-one";
    source.DATABASE_CUSTOMER_API_PASSWORD = "short-two";

    expect(() => loadRuntimeConfig(source)).toThrow(
      /DATABASE_CUSTOMER_API_PASSWORD \(must contain at least 20 characters\).*DATABASE_IDENTITY_PASSWORD \(must contain at least 20 characters\)/,
    );

    try {
      loadRuntimeConfig(source);
      expect.fail("Expected configuration validation to fail");
    } catch (error) {
      expect(String(error)).not.toContain("short-one");
      expect(String(error)).not.toContain("short-two");
    }
  });

  it("requires environment-specific runtime LOGIN role names", () => {
    const source = validEnvironment();
    source.DATABASE_IDENTITY_USER = "some_login";
    source.DATABASE_CUSTOMER_API_USER = "another_login";

    expect(() => loadRuntimeConfig(source)).toThrow(/DATABASE_/);
  });

  it("requires verified TLS in production", () => {
    const source = validEnvironment();
    source.NODE_ENV = "production";

    expect(() => loadRuntimeConfig(source)).toThrow(/DATABASE_SSL_MODE/);
  });

  it("requires FRONTEND_ORIGIN to be an exact HTTP origin", () => {
    const source = validEnvironment();
    source.FRONTEND_ORIGIN = "https://app.example.test/path";

    expect(() => loadRuntimeConfig(source)).toThrow(/FRONTEND_ORIGIN/);
  });

  it("never includes password values in a validation error", () => {
    const source = validEnvironment();
    source.DATABASE_IDENTITY_PASSWORD = "secret-value-that-must-not-appear";
    source.DATABASE_POOL_MAX = "invalid";

    try {
      loadRuntimeConfig(source);
      expect.fail("Expected configuration validation to fail");
    } catch (error) {
      expect(String(error)).not.toContain("secret-value-that-must-not-appear");
      expect(String(error)).toContain("DATABASE_POOL_MAX");
    }
  });
});

describe("loadEnvelopeJanitorConfig", () => {
  it("loads only the worker boundary and applies bounded defaults", () => {
    const config = loadEnvelopeJanitorConfig(validEnvelopeJanitorEnvironment());

    expect(config).toMatchObject({
      intervalMs: 5_000,
      batchSize: 100,
      database: {
        database: "dhumi_test",
        credential: { user: "dhumi_test_envelope_janitor_login" },
        poolMax: 2,
      },
    });
    expect(config.database).not.toHaveProperty("identity");
    expect(config.database).not.toHaveProperty("customerApi");
  });

  it("requires a separate admission LOGIN role and derives the provider environment", () => {
    const duplicate = validEnvironment();
    duplicate.DATABASE_ADMISSION_USER = duplicate.DATABASE_CUSTOMER_API_USER;
    expect(() => loadRuntimeConfig(duplicate)).toThrow(/DATABASE_ADMISSION_USER/);

    const test = validEnvironment();
    test.NODE_ENV = "test";
    expect(loadRuntimeConfig(test).providerEnvironment).toBe("test");
  });

  it("does not require web, authentication, or customer database settings", () => {
    expect(() =>
      loadEnvelopeJanitorConfig(validEnvelopeJanitorEnvironment()),
    ).not.toThrow();
  });

  it("rejects unsafe names and out-of-range polling controls", () => {
    const source = validEnvelopeJanitorEnvironment();
    source.DATABASE_ENVELOPE_JANITOR_USER = "dhumi_owner";
    source.ENVELOPE_JANITOR_BATCH_SIZE = "501";
    source.ENVELOPE_JANITOR_INTERVAL_MS = "99";

    expect(() => loadEnvelopeJanitorConfig(source)).toThrow(
      /DATABASE_ENVELOPE_JANITOR_USER.*ENVELOPE_JANITOR_BATCH_SIZE.*ENVELOPE_JANITOR_INTERVAL_MS/,
    );
  });

  it("never includes the worker password in validation errors", () => {
    const source = validEnvelopeJanitorEnvironment();
    source.DATABASE_ENVELOPE_JANITOR_PASSWORD = "secret-value-that-must-not-appear";
    source.DATABASE_POOL_MAX = "invalid";

    try {
      loadEnvelopeJanitorConfig(source);
      expect.fail("Expected configuration validation to fail");
    } catch (error) {
      expect(String(error)).not.toContain("secret-value-that-must-not-appear");
      expect(String(error)).toContain("DATABASE_POOL_MAX");
    }
  });

  it("requires verified TLS in production", () => {
    const source = validEnvelopeJanitorEnvironment();
    source.NODE_ENV = "production";

    expect(() => loadEnvelopeJanitorConfig(source)).toThrow(/DATABASE_SSL_MODE/);
  });
});

describe("loadResultRecorderConfig", () => {
  it("loads only the private result-recorder boundary", () => {
    const config = loadResultRecorderConfig(validResultRecorderEnvironment());

    expect(config).toMatchObject({
      nodeEnv: "test",
      database: {
        database: "dhumi_test",
        credential: { user: "dhumi_test_result_recorder_login" },
      },
      resultStorage: {
        driver: "azurite",
        containerName: "dhumi-test-results",
        maxBytes: 104_857_600,
      },
    });
    expect(config.database).not.toHaveProperty("customerApi");
    expect(config.database).not.toHaveProperty("identity");
  });

  it("rejects the capability role itself and production Azurite", () => {
    const capability = validResultRecorderEnvironment();
    capability.DATABASE_RESULT_RECORDER_USER = "dhumi_result_recorder";
    expect(() => loadResultRecorderConfig(capability)).toThrow(
      /DATABASE_RESULT_RECORDER_USER/,
    );

    const production = validResultRecorderEnvironment();
    production.NODE_ENV = "production";
    expect(() => loadResultRecorderConfig(production)).toThrow(/RESULT_STORAGE_DRIVER/);
  });
});

describe("signup configuration", () => {
  const validHash = "a".repeat(64);

  function catalogue(entries: Array<Record<string, string>>): string {
    return JSON.stringify(entries);
  }

  it("applies the accepted defaults when signup settings are absent", () => {
    const config = loadRuntimeConfig(validEnvironment());

    expect(config.passwordHash).toEqual({ memoryKib: 19456, timeCost: 2, parallelism: 1 });
    expect(config.signupRateLimit).toEqual({ max: 5, windowMs: 900_000 });
    expect(config.legal.documents).toEqual([]);
    expect(config.legal.requiredDocumentTypes).toEqual([]);
    expect(config.legal.disclosureVersion).toBeNull();
  });

  it("refuses to start in production while the legal catalogue is empty", () => {
    const source = validEnvironment();
    source.NODE_ENV = "production";
    source.DATABASE_SSL_MODE = "verify-full";
    source.DATABASE_SSL_CA_FILE = "C:/nonexistent/ca.pem";
    source.LEGAL_DOCUMENTS = "[]";

    expect(() => loadRuntimeConfig(source)).toThrow(/LEGAL_DOCUMENTS must list the approved/);
  });

  it("derives required document types from distinct catalogue types", () => {
    const source = validEnvironment();
    source.LEGAL_DOCUMENTS = catalogue([
      { document_type: "terms", document_version: "v2", content_hash: validHash },
      { document_type: "terms", document_version: "v1", content_hash: "b".repeat(64) },
      { document_type: "privacy", document_version: "v1", content_hash: "c".repeat(64) },
      { document_type: "acceptable_use", document_version: "v1", content_hash: "d".repeat(64) },
    ]);

    const config = loadRuntimeConfig(source);

    expect(config.legal.documents).toHaveLength(4);
    expect(config.legal.requiredDocumentTypes).toEqual(["acceptable_use", "privacy", "terms"]);
  });

  it("rejects a duplicate document type and version", () => {
    const source = validEnvironment();
    source.LEGAL_DOCUMENTS = catalogue([
      { document_type: "terms", document_version: "v1", content_hash: validHash },
      { document_type: "terms", document_version: "v1", content_hash: "e".repeat(64) },
    ]);

    expect(() => loadRuntimeConfig(source)).toThrow(/duplicate document type and version: terms@v1/);
  });

  it("rejects a content hash that is not 64 hexadecimal characters", () => {
    const source = validEnvironment();
    source.LEGAL_DOCUMENTS = catalogue([
      { document_type: "terms", document_version: "v1", content_hash: "not-a-hash" },
    ]);

    expect(() => loadRuntimeConfig(source)).toThrow(/64 hexadecimal characters/);
  });

  it("rejects malformed JSON without leaking the value", () => {
    const source = validEnvironment();
    source.LEGAL_DOCUMENTS = "{not json";

    expect(() => loadRuntimeConfig(source)).toThrow(
      "LEGAL_DOCUMENTS must be a valid JSON array",
    );
  });

  it("normalises stored content hashes to lower case", () => {
    const source = validEnvironment();
    source.LEGAL_DOCUMENTS = catalogue([
      { document_type: "terms", document_version: "v1", content_hash: "A".repeat(64) },
    ]);

    expect(loadRuntimeConfig(source).legal.documents[0]?.contentHash).toBe("a".repeat(64));
  });

  it("refuses Argon2id parameters below the accepted baseline", () => {
    const weakMemory = validEnvironment();
    weakMemory.PASSWORD_ARGON2_MEMORY_KIB = "1024";
    expect(() => loadRuntimeConfig(weakMemory)).toThrow(/PASSWORD_ARGON2_MEMORY_KIB/);

    const weakTime = validEnvironment();
    weakTime.PASSWORD_ARGON2_TIME_COST = "1";
    expect(() => loadRuntimeConfig(weakTime)).toThrow(/PASSWORD_ARGON2_TIME_COST/);
  });

  it("allows Argon2id cost to be raised above the baseline", () => {
    const source = validEnvironment();
    source.PASSWORD_ARGON2_MEMORY_KIB = "65536";
    source.PASSWORD_ARGON2_TIME_COST = "3";

    expect(loadRuntimeConfig(source).passwordHash).toEqual({
      memoryKib: 65_536,
      timeCost: 3,
      parallelism: 1,
    });
  });

  it("rejects a signup rate limit of zero", () => {
    const source = validEnvironment();
    source.SIGNUP_RATE_LIMIT_MAX = "0";

    expect(() => loadRuntimeConfig(source)).toThrow(/SIGNUP_RATE_LIMIT_MAX/);
  });
});
