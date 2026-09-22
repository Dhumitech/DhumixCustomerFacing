import { describe, expect, it } from "vitest";
import {
  createLocalEnvironmentSecretProvider,
  SecretUnavailableError,
} from "../../src/services/secrets/localEnvironmentSecretProvider.js";

describe("LocalEnvironmentSecretProvider", () => {
  it("resolves only an explicitly named development secret", async () => {
    const provider = createLocalEnvironmentSecretProvider("development", {
      BRIGHTDATA_API_KEY: "private-development-value",
    });

    await expect(provider.getSecret("BRIGHTDATA_API_KEY")).resolves.toBe(
      "private-development-value",
    );
  });

  it("fails closed for missing or malformed references", async () => {
    const provider = createLocalEnvironmentSecretProvider("test", {});

    await expect(provider.getSecret("BRIGHTDATA_API_KEY")).rejects.toBeInstanceOf(
      SecretUnavailableError,
    );
    await expect(provider.getSecret("../secret")).rejects.toBeInstanceOf(
      SecretUnavailableError,
    );
  });

  it("cannot be constructed in production", () => {
    expect(() =>
      createLocalEnvironmentSecretProvider("production", {
        BRIGHTDATA_API_KEY: "must-not-be-read",
      }),
    ).toThrow(/forbidden in production/);
  });
});
