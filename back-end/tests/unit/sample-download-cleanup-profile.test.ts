import { describe, expect, it } from "vitest";
// Plain Node provisioning script: also runnable without tsx/provider configuration.
// @ts-expect-error The operator .mjs script intentionally has no generated declaration.
import { selectCleanupEnvironment } from "../../scripts/sample-download-cleanup-profile.mjs";

const fixture = `NODE_ENV=development
RUN_EXECUTOR_DRIVER=controlled
DATABASE_NAME=dhumi_dev
DATABASE_OPERATOR_USER=dhumi_dev_operator_login
DATABASE_OPERATOR_PASSWORD="private-test-operator-password"
DATABASE_ADMISSION_PASSWORD="never-pass-this"
BRIGHT_DATA_API_TOKEN="never-pass-this"
RESULT_STORAGE_DRIVER=azurite
RESULT_STORAGE_CONNECTION_STRING="UseDevelopmentStorage=true"
RESULT_STORAGE_CONTAINER=private-samples
NODE_OPTIONS="--import malicious-loader"
`;

describe("private cleanup schedule profile", () => {
  it("retains only operator/storage configuration and preserves quoted values", () => {
    const profile = selectCleanupEnvironment(fixture, "dhumi_dev");
    expect(profile.DATABASE_OPERATOR_PASSWORD).toBe("private-test-operator-password");
    expect(profile.RESULT_STORAGE_CONNECTION_STRING).toBe("UseDevelopmentStorage=true");
    expect(selectCleanupEnvironment(fixture + "\nLOG_LEVEL=silent\n", "dhumi_dev").LOG_LEVEL).toBe("info");
    expect(profile).not.toHaveProperty("BRIGHT_DATA_API_TOKEN");
    expect(profile).not.toHaveProperty("DATABASE_ADMISSION_PASSWORD");
    expect(profile).not.toHaveProperty("NODE_OPTIONS");
    expect(profile).not.toHaveProperty("RUN_EXECUTOR_DRIVER");
  });
  it.each([
    [fixture, "dhumi_test"],
    [fixture.replace("controlled", "bright_data"), "dhumi_dev"],
    [fixture.replace("development", "production"), "dhumi_dev"],
    [fixture.replace("RESULT_STORAGE_DRIVER=azurite", "RESULT_STORAGE_DRIVER=azure"), "dhumi_dev"],
  ])("fails closed for wrong database, live execution, or unsupported production composition", (source, database) => {
    expect(() => selectCleanupEnvironment(source, database)).toThrow();
  });
});
