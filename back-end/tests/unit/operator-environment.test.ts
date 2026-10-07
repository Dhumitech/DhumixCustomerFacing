import { describe, expect, it } from "vitest";
import { loadOperatorConfig } from "../../src/config/operatorEnvironment.js";

function environment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test", LOG_LEVEL: "silent",
    DATABASE_HOST: "localhost", DATABASE_PORT: "5432", DATABASE_NAME: "dhumi_test",
    DATABASE_OPERATOR_USER: "dhumi_test_operator_login", DATABASE_OPERATOR_PASSWORD: "a".repeat(32),
  };
}

describe("retained operator configuration", () => {
  it("loads the existing operator without provider or storage requirements", () => {
    const config = loadOperatorConfig(environment());
    expect(config.database.credential.user).toBe("dhumi_test_operator_login");
    expect(config.database.ssl).toBe(false);
    expect(config).not.toHaveProperty("providerEnvironment");
    expect(config).not.toHaveProperty("storage");
  });

  it.each([
    { NODE_ENV: "production" }, { DATABASE_OPERATOR_USER: "postgres" },
    { DATABASE_OPERATOR_PASSWORD: "short" }, { DATABASE_POOL_MIN: "3", DATABASE_POOL_MAX: "2" },
    { DATABASE_SSL_MODE: "verify-full" },
  ])("rejects unsafe operator settings %j", (invalid) => {
    expect(() => loadOperatorConfig({ ...environment(), ...invalid })).toThrow();
  });
});
