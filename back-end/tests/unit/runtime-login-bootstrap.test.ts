import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const bootstrapPath = fileURLToPath(
  new URL("../../scripts/bootstrap/0004_runtime_login_roles.sql", import.meta.url),
);

function readBootstrap(): string {
  return readFileSync(bootstrapPath, "utf8");
}

describe("runtime LOGIN-role bootstrap", () => {
  it("uses PostgreSQL's supported hidden password command for both roles", () => {
    const source = readBootstrap();

    expect(source).toContain("\\password :identity_login_role");
    expect(source).toContain("\\password :customer_api_login_role");
    expect(source).not.toContain("\\prompt -s");
    expect(source).not.toContain("identity_login_password");
    expect(source).not.toContain("customer_api_login_password");
    expect(source).not.toMatch(/PASSWORD\s+%L/i);
  });

  it("validates and creates both roles before assigning their passwords", () => {
    const source = readBootstrap();
    const preflight = source.indexOf("DO $preflight$");
    const createIdentity = source.indexOf("CREATE ROLE %I LOGIN NOINHERIT");
    const createCustomer = source.indexOf(
      "CREATE ROLE %I LOGIN NOINHERIT",
      createIdentity + 1,
    );
    const passwordIdentity = source.indexOf("\\password :identity_login_role");
    const passwordCustomer = source.indexOf("\\password :customer_api_login_role");
    const grantIdentity = source.indexOf("GRANT dhumi_identity");
    const commit = source.indexOf("COMMIT;");

    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(createIdentity).toBeGreaterThan(preflight);
    expect(createCustomer).toBeGreaterThan(createIdentity);
    expect(passwordIdentity).toBeGreaterThan(createCustomer);
    expect(passwordCustomer).toBeGreaterThan(passwordIdentity);
    expect(grantIdentity).toBeGreaterThan(passwordCustomer);
    expect(commit).toBeGreaterThan(grantIdentity);
  });
});
