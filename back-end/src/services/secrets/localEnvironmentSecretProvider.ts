import type { SecretProvider } from "./secretProvider.js";

const SECRET_REFERENCE_PATTERN = /^[A-Z][A-Z0-9_]{2,127}$/;

export class SecretUnavailableError extends Error {
  public constructor() {
    super("Requested secret is unavailable");
    this.name = "SecretUnavailableError";
  }
}

export function createLocalEnvironmentSecretProvider(
  nodeEnv: "development" | "test" | "production",
  source: Readonly<Record<string, string | undefined>> = process.env,
): SecretProvider {
  if (nodeEnv === "production") {
    throw new Error("Environment-backed secret resolution is forbidden in production");
  }

  return {
    async getSecret(secretReference): Promise<string> {
      if (!SECRET_REFERENCE_PATTERN.test(secretReference)) {
        throw new SecretUnavailableError();
      }
      const value = source[secretReference];
      if (value === undefined || value.trim() === "") {
        throw new SecretUnavailableError();
      }
      return value;
    },
  };
}
