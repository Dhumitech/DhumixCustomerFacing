import { describe, expect, it } from "vitest";
import { loadQualificationOperatorConfig } from "../../src/config/qualificationEnvironment.js";

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_HOST: "localhost",
    DATABASE_PORT: "5432",
    DATABASE_NAME: "dhumi_test",
    DATABASE_OPERATOR_USER: "dhumi_test_operator_login",
    DATABASE_OPERATOR_PASSWORD: "a".repeat(32),
    DATABASE_POOL_MIN: "0",
    DATABASE_POOL_MAX: "2",
    DATABASE_CONNECTION_TIMEOUT_MS: "5000",
    DATABASE_IDLE_TIMEOUT_MS: "10000",
    DATABASE_STATEMENT_TIMEOUT_MS: "15000",
    DATABASE_QUERY_TIMEOUT_MS: "15000",
    DATABASE_IDLE_TRANSACTION_TIMEOUT_MS: "10000",
    DATABASE_SSL_MODE: "disable",
    RESULT_STORAGE_DRIVER: "azurite",
    RESULT_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true",
    RESULT_STORAGE_CONTAINER: "dhumi-results-test",
    RESULT_MAX_BYTES: "1000000",
    PROVIDER_SECRET_DRIVER: "environment",
    PROVIDER_REFERENCE_LOCAL_KEY: "A".repeat(43),
    BRIGHTDATA_REQUEST_TIMEOUT_MS: "30000",
    BRIGHTDATA_CONTROL_RESPONSE_MAX_BYTES: "1000000",
    BRIGHTDATA_CATALOGUE_RESPONSE_MAX_BYTES: "1000000",
    BRIGHTDATA_POLL_INTERVAL_MS: "1000",
    BRIGHTDATA_POLL_MAX_ELAPSED_MS: "10000",
    UNRELATED_PROCESS_VALUE: "allowed",
  };
}

describe("Pattern 7 qualification environment", () => {
  it("reuses the existing operator, Azurite and provider-boundary settings", () => {
    const config = loadQualificationOperatorConfig(validEnvironment());
    expect(config.providerEnvironment).toBe("test");
    expect(config.database.credential.user).toBe("dhumi_test_operator_login");
    expect(config.storage.maxBytes).toBe(1_000_000);
    expect(config.catalogueResponseMaxBytes).toBe(1_000_000);
  });

  it("defaults the catalogue ceiling to the small-control ceiling", () => {
    const environment = validEnvironment();
    delete environment.BRIGHTDATA_CATALOGUE_RESPONSE_MAX_BYTES;

    const config = loadQualificationOperatorConfig(environment);

    expect(config.catalogueResponseMaxBytes).toBe(config.controlResponseMaxBytes);
  });

  it("keeps the catalogue ceiling between the control and result boundaries", () => {
    expect(() => loadQualificationOperatorConfig({
      ...validEnvironment(),
      BRIGHTDATA_CATALOGUE_RESPONSE_MAX_BYTES: "999999",
    })).toThrow(/BRIGHTDATA_CATALOGUE_RESPONSE_MAX_BYTES/);

    expect(() => loadQualificationOperatorConfig({
      ...validEnvironment(),
      BRIGHTDATA_CATALOGUE_RESPONSE_MAX_BYTES: "1000001",
      RESULT_MAX_BYTES: "1000000",
    })).toThrow(/BRIGHTDATA_CATALOGUE_RESPONSE_MAX_BYTES/);
  });

  it("accepts an empty CA-file setting when database SSL is disabled", () => {
    const config = loadQualificationOperatorConfig({
      ...validEnvironment(),
      DATABASE_SSL_MODE: "disable",
      DATABASE_SSL_CA_FILE: "",
    });

    expect(config.database.ssl).toBe(false);
  });

  it("forbids production and a non-operator database login", () => {
    expect(() => loadQualificationOperatorConfig({
      ...validEnvironment(),
      NODE_ENV: "production",
    })).toThrow(/NODE_ENV/);
    expect(() => loadQualificationOperatorConfig({
      ...validEnvironment(),
      DATABASE_OPERATOR_USER: "postgres",
    })).toThrow(/DATABASE_OPERATOR_USER/);
  });

  it("requires the poll deadline to cover at least one interval", () => {
    expect(() => loadQualificationOperatorConfig({
      ...validEnvironment(),
      BRIGHTDATA_POLL_INTERVAL_MS: "10000",
      BRIGHTDATA_POLL_MAX_ELAPSED_MS: "1000",
    })).toThrow(/BRIGHTDATA_POLL_MAX_ELAPSED_MS/);
  });
});
