import { describe, expect, it } from "vitest";
import { loadMarketplaceSampleConfig } from "../../src/config/marketplaceSampleEnvironment.js";

function environment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test", LOG_LEVEL: "silent",
    DATABASE_HOST: "localhost", DATABASE_PORT: "5432", DATABASE_NAME: "dhumi_test",
    DATABASE_OPERATOR_USER: "dhumi_test_operator_login", DATABASE_OPERATOR_PASSWORD: "a".repeat(32),
    RESULT_STORAGE_DRIVER: "azurite", RESULT_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true",
    RESULT_STORAGE_CONTAINER: "dhumi-results-test", RESULT_MAX_BYTES: "1000000",
  };
}

describe("retained Marketplace fixture configuration", () => {
  it("works without a provider secret, reference key or provider polling settings", () => {
    const config = loadMarketplaceSampleConfig(environment());
    expect(config.database.credential.user).toBe("dhumi_test_operator_login");
    expect(config.storage.maxBytes).toBe(1_000_000);
    expect(config).not.toHaveProperty("providerReferenceLocalKey");
    expect(config).not.toHaveProperty("requestTimeoutMs");
  });

  it.each([
    { RESULT_STORAGE_DRIVER: "public" }, { RESULT_STORAGE_CONNECTION_STRING: "" },
    { RESULT_STORAGE_CONTAINER: "Invalid_Container" }, { RESULT_MAX_BYTES: "0" },
    { RESULT_MAX_BYTES: "1.5" }, { DATABASE_SSL_MODE: "verify-full" },
  ])("keeps storage and database validation %j", (invalid) => {
    expect(() => loadMarketplaceSampleConfig({ ...environment(), ...invalid })).toThrow();
  });
});
