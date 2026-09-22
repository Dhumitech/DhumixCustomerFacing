import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const bootstrapPath = fileURLToPath(
  new URL("../../scripts/bootstrap/0008_result_recorder_runtime_role.sql", import.meta.url),
);

describe("result-recorder LOGIN-role bootstrap", () => {
  it("creates one NOINHERIT LOGIN and uses hidden password input", () => {
    const source = readFileSync(bootstrapPath, "utf8");

    expect(source).toContain("CREATE ROLE %I LOGIN NOINHERIT");
    expect(source).toContain("\\password :result_recorder_login_role");
    expect(source).toContain("GRANT dhumi_result_recorder");
    expect(source).not.toMatch(/PASSWORD\s+%L/i);
    expect(source).not.toContain("result_recorder_login_password");
  });
});
