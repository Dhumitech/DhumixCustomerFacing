import { describe, expect, it } from "vitest";
import { loadOperationReleaseConfig } from "../../src/config/releaseEnvironment.js";

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
  };
}

describe("Backend Release Closure environment", () => {
  it("loads only the existing operator database identity", () => {
    const config = loadOperationReleaseConfig(validEnvironment());
    expect(config.providerEnvironment).toBe("test");
    expect(config.database.credential.user).toBe("dhumi_test_operator_login");
    expect(config).not.toHaveProperty("brightData");
    expect(config).not.toHaveProperty("storage");
  });

  it("rejects production and a non-operator login", () => {
    expect(() => loadOperationReleaseConfig({
      ...validEnvironment(),
      NODE_ENV: "production",
    })).toThrow(/NODE_ENV/);
    expect(() => loadOperationReleaseConfig({
      ...validEnvironment(),
      DATABASE_OPERATOR_USER: "postgres",
    })).toThrow(/DATABASE_OPERATOR_USER/);
  });
});
