import { describe, expect, it } from "vitest";
import { redisConnectionKind } from "../../src/config/redisEnvironment.js";
import { projectDeploymentEnvironment } from "../../src/deployment/environment.js";
const url = "rediss://:" + "test-key-".repeat(8) + "@redis-example-ci-01.centralindia.redis.azure.net:10000";

describe("secured capacity-lease configuration", () => {
  it("allows the tested loopback transport only outside production", () => {
    expect(redisConnectionKind("redis://127.0.0.1:6380", "test")).toBe("local");
    expect(() => redisConnectionKind("redis://localhost:6380", "production")).toThrow(/forbidden in production/);
  });
  it("accepts authenticated Azure Managed Redis with TLS", () => {
    expect(redisConnectionKind(url, "test")).toBe("azure");
    expect(redisConnectionKind(url, "production")).toBe("azure");
  });
  it.each([
    url.replace("rediss:", "redis:"), url.replace(":" + "test-key-".repeat(8) + "@", ""),
    url.replace("redis.azure.net", "example.com"), url.replace(":10000", ":6379"),
    url + "/1", url + "?rejectUnauthorized=false", url + "#fragment",
    url.replace("test-key-".repeat(8), "short"), "redis://redis.example.test:6379",
  ])("rejects unsecured or unsupported endpoints without leaking credentials", value => {
    let message = ""; try { redisConnectionKind(value); } catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/REDIS_URL/); expect(message).not.toContain("test-key");
  });
  it("gives the Redis credential only to the Job Manager", () => {
    const env = { REDIS_URL: url };
    expect(projectDeploymentEnvironment("jobs", env, {}).REDIS_URL).toBe(url);
    for (const role of ["api", "outbox", "storage"] as const) expect(projectDeploymentEnvironment(role, env, {}).REDIS_URL).toBeUndefined();
  });
});
